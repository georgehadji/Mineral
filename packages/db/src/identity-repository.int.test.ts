/**
 * Integration test. Needs a PostgreSQL database with the v1.1 migration and
 * seed 001 applied, addressed by DATABASE_URL. Skipped without one, so the
 * default `pnpm test` stays hermetic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('resolveCompany against seeded issuers', () => {
  // Built in beforeAll, not in the describe body: the body is evaluated even
  // when the suite is skipped, and connecting there would break hermetic runs.
  let pool: Pool;
  beforeAll(() => {
    pool = createPool(url);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('resolves the ticker MP to MP Materials', async () => {
    const outcome = await resolveCompany(pool, 'MP');
    expect(outcome.status).toBe('resolved');
    if (outcome.status !== 'resolved') return;
    expect(outcome.company.legalName).toBe('MP Materials Corp. / DE');
    expect(outcome.company.method).toBe('ticker');
  });

  it('resolves the same company by its SEC CIK, padded or not', async () => {
    const padded = await resolveCompany(pool, '0001801368');
    const bare = await resolveCompany(pool, '1801368');
    expect(padded.status).toBe('resolved');
    expect(bare.status).toBe('resolved');
    if (padded.status !== 'resolved' || bare.status !== 'resolved') return;
    expect(bare.company.companyId).toBe(padded.company.companyId);
    expect(bare.company.method).toBe('cik');
    expect(bare.company.matchedValue).toBe('0001801368');
  });

  it('reaches the same company by ticker and by CIK', async () => {
    const byTicker = await resolveCompany(pool, 'NYSE:MP');
    const byCik = await resolveCompany(pool, 'CIK-1801368');
    if (byTicker.status !== 'resolved' || byCik.status !== 'resolved') throw new Error('unresolved');
    expect(byTicker.company.companyId).toBe(byCik.company.companyId);
  });

  it('resolves a former name through the alias table', async () => {
    const outcome = await resolveCompany(pool, 'Molycorp');
    expect(outcome.status).toBe('resolved');
    if (outcome.status !== 'resolved') return;
    expect(outcome.company.legalName).toBe('MP Materials Corp. / DE');
    expect(outcome.company.method).toBe('alias');
  });

  it('resolves a non-US issuer that has no CIK', async () => {
    const outcome = await resolveCompany(pool, 'ASX:LYC');
    expect(outcome.status).toBe('resolved');
    if (outcome.status !== 'resolved') return;
    expect(outcome.company.legalName).toBe('Lynas Rare Earths Limited');
  });

  it('does not match a ticker on the wrong exchange', async () => {
    expect((await resolveCompany(pool, 'NYSE:LYC')).status).toBe('not_found');
  });

  it('reports ambiguity instead of guessing', async () => {
    const outcome = await resolveCompany(pool, 'U');
    expect(outcome.status).not.toBe('resolved');
  });

  it('returns not_found for an unknown issuer', async () => {
    expect((await resolveCompany(pool, 'Nonexistent Mining PLC')).status).toBe('not_found');
  });

  it('never resolves a name query through a CIK match', async () => {
    const outcome = await resolveCompany(pool, 'Energy Fuels');
    if (outcome.status !== 'resolved') throw new Error('unresolved');
    expect(outcome.company.method).toBe('alias');
    expect(outcome.company.legalName).toBe('ENERGY FUELS INC');
  });
});
