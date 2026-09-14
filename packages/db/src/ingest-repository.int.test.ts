/**
 * Integration test. Needs a PostgreSQL database with the migrations and seed
 * 001 applied, addressed by DATABASE_URL. Skipped without one, so the default
 * `pnpm test` stays hermetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { ingestDocument, ingestXbrlFacts } from './ingest-repository.ts';
import type { XbrlFactCandidate } from '@mineral/ingest';

const url = process.env.DATABASE_URL;
/** Far-future periods so test facts can never collide with ingested ones. */
const AS_OF = '2099-12-31';

describe.skipIf(!url)('EDGAR ingestion', () => {
  let pool: Pool;
  let companyId: string;
  const run = randomUUID().slice(0, 8);
  const accession = `9999999999-99-${run.slice(0, 6)}`;
  const documentIds: string[] = [];

  const candidate = (over: Partial<XbrlFactCandidate> = {}): XbrlFactCandidate => ({
    code: 'total_assets',
    concept: 'Assets',
    value: 2_600_000_000,
    unit: 'USD',
    currency: 'USD',
    asOfDate: AS_OF,
    accession,
    form: '10-K',
    filedAt: '2100-02-20',
    ...over,
  });

  const storeFiling = (content: string) =>
    ingestDocument(pool, {
      externalId: accession,
      canonicalUrl: `https://www.sec.gov/Archives/edgar/data/1801368/${run}/test.htm`,
      documentType: '10-K',
      title: `ingest test ${run}`,
      publishedAt: '2100-02-20',
      content,
      mimeType: 'text/html',
      text: content,
      subjectEntityId: companyId,
      chunkTargetChars: 20,
    });

  beforeAll(async () => {
    pool = createPool(url);
    const outcome = await resolveCompany(pool, 'MP');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is not applied');
    companyId = outcome.company.companyId;
  });

  afterAll(async () => {
    if (!pool) return;
    const facts = await pool.query<{ id: string }>(
      `select id from evidence.facts where entity_id = $1 and as_of_date = $2`,
      [companyId, AS_OF],
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

  it('stores a filing as a hashed version with chunks', async () => {
    const result = await storeFiling('Item 1. Business\n\nWe mine and separate rare earths.');
    documentIds.push(result.documentId);
    expect(result.created).toBe(true);
    expect(result.versionNo).toBe(1);
    expect(result.contentHash).toHaveLength(64);
    expect(result.chunkCount).toBeGreaterThan(1);
  });

  it('re-ingesting identical bytes writes nothing', async () => {
    const first = await storeFiling('Item 1. Business\n\nWe mine and separate rare earths.');
    const again = await storeFiling('Item 1. Business\n\nWe mine and separate rare earths.');
    expect(again.created).toBe(false);
    expect(again.documentVersionId).toBe(first.documentVersionId);
    expect(again.versionNo).toBe(1);
    expect(again.chunkCount).toBe(first.chunkCount);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from evidence.document_versions where document_id = $1`,
      [first.documentId],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('adds a version for changed bytes and keeps the old one', async () => {
    const first = await storeFiling('Item 1. Business\n\nWe mine and separate rare earths.');
    const amended = await storeFiling('Item 1. Business\n\nWe mine, separate and refine rare earths.');
    expect(amended.created).toBe(true);
    expect(amended.versionNo).toBe(2);
    expect(amended.contentHash).not.toBe(first.contentHash);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from evidence.document_versions where document_id = $1`,
      [first.documentId],
    );
    expect(rows[0]?.count).toBe('2');
  });

  it('promotes XBRL numbers as VERIFIED and cites the filing they came from', async () => {
    const filing = await storeFiling('Item 1. Business\n\nWe mine, separate and refine rare earths.');
    const companyFacts = await ingestDocument(pool, {
      externalId: `companyfacts-${run}`,
      canonicalUrl: `https://data.sec.gov/api/xbrl/companyfacts/CIK-test-${run}.json`,
      documentType: 'xbrl_company_facts',
      title: `ingest test company facts ${run}`,
      content: '{"facts":{}}',
      mimeType: 'application/json',
      chunk: false,
      subjectEntityId: companyId,
    });
    documentIds.push(companyFacts.documentId);

    const result = await ingestXbrlFacts(pool, {
      companyEntityId: companyId,
      candidates: [candidate()],
      fallbackDocumentVersionId: companyFacts.documentVersionId,
    });
    expect(result).toMatchObject({ promoted: 1, unchanged: 0, superseded: 0, epistemicStatus: 'VERIFIED' });

    const { rows } = await pool.query(
      `select fv.id, fv.status, fv.extraction_method, fv.numeric_value::text as value,
              fv.source_document_version_id, fv.promoted_by, f.current_version_id
         from evidence.facts f
         join evidence.fact_versions fv on fv.fact_id = f.id
        where f.entity_id = $1 and f.as_of_date = $2`,
      [companyId, AS_OF],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'promoted',
      extraction_method: 'xbrl',
      value: '2600000000.000000000000',
      promoted_by: 'system',
    });
    // Provenance is the filing itself, not the companyfacts blob it was read from.
    expect(rows[0].source_document_version_id).toBe(filing.documentVersionId);
    expect(rows[0].current_version_id).toBe(rows[0].id);
  });

  it('writes nothing when the same numbers are ingested again', async () => {
    const result = await ingestXbrlFacts(pool, {
      companyEntityId: companyId,
      candidates: [candidate()],
      fallbackDocumentVersionId: (await currentVersionRow()).source_document_version_id,
    });
    expect(result).toMatchObject({ promoted: 0, unchanged: 1, superseded: 0 });

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text from evidence.fact_versions fv
         join evidence.facts f on f.id = fv.fact_id
        where f.entity_id = $1 and f.as_of_date = $2`,
      [companyId, AS_OF],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('supersedes rather than overwrites when a filing restates the number', async () => {
    const previous = await currentVersionRow();
    const result = await ingestXbrlFacts(pool, {
      companyEntityId: companyId,
      candidates: [candidate({ value: 2_550_000_000, filedAt: '2100-05-08' })],
      fallbackDocumentVersionId: previous.source_document_version_id,
    });
    expect(result).toMatchObject({ promoted: 1, unchanged: 0, superseded: 1 });

    const current = await currentVersionRow();
    expect(current.value).toBe('2550000000.000000000000');
    expect(current.supersedes_version_id).toBe(previous.id);

    const { rows } = await pool.query(
      `select status, effective_to from evidence.fact_versions where id = $1`,
      [previous.id],
    );
    expect(rows[0]?.status).toBe('superseded');
    expect(rows[0]?.effective_to).not.toBeNull();
  });

  async function currentVersionRow() {
    const { rows } = await pool.query(
      `select fv.id, fv.numeric_value::text as value, fv.source_document_version_id,
              fv.supersedes_version_id
         from evidence.facts f
         join evidence.fact_versions fv on fv.id = f.current_version_id
        where f.entity_id = $1 and f.as_of_date = $2`,
      [companyId, AS_OF],
    );
    const row = rows[0];
    if (!row) throw new Error('no current fact version');
    return row;
  }
});
