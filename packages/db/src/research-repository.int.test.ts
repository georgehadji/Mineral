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
import { promoteFacilities } from './ontology-repository.ts';
import { resolveCompany } from './identity-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the module runtime', () => {
  let pool: Pool;
  let companyId: string;
  let documentId: string;
  const run = randomUUID().slice(0, 8);
  const SOURCE_PREFIX = 'runtime-test-source-';
  const externalId = `runtime-test-${run}`;

  /** Planted so a stub can quote something that is genuinely in the chunk. */
  const MARKER =
    'The Company produced 45,455 metric tons of rare earth oxide in concentrate during the year.';
  const CHUNK_TEXT =
    'The Round Top project is the company only rare earth property in development. ' +
    MARKER +
    ' Substantially all of our revenue is derived from sales to customers in China.';

  /** Pulls the chunk id of the block that holds the marker out of the prompt. */
  function citedChunkId(body: string): string {
    const request = JSON.parse(body) as { messages: { content: string }[] };
    const prompt = request.messages.map((m) => m.content).join('\n');
    const at = prompt.indexOf(MARKER);
    if (at === -1) throw new Error('the module did not put the planted chunk in its prompt');
    // Modules are shown short handles now, not uuids: [chunk 7].
    const ids = [...prompt.slice(0, at).matchAll(/\[chunk (\d+)\]/g)];
    const last = ids.at(-1);
    if (!last) throw new Error('no chunk id before the planted text');
    return last[1]!;
  }

  const reply = (claims: unknown[], facilities: unknown[] = []): { status: number; body: string } => ({
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
                  arguments: JSON.stringify({ claims, facilities }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
    }),
  });

  /**
   * The sites, proposed exactly once across the whole run.
   *
   * This transport answers every module the same way, and eight identical
   * proposals would be six duplicates that the policy is right to refuse in a
   * heap. Only the first module to ask gets them, which is what one module
   * naming a site looks like from the promoter's side.
   */
  let sitesOffered = false;
  const sites = () => {
    if (sitesOffered) return [];
    sitesOffered = true;
    return [
      {
        name: `Test Separation Plant ${run}`,
        stage_code: 'separation',
        material_code: 'ndpr_oxide',
        country_code: 'US',
        status: 'operating',
        source_claim_key: `production_volume_${run}`,
      },
      {
        // Founded on the UNKNOWN claim, so policy has to refuse it.
        name: `Test Magnet Plant ${run}`,
        stage_code: 'magnet',
        material_code: null,
        country_code: null,
        status: 'planned',
        source_claim_key: `unanswered_${run}`,
      },
    ];
  };

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
    ], sites());
  };

  /**
   * Removes this suite's fixtures, including any a previous run left behind
   * after failing. Both integration suites fixture a company and vitest runs
   * files in parallel, so a suite that cannot clean up after itself breaks the
   * next run of its neighbour rather than only itself.
   */
  async function purge(): Promise<void> {
    const forSubject = (sql: string) => pool.query(sql, [companyId]);
    // Promoted facilities first: they point at claims, and seed 003 also owns
    // rows for this company. `source_claim_id is not null` is what tells the
    // two apart -- a seeded row has none.
    await forSubject(`with gone as (
      delete from ontology.facilities
       where company_id = $1 and source_claim_id is not null
      returning id)
      delete from core.entities where id in (select id from gone)`);
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

    // Not MP: the calculation suite fixtures MP and promotes CALCULATED facts
    // for it, and vitest runs files in parallel. A promoted fact belongs in the
    // snapshot, so a fact arriving mid-suite correctly produces a different run
    // -- which is exactly what the idempotency test below must not see.
    const outcome = await resolveCompany(pool, 'USA Rare Earth');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing USA Rare Earth');
    companyId = outcome.company.companyId;

    await purge();

    const source = await pool.query<{ id: string }>(
      `insert into evidence.sources (source_name, source_type, source_tier, publisher)
       values ($1, 'filing', 1, 'Test')
       returning id`,
      [`${SOURCE_PREFIX}${run}`],
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
    await purge();
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
    // Eight LLM modules ran; entity_resolution is deterministic and emits
    // nothing. industry_position and supply_chain_position joined CORE_RECIPE
    // so the ordinary path can place a company in the chain.
    expect(result.modules.map((m) => m.code)).toEqual([
      'entity_resolution',
      'company_profile',
      'business_model',
      'financial_quality',
      'capital_structure',
      'commodity_exposure',
      'industry_position',
      'supply_chain_position',
      'valuation_assumptions',
    ]);
    expect(result.modules.every((m) => m.status === 'completed')).toBe(true);
    expect(result.claimCount).toBe(16);

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

  /**
   * The phase after J.6: a claim becomes a row in the ontology, or it does not,
   * and a rule decides which. Nothing here runs the model again -- promotion
   * reads the output the run already stored.
   */
  it('promotes a proposed site and refuses one its claim cannot carry', async () => {
    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-06-30',
      transport: honest,
      apiKey: 'test-key',
    });

    const promotion = await promoteFacilities(pool, result.runId);
    expect(promotion.promoted).toBe(1);

    const approved = promotion.decisions.find((decision) => decision.status === 'approved')!;
    expect(approved.name).toBe(`Test Separation Plant ${run}`);
    expect(approved.stageCode).toBe('separation');
    expect(approved.facilityId).not.toBeNull();
    expect(approved.sourceClaimId).not.toBeNull();

    const refused = promotion.decisions.find((decision) => decision.status === 'rejected')!;
    expect(refused.name).toBe(`Test Magnet Plant ${run}`);
    expect(refused.reason).toContain('UNKNOWN');
    expect(refused.facilityId).toBeNull();

    // The row carries the claim, and the claim carries the quote. That chain is
    // the whole point of promoting rather than copying.
    const { rows } = await pool.query<{
      name: string;
      stage_code: string;
      material_code: string | null;
      status: string;
      claim_status: string;
      quote: string | null;
    }>(
      `select f.name, s.code as stage_code, m.code as material_code, f.status,
              c.epistemic_status as claim_status, ce.quote_excerpt as quote
         from ontology.facilities f
         join ontology.supply_chain_stages s on s.id = f.stage_id
         left join ontology.materials m on m.id = f.primary_material_id
         join research.claims c on c.id = f.source_claim_id
         left join research.claim_evidence ce on ce.claim_id = c.id
        where f.id = $1`,
      [approved.facilityId],
    );
    expect(rows[0]).toMatchObject({
      name: `Test Separation Plant ${run}`,
      stage_code: 'separation',
      material_code: 'ndpr_oxide',
      status: 'operating',
      claim_status: 'DERIVED',
    });
    expect(rows[0]!.quote).toBeTruthy();

    // Re-running is the normal case, not an error: the key is (company, name,
    // stage), so the second pass lands on the row the first one wrote.
    const again = await promoteFacilities(pool, result.runId);
    expect(again.promoted).toBe(1);
    expect(again.decisions.find((d) => d.status === 'approved')!.facilityId).toBe(
      approved.facilityId,
    );
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
    expect(again.claimCount).toBe(16);

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

    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-06-29',
      transport: fabricating,
      apiKey: 'test-key',
    });

    // The claim is refused, not the run. Every module here returns nothing but
    // the fabrication, so every module completes having stored nothing.
    expect(result.status).toBe('completed');
    expect(result.claimCount).toBe(0);

    const profile = result.modules.find((module) => module.code === 'company_profile')!;
    expect(profile.status).toBe('completed');
    expect(profile.rejected?.[0]?.reason).toMatch(/quotes text that is not in chunk/);

    // The gate itself is unmoved: nothing miscited reaches the table.
    const { rows } = await pool.query<{ count: string }>(
      `select count(c.id)::text as count
         from research.runs r
         left join research.claims c on c.run_id = r.id
        where r.subject_id = $1 and r.as_of_date = '2026-06-29'`,
      [companyId],
    );
    expect(Number(rows[0]?.count ?? 0)).toBe(0);

    // And the refusal is on the record rather than lost with the claim.
    const stored = await pool.query<{ code: string; reason: string }>(
      `select md.code, mr.output->'rejected'->0->>'reason' as reason
         from research.module_runs mr
         join research.module_definitions md on md.id = mr.module_definition_id
         join research.runs r on r.id = mr.run_id
        where r.subject_id = $1 and r.as_of_date = '2026-06-29'
          and jsonb_array_length(coalesce(mr.output->'rejected', '[]'::jsonb)) > 0`,
      [companyId],
    );
    expect(stored.rows.map((row) => row.code)).toContain('company_profile');
    expect(stored.rows[0]!.reason).toMatch(/quotes text that is not in chunk/);
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
