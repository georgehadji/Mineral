import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import { inTransaction } from './client.ts';
import { factEpistemicStatus, type CalcResponse, type EpistemicStatus } from '@mineral/schemas';
import {
  currentFactVersion,
  ensureFactDefinitions,
  upsertFact,
  type FactPeriod,
} from './facts.ts';

/**
 * Calculation writes. A `CALCULATED` fact is only worth storing if it carries
 * the run that produced it and the revisions it was computed from: that chain
 * is what lets a reader click a ratio and reach the filing underneath it.
 *
 * Idempotence works the same way it does for ingestion. A value that already
 * matches the current revision writes no revision, and a changed one supersedes
 * rather than overwrites. The run row itself is written every time: a
 * calculation is an event, not a registry entry, and re-running with different
 * assumptions has to leave both attempts readable.
 */

export interface RecordCalculationInput {
  subjectEntityId: UUID;
  /** Parsed response of `POST /calc/{method}`. */
  response: CalcResponse;
  /**
   * The promoted fact revision that supplied each input code. Codes with no
   * entry -- assumptions, market data -- still reach the input snapshot, but
   * cannot be linked as derivation inputs, because they are not facts yet.
   */
  inputFactVersions?: Readonly<Record<string, UUID>>;
  /** Slice of time the derived facts belong to. */
  period?: FactPeriod;
  researchRunId?: UUID | null;
  scenarioId?: UUID | null;
}

export interface RecordCalculationResult {
  calculationRunId: UUID;
  /** New revisions written and promoted. */
  promoted: number;
  /** Values already current, so nothing was written. */
  unchanged: number;
  /** Previously current revisions displaced by a changed result. */
  superseded: number;
  /** Derivation edges written, derived revision to input revision. */
  derivations: number;
  /** What the promoted revisions are entitled to be called. */
  epistemicStatus: EpistemicStatus;
}

export async function recordCalculation(
  pool: Pool,
  input: RecordCalculationInput,
): Promise<RecordCalculationResult> {
  const { response } = input;
  // An output may be computed from another output of the same run (earnings
  // per share, then the price to earnings that uses it), so both count as
  // known input codes.
  const known = new Set([...Object.keys(response.inputs), ...response.outputs.map((o) => o.code)]);
  for (const output of response.outputs) {
    const unknown = output.inputs.filter((code) => !known.has(code));
    if (unknown.length > 0) {
      throw new Error(`${output.code} names inputs the run did not carry: ${unknown.join(', ')}`);
    }
  }

  return inTransaction(pool, async (client) => {
    const calculationRunId = await insertRun(client, input);
    await linkRunInputs(client, calculationRunId, input);

    const definitionIds = await ensureFactDefinitions(
      client,
      response.outputs.map((output) => ({
        code: output.code,
        name: output.name,
        valueType: 'numeric' as const,
        canonicalUnit: output.unit,
        description: `Computed by the ${response.engine} engine, method ${response.method}`,
      })),
    );

    // Revisions produced by this run, so a later output can derive from an
    // earlier one. Methods that do this have to emit the input first.
    const sources = new Map<string, UUID>(Object.entries(input.inputFactVersions ?? {}));
    let promoted = 0;
    let unchanged = 0;
    let superseded = 0;
    let derivations = 0;

    for (const output of response.outputs) {
      const definitionId = definitionIds.get(output.code);
      if (!definitionId) throw new Error(`no fact definition for code ${output.code}`);

      const factId = await upsertFact(client, input.subjectEntityId, definitionId, input.period ?? {});
      const current = await currentFactVersion(client, factId, output.value);
      let versionId: UUID;

      if (current?.same) {
        unchanged += 1;
        versionId = current.id;
      } else {
        const { rows } = await client.query<{ id: string }>(
          `insert into evidence.fact_versions
             (fact_id, numeric_value, unit, currency, observed_at, extraction_method)
           values ($1, $2::numeric, $3, $4, now(), 'calculated')
           returning id`,
          [
            factId,
            String(output.value),
            output.unit,
            output.unit === response.currency ? response.currency : null,
          ],
        );
        const written = rows[0]?.id;
        if (!written) throw new Error(`could not write a revision for fact ${factId}`);
        versionId = written;
        await client.query(`select evidence.promote_fact_version($1, 'system')`, [versionId]);
        promoted += 1;
        if (current) superseded += 1;
      }

      derivations += await linkDerivation(client, versionId, output.inputs, sources, calculationRunId);
      sources.set(output.code, versionId);
    }

    return {
      calculationRunId,
      promoted,
      unchanged,
      superseded,
      derivations,
      epistemicStatus: factEpistemicStatus({ extractionMethod: 'calculated', status: 'promoted' }),
    };
  });
}

async function insertRun(client: PoolClient, input: RecordCalculationInput): Promise<UUID> {
  const { response } = input;
  const { rows } = await client.query<{ id: string }>(
    `insert into valuation.calculation_runs
       (subject_type, subject_id, research_run_id, scenario_id,
        method, engine, engine_version, input_snapshot, output)
     values ('company', $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)
     returning id`,
    [
      input.subjectEntityId,
      input.researchRunId ?? null,
      input.scenarioId ?? null,
      response.method,
      response.engine,
      response.engine_version,
      JSON.stringify({ currency: response.currency, inputs: response.inputs }),
      JSON.stringify({ outputs: response.outputs, detail: response.detail }),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('could not record the calculation run');
  return id;
}

/** Queryable lineage: which revisions fed the run, whatever it produced. */
async function linkRunInputs(
  client: PoolClient,
  calculationRunId: UUID,
  input: RecordCalculationInput,
): Promise<void> {
  for (const [code, factVersionId] of Object.entries(input.inputFactVersions ?? {})) {
    if (!(code in input.response.inputs)) continue;
    await client.query(
      `insert into valuation.calculation_run_inputs (calculation_run_id, fact_version_id, role)
       values ($1, $2, $3) on conflict do nothing`,
      [calculationRunId, factVersionId, code],
    );
  }
}

async function linkDerivation(
  client: PoolClient,
  derivedVersionId: UUID,
  inputCodes: readonly string[],
  sources: ReadonlyMap<string, UUID>,
  calculationRunId: UUID,
): Promise<number> {
  const inputVersionIds = [
    ...new Set(inputCodes.map((code) => sources.get(code)).filter((id): id is UUID => Boolean(id))),
  ].filter((id) => id !== derivedVersionId);
  if (inputVersionIds.length === 0) return 0;

  const { rowCount } = await client.query(
    `insert into evidence.fact_derivations
       (derived_fact_version_id, input_fact_version_id, calculation_run_id)
     select $1, input_id, $3 from unnest($2::uuid[]) as input_id
     on conflict do nothing`,
    [derivedVersionId, inputVersionIds, calculationRunId],
  );
  return rowCount ?? 0;
}
