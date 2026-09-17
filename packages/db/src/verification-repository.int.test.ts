/**
 * Integration test. Needs a PostgreSQL database with the migrations and the
 * issuer seed applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.7 gate: a planted bad citation is rejected. The claim is
 * inserted directly, bypassing the module runtime, because the point of a
 * separate verification pass is to catch a row the write path never saw.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@mineral/ai';
import { CORE_RECIPE } from '@mineral/research';
import { createPool, type Pool } from './client.ts';
import { runResearch } from './research-repository.ts';
import { resolveCompany } from './identity-repository.ts';
import { verifyRun } from './verification-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('verification', () => {
  let pool: Pool;
  let companyId: string;
  let documentId: string;
  let chunkId: string;
  let runId: string;
  const run = randomUUID().slice(0, 8);
  const SOURCE_PREFIX = 'verify-test-source-';

  const MARKER =
    'The Company produced 45,455 metric tons of rare earth oxide in concentrate during the year.';
  const CHUNK_TEXT =
    'Mountain Pass is the only operating rare earth mine in North America. ' + MARKER;

  const honest: Transport = async (_url, init) => {
    const request = JSON.parse(init.body) as { messages: { content: string }[] };
    const prompt = request.messages.map((m) => m.content).join('\n');
    const at = prompt.indexOf(MARKER);
    if (at === -1) throw new Error('the planted chunk is not in the prompt');
    const ids = [...prompt.slice(0, at).matchAll(/\[chunk_id: ([0-9a-f-]{36})\]/g)];
    const cited = ids.at(-1)![1]!;
    return {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'record_result',
                    arguments: JSON.stringify({
                      claims: [
                        {
                          claim_key: `production_volume_${run}`,
                          claim_type: 'business_fact',
                          statement: 'The company produced 45,455 metric tons of rare earth oxide.',
                          status: 'DERIVED',
                          confidence: 0.9,
                          evidence: [
                            { chunk_id: cited, fact_version_id: null, quote: MARKER,
                              role: 'supports', strength: 0.9 },
                          ],
                        },
                      ],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
      }),
    };
  };

  /** A row that never went through the runtime, as a bad import would be. */
  async function plantClaim(statement: string, quote: string, claimKey: string): Promise<string> {
    const claim = await pool.query<{ id: string }>(
      `insert into research.claims
         (run_id, subject_type, subject_id, claim_key, claim_type, statement,
          epistemic_status, confidence, created_by)
       values ($1, 'company', $2, $3, 'business_fact', $4, 'DERIVED', 0.9, 'llm')
       returning id`,
      [runId, companyId, claimKey, statement],
    );
    const claimId = claim.rows[0]!.id;
    await pool.query(
      `insert into research.claim_evidence
         (claim_id, document_version_id, chunk_id, evidence_role, support_strength, quote_excerpt)
       select $1, dc.document_version_id, dc.id, 'supports', 0.9, $3
         from evidence.document_chunks dc where dc.id = $2`,
      [claimId, chunkId, quote],
    );
    return claimId;
  }

  /**
   * Removes this suite's fixtures, including any a previous run left behind
   * after failing. Both integration suites fixture a company and vitest runs
   * files in parallel, so a suite that cannot clean up after itself breaks the
   * next run of its neighbour rather than only itself.
   */
  async function purge(): Promise<void> {
    const forSubject = (sql: string) => pool.query(sql, [companyId]);
    await forSubject(`delete from research.claim_status_events where claim_id in (
      select id from research.claims where subject_id = $1)`);
    await forSubject(`delete from research.verification_checks where verification_run_id in (
      select id from research.verification_runs where research_run_id in (
        select id from research.runs where subject_id = $1))`);
    await forSubject(`delete from research.verification_runs where research_run_id in (
      select id from research.runs where subject_id = $1)`);
    await forSubject(`delete from research.model_cache where request_hash in (
      select request_hash from research.model_runs where research_run_id in (
        select id from research.runs where subject_id = $1))`);
    await forSubject(`delete from research.claim_evidence where claim_id in (
      select id from research.claims where subject_id = $1)`);
    await forSubject(`delete from research.claims where subject_id = $1`);
    await forSubject(`delete from research.model_runs where research_run_id in (
      select id from research.runs where subject_id = $1)`);
    await forSubject(`delete from research.module_runs where run_id in (
      select id from research.runs where subject_id = $1)`);
    await forSubject(`delete from research.runs where subject_id = $1`);

    const bySource = (sql: string) => pool.query(sql, [`${SOURCE_PREFIX}%`]);
    await bySource(`delete from evidence.document_chunks dc
      using evidence.document_versions dv, evidence.documents d, evidence.sources s
      where dc.document_version_id = dv.id and dv.document_id = d.id
        and d.source_id = s.id and s.source_name like $1`);
    await bySource(`delete from evidence.document_versions dv
      using evidence.documents d, evidence.sources s
      where dv.document_id = d.id and d.source_id = s.id and s.source_name like $1`);
    await bySource(`delete from evidence.document_subjects ds
      using evidence.documents d, evidence.sources s
      where ds.document_id = d.id and d.source_id = s.id and s.source_name like $1`);
    await bySource(`delete from evidence.documents d using evidence.sources s
      where d.source_id = s.id and s.source_name like $1`);
    await bySource(`delete from evidence.sources where source_name like $1`);
  }

  beforeAll(async () => {
    pool = createPool(url);

    // A different issuer from the module-runtime test on purpose: both suites
    // fixture a company and vitest runs files in parallel, so sharing one
    // subject makes each run's snapshot depend on the other's timing.
    const outcome = await resolveCompany(pool, 'NioCorp');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing NioCorp');
    companyId = outcome.company.companyId;

    await purge();

    const source = await pool.query<{ id: string }>(
      `insert into evidence.sources (source_name, source_type, source_tier, publisher)
       values ($1, 'filing', 1, 'Test') returning id`,
      [`${SOURCE_PREFIX}${run}`],
    );
    const document = await pool.query<{ id: string }>(
      `insert into evidence.documents (source_id, external_id, document_type, title, published_at)
       values ($1, $2, '10-K', $3, now()) returning id`,
      [source.rows[0]!.id, `verify-test-${run}`, `Annual report (verify ${run})`],
    );
    documentId = document.rows[0]!.id;
    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [documentId, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [documentId, `verify-hash-${run}`, CHUNK_TEXT],
    );
    const chunk = await pool.query<{ id: string }>(
      `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
       values ($1, 0, $2) returning id`,
      [version.rows[0]!.id, CHUNK_TEXT],
    );
    chunkId = chunk.rows[0]!.id;

    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-07-31',
      transport: honest,
      apiKey: 'test-key',
    });
    runId = result.runId;
  });

  afterAll(async () => {
    if (!pool) return;
    await purge();
    await pool.end();
  });

  it('passes a run whose claims all quote their evidence', async () => {
    const result = await verifyRun(pool, runId);
    expect(result.overall).toBe('passed');
    // One claim per LLM module, and CORE_RECIPE now runs eight of them.
    expect(result.claimsChecked).toBe(8);
    expect(result.contradicted).toEqual([]);

    const { rows } = await pool.query<{ overall_status: string; summary: { failed: number } }>(
      `select overall_status, summary from research.verification_runs where id = $1`,
      [result.verificationRunId],
    );
    expect(rows[0]).toMatchObject({ overall_status: 'passed' });
    expect(rows[0]!.summary.failed).toBe(0);
  });

  it('rejects a planted bad citation and records why', async () => {
    const planted = await plantClaim(
      'The company produced 90,000 metric tons of rare earth oxide.',
      'The Company produced 90,000 metric tons of rare earth oxide in concentrate.',
      `planted_${run}`,
    );

    const result = await verifyRun(pool, runId);
    expect(result.overall).toBe('failed');
    expect(result.contradicted).toContain(planted);

    const claim = await pool.query<{ status: string }>(
      `select epistemic_status as status from research.claims where id = $1`,
      [planted],
    );
    expect(claim.rows[0]!.status).toBe('CONTRADICTED');

    const checks = await pool.query<{ check_type: string; severity: string; message: string }>(
      `select check_type, severity, message from research.verification_checks
        where verification_run_id = $1 and claim_id = $2 and status = 'failed'
        order by check_type`,
      [result.verificationRunId, planted],
    );
    // Only containment fails: the invented number does appear in the quote the
    // claim cites, which is why a number check alone would have passed it. The
    // two rules close the loop only together.
    expect(checks.rows.map((row) => row.check_type)).toEqual(['quote_containment']);
    expect(checks.rows[0]!.severity).toBe('critical');

    const events = await pool.query<{
      from_status: string;
      to_status: string;
      changed_by: string;
      reason: string;
      verification_check_id: string | null;
    }>(
      `select from_status, to_status, changed_by, reason, verification_check_id
         from research.claim_status_events where claim_id = $1 order by seq desc limit 1`,
      [planted],
    );
    expect(events.rows[0]).toMatchObject({
      from_status: 'DERIVED',
      to_status: 'CONTRADICTED',
      changed_by: 'verification',
    });
    expect(events.rows[0]!.verification_check_id).not.toBeNull();
    expect(events.rows[0]!.reason).toMatch(/not in chunk|does not/);
  });

  it('rejects a number the cited quote does not contain', async () => {
    const planted = await plantClaim(
      'The company produced 45,455 metric tons across 12 separate facilities.',
      MARKER,
      `uncited_number_${run}`,
    );

    const result = await verifyRun(pool, runId);
    expect(result.contradicted).toContain(planted);

    const checks = await pool.query<{ check_type: string; message: string }>(
      `select check_type, message from research.verification_checks
        where verification_run_id = $1 and claim_id = $2 and status = 'failed'`,
      [result.verificationRunId, planted],
    );
    expect(checks.rows.map((row) => row.check_type)).toEqual(['number_vs_fact']);
    expect(checks.rows[0]!.message).toContain('12');
  });

  it('flags two claims that answer the same key differently', async () => {
    const key = `disputed_${run}`;
    const first = await plantClaim(
      'Mountain Pass is the only operating rare earth mine in North America.',
      'Mountain Pass is the only operating rare earth mine in North America.',
      key,
    );
    const second = await plantClaim(
      'Mountain Pass is one of several operating rare earth mines in North America.',
      'Mountain Pass is the only operating rare earth mine in North America.',
      key,
    );

    const result = await verifyRun(pool, runId);
    // Every claim now carries a contradiction check, so the flag is the failed
    // ones: a claim nobody else answers is checked and skipped, and claims that
    // agree are checked and passed.
    const flagged = result.checks.filter(
      (check) => check.type === 'contradiction' && check.status === 'failed',
    );
    expect(flagged.map((check) => check.claimId).sort()).toEqual([first, second].sort());
    expect(result.contradicted).toEqual(expect.arrayContaining([first, second]));

    const others = result.checks.filter(
      (check) => check.type === 'contradiction' && check.status !== 'failed',
    );
    expect(others.length).toBeGreaterThan(0);
  });

  it('records each pass separately, so the history of checks is kept', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.verification_runs where research_run_id = $1`,
      [runId],
    );
    expect(Number(rows[0]!.count)).toBeGreaterThanOrEqual(3);
  });
});
