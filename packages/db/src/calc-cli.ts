// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { recordCalculation } from './calc-repository.ts';
import { CalcResponseSchema } from '@mineral/schemas';

/**
 * One company, one method, end to end: read its promoted facts, hand them to
 * the analytics service, store what comes back as CALCULATED facts that point
 * at the revisions they were computed from. Run it twice; the second run must
 * write no new revisions.
 *
 *   pnpm calc "MP" ratios --period-end 2024-12-31 --period-start 2024-01-01
 */
const args = process.argv.slice(2);
const query = args[0];
const method = args[1] && !args[1].startsWith('--') ? args[1] : 'ratios';
if (!query || query.startsWith('--')) {
  console.error('usage: pnpm calc "<company>" [method] --period-end 2024-12-31 [--period-start 2024-01-01]');
  process.exit(2);
}

const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
const periodEnd = flag('period-end');
const periodStart = flag('period-start');
const baseUrl = flag('url') ?? process.env.ANALYTICS_URL ?? 'http://127.0.0.1:8000';
if (!periodEnd) {
  console.error('--period-end is required: facts from different periods must not be mixed');
  process.exit(2);
}

interface FactRow {
  code: string;
  fact_version_id: string;
  /** float8, not numeric: the value crosses JSON to the engine as a double
   *  either way, so the cast happens once, here, where it is visible. */
  value: number;
  currency: string | null;
  period_start: string | null;
  period_end: string | null;
  as_of_date: string | null;
}

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

const pool = createPool();
try {
  const outcome = await resolveCompany(pool, query);
  if (outcome.status !== 'resolved') fail(`${query}: ${outcome.status}`);
  const company = (outcome as Extract<typeof outcome, { status: 'resolved' }>).company;

  const spec = await fetchMethod(baseUrl, method);
  const accepted = new Set([...spec.required, ...spec.optional]);

  const { rows } = await pool.query<FactRow>(
    `select fd.code, fv.id as fact_version_id, fv.numeric_value::float8 as value, fv.currency,
            f.period_start::text, f.period_end::text, f.as_of_date::text
       from evidence.facts f
       join evidence.fact_definitions fd on fd.id = f.fact_definition_id
       join evidence.fact_versions fv on fv.id = f.current_version_id
      where f.entity_id = $1
        and fv.numeric_value is not null
        and (f.period_end = $2::date or f.as_of_date = $2::date)
        and ($3::date is null or f.period_start is null or f.period_start = $3::date)`,
    [company.companyId, periodEnd, periodStart ?? null],
  );

  const usable = rows.filter((row) => accepted.has(row.code));
  const duplicates = usable.filter((row, i) => usable.findIndex((r) => r.code === row.code) !== i);
  if (duplicates.length > 0) {
    const detail = [...new Set(duplicates.map((d) => d.code))]
      .map((code) => {
        const spans = usable
          .filter((r) => r.code === code)
          .map((r) => `${r.period_start ?? 'instant'}..${periodEnd}`);
        return `${code} (${spans.join(', ')})`;
      })
      .join('; ');
    fail(`several facts share a code at ${periodEnd}: ${detail}. Narrow it with --period-start`);
  }

  const missing = spec.required.filter((code) => !usable.some((row) => row.code === code));
  if (missing.length > 0) fail(`${method} needs ${missing.join(', ')}, which ${company.legalName} has no fact for`);
  if (usable.length === 0) fail(`no facts for ${company.legalName} at ${periodEnd}`);

  const currencies = [...new Set(usable.map((row) => row.currency).filter(Boolean))] as string[];
  if (currencies.length > 1) fail(`inputs mix currencies (${currencies.join(', ')}); no conversion happens here`);
  const currency = currencies[0] ?? 'USD';

  const inputs = Object.fromEntries(usable.map((row) => [row.code, row.value]));
  const response = CalcResponseSchema.parse(await postCalc(baseUrl, method, inputs, currency));

  const result = await recordCalculation(pool, {
    subjectEntityId: company.companyId,
    response,
    inputFactVersions: Object.fromEntries(usable.map((row) => [row.code, row.fact_version_id])),
    period: periodOf(usable),
  });

  console.log(`${company.legalName}  ${method}  ${response.engine} ${response.engine_version}`);
  for (const output of response.outputs) {
    console.log(`  ${output.code.padEnd(24)} ${output.value}  ${output.unit}`);
  }
  console.log(
    `  run ${result.calculationRunId}: ${result.promoted} promoted ${result.epistemicStatus}, ` +
      `${result.unchanged} unchanged, ${result.superseded} superseded, ${result.derivations} derivations`,
  );
} finally {
  await pool.end();
}

/** The period the derived facts belong to: the span of the durations used and
 *  the instant of the balances used, both refused if the inputs disagree. */
function periodOf(rows: readonly FactRow[]) {
  const spans = [...new Set(rows.filter((r) => r.period_end).map((r) => `${r.period_start ?? ''}|${r.period_end}`))];
  const instants = [...new Set(rows.filter((r) => r.as_of_date).map((r) => r.as_of_date as string))];
  if (spans.length > 1) fail(`inputs cover several periods: ${spans.join(', ')}`);
  if (instants.length > 1) fail(`inputs are measured at several dates: ${instants.join(', ')}`);
  const [start, end] = spans[0]?.split('|') ?? [];
  return {
    periodStart: start || null,
    periodEnd: end || null,
    asOfDate: instants[0] ?? null,
  };
}

async function fetchMethod(base: string, name: string) {
  const response = await fetch(`${base}/methods`).catch((error: Error) => {
    fail(`the analytics service at ${base} is not answering (${error.message}); start it with pnpm analytics`);
    throw error;
  });
  if (!response.ok) fail(`${base}/methods returned ${response.status}`);
  const methods = (await response.json()) as Record<string, { required: string[]; optional: string[] }>;
  const spec = methods[name];
  if (!spec) fail(`unknown method ${name}; the engine offers ${Object.keys(methods).join(', ')}`);
  return spec as { required: string[]; optional: string[] };
}

async function postCalc(base: string, name: string, inputs: Record<string, number>, currency: string) {
  const response = await fetch(`${base}/calc/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, currency }),
  });
  const body = await response.json();
  if (!response.ok) fail(`${name} failed: ${JSON.stringify((body as { detail?: unknown }).detail ?? body)}`);
  return body;
}
