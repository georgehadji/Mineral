/**
 * Integration test. Needs a PostgreSQL database with the migrations and the
 * issuer seed applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.6 gate: a run completes, and every claim it stored
 * carries a quote that really appears in the chunk it cites.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@mineral/ai';
import { CORE_RECIPE } from '@mineral/research';
import { createPool, type Pool } from './client.ts';
import { runResearch } from './research-repository.ts';
import { resolveCompany } from './identity-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the module runtime', () => {
  let pool: Pool;
  let companyId: string;
  let documentId: string;
  const run = randomUUID().slice(0, 8);
  const externalId = `runtime-test-${run}`;

  /** Planted so a stub can quote something that is genuinely in the chunk. */
  const MARKER =
    'The Company produced 45,455 metric tons of rare earth oxide in concentrate during the year.';
  const CHUNK_TEXT =
    'Mountain Pass is the only operating rare earth mine and processing facility in North America. ' +
    MARKER +
    ' Substantially all of our revenue is derived from sales to customers in China.';

  /** Pulls the chunk id of the block that holds the marker out of the prompt. */
  function citedChunkId(body: string): string {
    const request = JSON.parse(body) as { messages: { content: string }[] };
    const prompt = request.messages.map((m) => m.content).join('\n');
    const at = prompt.indexOf(MARKER);
    if (at === -1) throw new Error('the module did not put the planted chunk in its prompt');
    const ids = [...prompt.slice(0, at).matchAll(/\[chunk_id: ([0-9a-f-]{36})\]/g)];
    const last = ids.at(-1);
    if (!last) throw new Error('no chunk id before the planted text');
    return last[1]!;
  }

  const reply = (claims: unknown[]): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              { type: 'function', function: { name: 'record_result', arguments: JSON.stringify({ claims }) } },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
    }),
  });

  /** Quotes the planted sentence verbatim, as a well-behaved module would. */
  const honest: Transport = async (_url, init) => {
    const chunkId = citedChunkId(init.body);
    return reply([
      {
        claim_key: `production_volume_${run}`,
        claim_type: 'business_fact',
        statement: 'The company produced 45,455 metric tons of rare earth oxide in concentrate.',
        status: 'DERIVED',
        confidence: 0.9,
        evidence: [
          { chunk_id: chunkId, fact_version_id: null, quote: MARKER, role: 'supports', strength: 0.9 },
        ],
      },
      {
        claim_key: `unanswered_${run}`,
        claim_type: 'metric',
        statement: 'Free cash flow for the period is not stated in the evidence.',
        status: 'UNKNOWN',
        confidence: 0.2,
        evidence: [],
      },
    ]);
  };

  beforeAll(async () => {
    pool = createPool(url);

    const outcome = await resolveCompany(pool, 'MP');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing MP Materials');
    companyId = outcome.company.companyId;

    const source = await pool.query<{ id: string }>(
      `insert into evidence.sources (source_name, source_type, source_tier, publisher)
       values ($1, 'filing', 1, 'Test')
       returning id`,
      [`runtime-test-source-${run}`],
    );
    const document = await pool.query<{ id: string }>(
      `insert into evidence.documents (source_id, external_id, document_type, title, published_at)
       values ($1, $2, '10-K', $3, now())
       returning id`,
      [source.rows[0]!.id, externalId, `Annual report (test ${run})`],
    );
    documentId = document.rows[0]!.id;

    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [documentId, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3)
       returning id`,
      [documentId, `hash-${run}`, CHUNK_TEXT],
    );
    await pool.query(
      `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
       values ($1, 0, $2)`,
      [version.rows[0]!.id, CHUNK_TEXT],
    );
  });

  afterAll(async () => {
    if (!pool) return;
    // Children first: claims and model runs both point at runs and module runs.
    await pool.query(
      `delete from research.model_cache where request_hash in (
         select request_hash from research.model_runs
          where research_run_id in (select id from research.runs where subject_id = $1))`,
      [companyId],
    );
    // A trigger writes a status event for every claim, so those go first.
    await pool.query(
      `delete from research.claim_status_events where claim_id in (
         select id from research.claims where subject_id = $1)`,
      [companyId],
    );
    await pool.query(
      `delete from research.claim_evidence where claim_id in (
         select id from research.claims where subject_id = $1)`,
      [companyId],
    );
    await pool.query(`delete from research.claims where subject_id = $1`, [companyId]);
    await pool.query(
      `delete from research.model_runs where research_run_id in (
         select id from research.runs where subject_id = $1)`,
      [companyId],
    );
    await pool.query(
      `delete from research.module_runs where run_id in (
         select id from research.runs where subject_id = $1)`,
      [companyId],
    );
    await pool.query(`delete from research.runs where subject_id = $1`, [companyId]);
    await pool.query(
      `delete from evidence.document_chunks where document_version_id in (
         select id from evidence.document_versions where document_id = $1)`,
      [documentId],
    );
    await pool.query(`delete from evidence.document_versions where document_id = $1`, [documentId]);
    await pool.query(`delete from evidence.document_subjects where document_id = $1`, [documentId]);
    await pool.query(`delete from evidence.documents where id = $1`, [documentId]);
    await pool.query(`delete from evidence.sources where source_name = $1`, [
      `runtime-test-source-${run}`,
    ]);
    await pool.end();
  });

  it('completes a run and stores a verified quote for every cited claim', async () => {
    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-06-30',
      transport: honest,
      apiKey: 'test-key',
    });

    expect(result.status).toBe('completed');
    expect(result.reused).toBe(false);
    // Four LLM modules ran; entity_resolution is deterministic and emits nothing.
    expect(result.modules.map((m) => m.code)).toEqual([
      'entity_resolution',
      'company_profile',
      'business_model',
      'financial_quality',
      'commodity_exposure',
    ]);
    expect(result.modules.every((m) => m.status === 'completed')).toBe(true);
    expect(result.claimCount).toBe(8);

    const { rows } = await pool.query<{
      claim_key: string;
      status: string;
      quote: string | null;
      chunk_text: string | null;
      evidence_count: string;
    }>(
      `select c.claim_key, c.epistemic_status as status, ce.quote_excerpt as quote,
              dc.text_content as chunk_text,
              count(ce.id) over (partition by c.id)::text as evidence_count
         from research.claims c
         left join research.claim_evidence ce on ce.claim_id = c.id
         left join evidence.document_chunks dc on dc.id = ce.chunk_id
        where c.run_id = $1`,
      [result.runId],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      if (row.status === 'UNKNOWN') {
        expect(row.quote).toBeNull();
        continue;
      }
      // The gate: a stored quote is text that is really in the cited chunk.
      expect(Number(row.evidence_count)).toBeGreaterThan(0);
      expect(row.chunk_text).toContain(row.quote);
    }

    // The LLM never writes a VERIFIED claim (invariant C.7, report G).
    expect(rows.every((row) => row.status !== 'VERIFIED')).toBe(true);
  });

  it('returns the same run for the same snapshot instead of writing another', async () => {
    const again = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-06-30',
      transport: honest,
      apiKey: 'test-key',
    });
    expect(again.reused).toBe(true);
    expect(again.claimCount).toBe(8);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.runs
        where subject_id = $1 and as_of_date = '2026-06-30'`,
      [companyId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('rejects a claim whose quote is not in the chunk it cites', async () => {
    const fabricating: Transport = async (_url, init) => {
      const chunkId = citedChunkId(init.body);
      return reply([
        {
          claim_key: `fabricated_${run}`,
          claim_type: 'business_fact',
          statement: 'The company produced 90,000 metric tons of rare earth oxide.',
          status: 'DERIVED',
          confidence: 0.95,
          evidence: [
            {
              chunk_id: chunkId,
              fact_version_id: null,
              quote: 'The Company produced 90,000 metric tons of rare earth oxide in concentrate.',
              role: 'supports',
              strength: 0.95,
            },
          ],
        },
      ]);
    };

    await expect(
      runResearch(pool, {
        companyId,
        recipe: CORE_RECIPE,
        asOfDate: '2026-06-29',
        transport: fabricating,
        apiKey: 'test-key',
      }),
    ).rejects.toThrow(/quotes text that is not in chunk/);

    const { rows } = await pool.query<{ status: string; count: string }>(
      `select r.status, count(c.id)::text as count
         from research.runs r
         left join research.claims c on c.run_id = r.id
        where r.subject_id = $1 and r.as_of_date = '2026-06-29'
        group by r.status`,
      [companyId],
    );
    expect(rows[0]?.status).toBe('failed');
    // entity_resolution emits nothing, so a failed run leaves no claims at all.
    expect(Number(rows[0]?.count ?? 0)).toBe(0);

    const modules = await pool.query<{ code: string; status: string }>(
      `select md.code, mr.status
         from research.module_runs mr
         join research.module_definitions md on md.id = mr.module_definition_id
         join research.runs r on r.id = mr.run_id
        where r.subject_id = $1 and r.as_of_date = '2026-06-29'
          and mr.status = 'failed'`,
      [companyId],
    );
    expect(modules.rows.map((row) => row.code)).toContain('company_profile');
  });

  it('refuses to research a company with no evidence at all', async () => {
    const empty = await resolveCompany(pool, 'Lynas');
    if (empty.status !== 'resolved') throw new Error('seed 001 is missing Lynas');

    await expect(
      runResearch(pool, {
        companyId: empty.company.companyId,
        recipe: CORE_RECIPE,
        asOfDate: '2026-06-30',
        transport: honest,
        apiKey: 'test-key',
      }),
    ).rejects.toThrow(/nothing to research/);
  });
});
