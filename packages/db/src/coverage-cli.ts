// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { XBRL_CONCEPTS } from '@mineral/ingest';
import { createPool } from './client.ts';

/**
 * Which mapped figures a filer has stopped reporting under the concepts we
 * read, and what it reports them under now. Read-only, and offline: it works
 * from the companyfacts already stored by pnpm ingest.
 *
 *   pnpm coverage
 *
 * Filers move a figure to another concept without notice -- Ramaco's capex
 * went from PaymentsToAcquirePropertyPlantAndEquipment to
 * PaymentsForCapitalImprovements in 2024 -- and the old series just ends. A
 * figure is flagged when the latest filing that should carry it does not: the
 * latest filing of any kind (10-K, 10-Q, 20-F, 6-K) for one ever reported in an
 * interim, the latest annual report for one reported only annually. The suggestions are concepts in that filing that
 * carry the same value for the same period somewhere in the history, which is
 * what a filer restating last year's comparative under the new name leaves.
 */

interface Entry {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  form?: string;
  filed?: string;
}
type Concepts = Record<string, { units?: Record<string, Entry[]> }>;

const ANNUAL = ['10-K', '20-F'];
const ALL = [...ANNUAL, '10-Q', '6-K'];
const FORMS = new Set(ALL);

const pool = createPool();
try {
  const { rows } = await pool.query<{ name: string; body: string }>(
    `select distinct on (c.id) coalesce(c.common_name, c.legal_name) as name, dv.raw_text as body
       from core.companies c
       join evidence.document_subjects ds on ds.entity_id = c.id
       join evidence.documents d on d.id = ds.document_id and d.external_id like 'companyfacts-CIK%'
       join evidence.document_versions dv on dv.document_id = d.id
      order by c.id, dv.version_no desc`,
  );
  const codes = [...new Set(XBRL_CONCEPTS.map((concept) => concept.code))];
  let flagged = 0;

  for (const { name, body } of rows.sort((a, b) => a.name.localeCompare(b.name))) {
    // A filer reports in one taxonomy; us-gaap wins the rare shared name.
    const taxonomies = (JSON.parse(body) as { facts?: Record<string, Concepts> }).facts ?? {};
    const gaap: Concepts = { ...taxonomies['ifrs-full'], ...taxonomies['us-gaap'] };
    const entriesOf = (concept: string) =>
      Object.values(gaap[concept]?.units ?? {})
        .flat()
        .filter((entry) => entry.accn && entry.form && FORMS.has(entry.form));
    const all = Object.keys(gaap).flatMap(entriesOf);
    const latest = (forms: string[]) =>
      all.filter((e) => forms.includes(e.form!)).sort((a, b) => b.filed!.localeCompare(a.filed!))[0];
    if (!latest(ALL)) {
      console.log(`${name}: no ${ALL.join(', ')} in its companyfacts`);
      continue;
    }

    const lines: string[] = [];
    const never: string[] = [];
    for (const code of codes) {
      const mapped = XBRL_CONCEPTS.filter((c) => c.code === code).map((c) => c.concept);
      const entries = mapped.flatMap(entriesOf);
      if (entries.length === 0) {
        never.push(code);
        continue;
      }
      const interim = entries.some((e) => !ANNUAL.includes(e.form!));
      const expected = latest(interim ? ALL : ANNUAL)!;
      if (entries.some((e) => e.accn === expected.accn)) continue;

      const lastEnd = entries.map((e) => e.end!).sort().at(-1);
      const seen = new Set(entries.map((e) => `${e.start ?? ''}|${e.end}|${e.val}`));
      const candidates = Object.keys(gaap).filter(
        (concept) =>
          !mapped.includes(concept) &&
          entriesOf(concept).some((e) => e.accn === expected.accn) &&
          entriesOf(concept).some((e) => seen.has(`${e.start ?? ''}|${e.end}|${e.val}`)),
      );
      lines.push(
        `  ${code.padEnd(24)} last ${lastEnd}, absent from ${expected.form} ${expected.accn} (filed ${expected.filed})` +
          (candidates.length ? `\n    now under: ${candidates.join(', ')}` : '\n    no concept in that filing matches its history'),
      );
    }
    if (lines.length === 0 && never.length === 0) continue;
    console.log(name);
    for (const line of lines) console.log(line);
    if (never.length) console.log(`  never reported: ${never.join(', ')}`);
    flagged += lines.length;
  }
  console.log(`\n${rows.length} filers, ${flagged} figures that stopped`);
} finally {
  await pool.end();
}
