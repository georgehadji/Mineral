/**
 * Integration test. Needs a PostgreSQL database with the migrations and seed
 * 001 applied, addressed by DATABASE_URL. Skipped without one, so the default
 * `pnpm test` stays hermetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CalcResponseSchema, type CalcResponse } from '@mineral/schemas';
import { createPool, type Pool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { ingestDocument, ingestXbrlFacts } from './ingest-repository.ts';
import { recordCalculation } from './calc-repository.ts';

const url = process.env.DATABASE_URL;
/** A far-future period, so test facts can never collide with ingested ones. */
const PERIOD_START = '2099-01-01';
const PERIOD_END = '2099-12-31';

describe.skipIf(!url)('calculated facts', () => {
  let pool: Pool;
  let companyId: string;
  let inputVersions: Record<string, string>;
  const run = randomUUID().slice(0, 8);
  const accession = `9999999999-99-${run.slice(0, 6)}`;
  /** Tags every row this file writes, so cleanup can be exact. */
  const engineVersion = `0.0.0-test-${run}`;
  const documentIds: string[] = [];

  const response = (overrides: Partial<CalcResponse> = {}): CalcResponse =>
    CalcResponseSchema.parse({
      method: 'ratios',
      engine: 'ratios',
      engine_version: engineVersion,
      currency: 'USD',
      inputs: {
        revenue: 253_400_000,
        cost_of_revenue: 152_000_000,
        total_debt: 680_000_000,
        cash_and_equivalents: 900_000_000,
      },
      outputs: [
        {
          code: 'gross_margin',
          name: 'Gross margin',
          // More decimals than numeric(38,12) holds, which is what a real
          // ratio looks like and what re-running has to treat as unchanged.
          value: 0.40015785319652725,
          unit: 'ratio',
          inputs: ['revenue', 'cost_of_revenue'],
        },
        {
          code: 'net_debt',
          name: 'Net debt',
          value: -220_000_000,
          unit: 'USD',
          inputs: ['total_debt', 'cash_and_equivalents'],
        },
      ],
      detail: {},
      ...overrides,
    });

  beforeAll(async () => {
    pool = createPool(url);
    const outcome = await resolveCompany(pool, 'MP');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is not applied');
    companyId = outcome.company.companyId;

    // The inputs arrive the way they do in production: an XBRL reading of a
    // stored filing, promoted VERIFIED before anything is computed from it.
    const filing = await ingestDocument(pool, {
      externalId: accession,
      canonicalUrl: `https://www.sec.gov/Archives/edgar/data/1801368/${run}/test.htm`,
      documentType: '10-K',
      title: `calc test ${run}`,
      publishedAt: '2100-02-20',
      content: 'Item 1. Business',
      mimeType: 'text/html',
      subjectEntityId: companyId,
    });
    documentIds.push(filing.documentId);
    await ingestXbrlFacts(pool, {
      companyEntityId: companyId,
      fallbackDocumentVersionId: filing.documentVersionId,
      candidates: [
        {
          code: 'revenue',
          concept: 'Revenues',
          value: 253_400_000,
          unit: 'USD',
          currency: 'USD',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          accession,
          form: '10-K',
          filedAt: '2100-02-20',
        },
        {
          code: 'cost_of_revenue',
          concept: 'CostOfRevenue',
          value: 152_000_000,
          unit: 'USD',
          currency: 'USD',
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
          accession,
          form: '10-K',
          filedAt: '2100-02-20',
        },
      ],
    });

    const { rows } = await pool.query<{ code: string; id: string }>(
      `select fd.code, fv.id
         from evidence.facts f
         join evidence.fact_definitions fd on fd.id = f.fact_definition_id
         join evidence.fact_versions fv on fv.id = f.current_version_id
        where f.entity_id = $1 and f.period_end = $2::date
          and fd.code in ('revenue', 'cost_of_revenue')`,
      [companyId, PERIOD_END],
    );
    inputVersions = Object.fromEntries(rows.map((r) => [r.code, r.id]));
  });

  afterAll(async () => {
    if (!pool) return;
    const runs = await pool.query<{ id: string }>(
      `select id from valuation.calculation_runs where engine_version = $1`,
      [engineVersion],
    );
    const runIds = runs.rows.map((r) => r.id);
    await pool.query(`delete from evidence.fact_derivations where calculation_run_id = any($1::uuid[])`, [runIds]);
    await pool.query(`delete from valuation.calculation_run_inputs where calculation_run_id = any($1::uuid[])`, [runIds]);
    await pool.query(`delete from valuation.calculation_runs where id = any($1::uuid[])`, [runIds]);

    const facts = await pool.query<{ id: string }>(
      `select id from evidence.facts where entity_id = $1 and period_end = $2::date`,
      [companyId, PERIOD_END],
    );
    const factIds = facts.rows.map((r) => r.id);
    await pool.query(`update evidence.facts set current_version_id = null where id = any($1::uuid[])`, [factIds]);
    await pool.query(`delete from evidence.fact_versions where fact_id = any($1::uuid[])`, [factIds]);
    await pool.query(`delete from evidence.facts where id = any($1::uuid[])`, [factIds]);
    await pool.query(
      `delete from evidence.document_chunks where document_version_id in
         (select id from evidence.document_versions where document_id = any($1::uuid[]))`,
      [documentIds],
    );
    await pool.query(`delete from evidence.document_versions where document_id = any($1::uuid[])`, [documentIds]);
    await pool.query(`delete from evidence.document_subjects where document_id = any($1::uuid[])`, [documentIds]);
    await pool.query(`delete from evidence.documents where id = any($1::uuid[])`, [documentIds]);
    await pool.end();
  });

  const record = (over: Partial<CalcResponse> = {}) =>
    recordCalculation(pool, {
      subjectEntityId: companyId,
      response: response(over),
      inputFactVersions: inputVersions,
      period: { periodStart: PERIOD_START, periodEnd: PERIOD_END },
    });

  it('promotes results as CALCULATED and links them to the facts they came from', async () => {
    const result = await record();
    expect(result).toMatchObject({
      promoted: 2,
      unchanged: 0,
      superseded: 0,
      derivations: 2,
      epistemicStatus: 'CALCULATED',
    });

    const { rows } = await pool.query(
      `select fd.code, fv.status, fv.extraction_method, fv.unit, fv.currency,
              fv.source_document_version_id, f.current_version_id, fv.id
         from evidence.facts f
         join evidence.fact_definitions fd on fd.id = f.fact_definition_id
         join evidence.fact_versions fv on fv.id = f.current_version_id
        where f.entity_id = $1 and f.period_end = $2::date
          and fd.code in ('gross_margin', 'net_debt')
        order by fd.code`,
      [companyId, PERIOD_END],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      code: 'gross_margin',
      status: 'promoted',
      extraction_method: 'calculated',
      unit: 'ratio',
      currency: null,
    });
    // A calculated value has no document of its own; its inputs carry the
    // provenance, which is what fact_derivations records.
    expect(rows[0].source_document_version_id).toBeNull();
    expect(rows[1]).toMatchObject({ code: 'net_debt', unit: 'USD', currency: 'USD' });
    // Stored at the precision of the column, not the precision of the float.
    expect((await currentVersionOf('gross_margin')).value).toBe('0.400157853197');

    const derivations = await pool.query<{ input_fact_version_id: string; calculation_run_id: string }>(
      `select input_fact_version_id, calculation_run_id
         from evidence.fact_derivations where derived_fact_version_id = $1`,
      [rows[0].id],
    );
    expect(derivations.rows.map((r) => r.input_fact_version_id).sort()).toEqual(
      [inputVersions.revenue, inputVersions.cost_of_revenue].sort(),
    );
    expect(derivations.rows.every((r) => r.calculation_run_id === result.calculationRunId)).toBe(true);
  });

  it('links only the inputs that were facts, and records the rest in the snapshot', async () => {
    const { rows } = await pool.query<{ role: string }>(
      `select role from valuation.calculation_run_inputs ci
         join valuation.calculation_runs r on r.id = ci.calculation_run_id
        where r.engine_version = $1 order by role`,
      [engineVersion],
    );
    // total_debt and cash_and_equivalents were numbers, not stored facts.
    expect(rows.map((r) => r.role)).toEqual(['cost_of_revenue', 'revenue']);

    const snapshot = await pool.query<{ input_snapshot: { inputs: Record<string, number> } }>(
      `select input_snapshot from valuation.calculation_runs where engine_version = $1 limit 1`,
      [engineVersion],
    );
    expect(Object.keys(snapshot.rows[0]!.input_snapshot.inputs).sort()).toEqual([
      'cash_and_equivalents',
      'cost_of_revenue',
      'revenue',
      'total_debt',
    ]);
  });

  it('writes no new revision when the same numbers are calculated again, rounding included', async () => {
    const result = await record();
    expect(result).toMatchObject({ promoted: 0, unchanged: 2, superseded: 0, derivations: 0 });

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from evidence.fact_versions fv
         join evidence.facts f on f.id = fv.fact_id
         join evidence.fact_definitions fd on fd.id = f.fact_definition_id
        where f.entity_id = $1 and f.period_end = $2::date and fd.code = 'gross_margin'`,
      [companyId, PERIOD_END],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('keeps every invocation, because a calculation is an event', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from valuation.calculation_runs where engine_version = $1`,
      [engineVersion],
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(1);
  });

  it('supersedes rather than overwrites when a restated input moves the result', async () => {
    const previous = await currentVersionOf('gross_margin');
    const outputs = response().outputs.map((o) =>
      o.code === 'gross_margin' ? { ...o, value: 0.395 } : o,
    );
    const result = await record({ outputs });
    expect(result).toMatchObject({ promoted: 1, unchanged: 1, superseded: 1 });

    const current = await currentVersionOf('gross_margin');
    expect(current.value).toBe('0.395000000000');
    expect(current.supersedes_version_id).toBe(previous.id);

    const { rows } = await pool.query(
      `select status, effective_to from evidence.fact_versions where id = $1`,
      [previous.id],
    );
    expect(rows[0]?.status).toBe('superseded');
    expect(rows[0]?.effective_to).not.toBeNull();
  });

  it('refuses a result that names an input the run never carried', async () => {
    const outputs = [{ ...response().outputs[0]!, inputs: ['revenue', 'ebitda'] }];
    await expect(record({ outputs })).rejects.toThrow(/ebitda/);
  });

  async function currentVersionOf(code: string) {
    const { rows } = await pool.query(
      `select fv.id, fv.numeric_value::text as value, fv.supersedes_version_id
         from evidence.facts f
         join evidence.fact_definitions fd on fd.id = f.fact_definition_id
         join evidence.fact_versions fv on fv.id = f.current_version_id
        where f.entity_id = $1 and f.period_end = $2::date and fd.code = $3`,
      [companyId, PERIOD_END, code],
    );
    const row = rows[0];
    if (!row) throw new Error(`no current version for ${code}`);
    return row;
  }
});
