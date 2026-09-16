/**
 * Integration test. Needs a PostgreSQL database with the migrations and the
 * issuer seed applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.9 gate: someone opens a company page, clicks a number,
 * and lands on the filing that number came from. Both routes are checked --
 * through a claim to the quote it cites, and through a valuation input to the
 * fact revision's own source document -- because a page that can only trace
 * prose is not tracing the valuation.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Transport } from '@mineral/ai';
import { ASSUMPTION_BANDS, CORE_RECIPE } from '@mineral/research';
import { createPool, inTransaction, type Pool } from './client.ts';
import { runResearch } from './research-repository.ts';
import { resolveCompany } from './identity-repository.ts';
import { decide, type CalcFn } from './decision-repository.ts';
import { ensureFactDefinitions, upsertFact } from './facts.ts';
import {
  claimDetail,
  companyList,
  companyPage,
  documentPage,
  runStatus,
} from './read-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('web read models', () => {
  let pool: Pool;
  let companyId: string;
  let documentVersionId: string;
  const run = randomUUID().slice(0, 8);
  const SOURCE_PREFIX = 'read-test-source-';
  const TITLE = `Annual report (read ${run})`;

  const MARKER =
    'The Company generated 91,300,000 of cash from operations during the year ended December 31, 2025.';
  const DEBT_LINE =
    'Borrowings outstanding at year end were 18,000,000 at a weighted average rate of 8.5 percent.';
  const CHUNK_TEXT =
    'The Wolfsberg project is the company only lithium asset in development. ' +
    MARKER +
    ' ' +
    DEBT_LINE;

  const ASSUMPTIONS_V1: Record<string, number> = {
    discount_rate: 0.11,
    terminal_growth: 0.025,
    growth_rate: 0.05,
    projection_years: 5,
  };
  /** One number moves between the two theses, so "what changed" has something
   *  true to say that is not just a reworded sentence. */
  const ASSUMPTIONS_V2: Record<string, number> = { ...ASSUMPTIONS_V1, discount_rate: 0.09 };

  const MODULE_MARKERS: [string, string][] = [
    ['Describe what this company does', 'company_profile'],
    ['How does this company earn revenue', 'business_model'],
    ['Assess financial quality', 'financial_quality'],
    ['Which commodities does this company', 'commodity_exposure'],
    ['How is this company funded', 'capital_structure'],
    ['Propose these inputs', 'valuation_assumptions'],
  ];

  const DRIVER_QUOTE = 'The Wolfsberg project is the company only lithium asset in development.';
  const DRIVER_KEY = `sole_asset_${run}`;

  const toolReply = (payload: unknown): { status: number; body: string } => ({
    status: 200,
    body: JSON.stringify({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            tool_calls: [
              {
                type: 'function',
                function: { name: 'record_result', arguments: JSON.stringify(payload) },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, cost: 0.0001 },
    }),
  });

  function citedChunkId(prompt: string): string {
    const at = prompt.indexOf(MARKER);
    if (at === -1) throw new Error('the module did not put the planted chunk in its prompt');
    const ids = [...prompt.slice(0, at).matchAll(/\[chunk_id: ([0-9a-f-]{36})\]/g)];
    const last = ids.at(-1);
    if (!last) throw new Error('no chunk id before the planted text');
    return last[1]!;
  }

  /**
   * Every module answers with the same evidenced finding under one stable
   * claim_key, so the thesis of both versions anchors to the same subject and
   * the diff is about what changed rather than about which claim row won.
   */
  function stub(options: {
    assumptions: Record<string, number>;
    conclusion: string;
    verdict: string;
  }): Transport {
    return async (_url, init) => {
      const request = JSON.parse(init.body) as { messages: { content: string }[] };
      const prompt = request.messages.map((message) => message.content).join('\n');

      if (prompt.includes('You write the investment thesis')) {
        const approved = [...prompt.matchAll(/\[assumption_code: (\w+)\]/g)].map((m) => m[1]!);
        const hasValuation = !prompt.includes('No valuation was produced');
        return toolReply({
          verdict: options.verdict,
          summary: 'One asset, one buyer, and a discount rate the filings can carry.',
          confidence: 0.6,
          nodes: [
            {
              key: 'driver',
              node_type: 'DRIVER',
              statement: 'Development rests on a single lithium project.',
              confidence: 0.85,
              claim_key: DRIVER_KEY,
            },
            {
              key: 'rate',
              node_type: 'ASSUMPTION',
              statement: 'Cash flows are discounted at the approved rate.',
              confidence: 0.6,
              assumption_code: approved.includes('discount_rate') ? 'discount_rate' : null,
            },
            {
              key: 'value',
              node_type: 'CONCLUSION',
              statement: options.conclusion,
              confidence: 0.6,
              from_valuation: hasValuation,
            },
          ],
          edges: [
            { from: 'driver', edge_type: 'SUPPORTS', to: 'value' },
            { from: 'value', edge_type: 'DEPENDS_ON', to: 'rate' },
          ],
        });
      }

      const entry = MODULE_MARKERS.find(([phrase]) => prompt.includes(phrase));
      if (!entry) throw new Error(`no stubbed answer for this prompt:\n${prompt.slice(0, 200)}`);
      const [, code] = entry;
      const chunkId = citedChunkId(prompt);

      if (code !== 'valuation_assumptions') {
        return toolReply({
          claims: [
            {
              claim_key: code === 'company_profile' ? DRIVER_KEY : `${code}_finding_${run}`,
              claim_type: 'business_fact',
              statement: 'The company holds one lithium project in development.',
              status: 'DERIVED',
              confidence: 0.9,
              evidence: [
                {
                  chunk_id: chunkId,
                  fact_version_id: null,
                  quote: DRIVER_QUOTE,
                  role: 'supports',
                  strength: 0.9,
                },
              ],
            },
          ],
        });
      }

      return toolReply({
        claims: Object.keys(ASSUMPTION_BANDS).map((assumptionCode) => ({
          claim_key: `${assumptionCode}_basis_${run}`,
          claim_type: 'metric',
          statement: `Evidence bearing on ${assumptionCode}.`,
          status: 'DERIVED',
          confidence: 0.8,
          evidence: [
            {
              chunk_id: chunkId,
              fact_version_id: null,
              quote: DEBT_LINE,
              role: 'supports',
              strength: 0.8,
            },
          ],
        })),
        assumptions: Object.entries(options.assumptions).map(([assumptionCode, value]) => ({
          code: assumptionCode,
          name: assumptionCode.replace(/_/g, ' '),
          value,
          unit: ASSUMPTION_BANDS[assumptionCode]?.unit ?? null,
          min_value: null,
          max_value: null,
          rationale: 'Read off the disclosed borrowing terms.',
          source_claim_key: `${assumptionCode}_basis_${run}`,
        })),
      });
    };
  }

  const calc: CalcFn = async (method, inputs, currency) => ({
    method,
    engine: 'dcf',
    engine_version: '1.0.0',
    currency,
    inputs,
    outputs: [
      {
        code: `dcf_equity_value_${run}`,
        name: 'DCF equity value',
        value: Number(inputs.discount_rate) < 0.1 ? 1_410_000_000 : 1_105_000_000,
        unit: currency,
        inputs: ['base_cash_flow', 'growth_rates', 'discount_rate', 'terminal_growth', 'net_debt'],
      },
    ],
    detail: {},
  });

  async function purge(): Promise<void> {
    const forSubject = (sql: string) => pool.query(sql, [companyId]);

    await forSubject(`delete from research.thesis_edges where from_node_id in (
      select n.id from research.thesis_nodes n
        join research.thesis_versions tv on tv.id = n.thesis_version_id
       where tv.subject_id = $1)`);
    await forSubject(`delete from research.thesis_nodes where thesis_version_id in (
      select id from research.thesis_versions where subject_id = $1)`);
    await forSubject(`delete from research.thesis_versions where subject_id = $1`);

    await forSubject(`delete from evidence.fact_derivations where calculation_run_id in (
      select id from valuation.calculation_runs where subject_id = $1)`);
    await forSubject(`delete from evidence.fact_derivations where derived_fact_version_id in (
      select fv.id from evidence.fact_versions fv
        join evidence.facts f on f.id = fv.fact_id where f.entity_id = $1)`);
    await forSubject(`delete from valuation.calculation_run_inputs where calculation_run_id in (
      select id from valuation.calculation_runs where subject_id = $1)`);
    await forSubject(`delete from valuation.calculation_runs where subject_id = $1`);
    await forSubject(`delete from valuation.scenario_assumptions where scenario_id in (
      select id from valuation.scenarios where subject_id = $1)`);
    await forSubject(`delete from valuation.scenarios where subject_id = $1`);
    await forSubject(`delete from valuation.assumption_versions where assumption_id in (
      select id from valuation.assumptions where subject_id = $1)`);
    await forSubject(`delete from valuation.assumptions where subject_id = $1`);

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

    await forSubject(`update evidence.facts set current_version_id = null where entity_id = $1`);
    await forSubject(`delete from evidence.fact_versions where fact_id in (
      select id from evidence.facts where entity_id = $1)`);
    await forSubject(`delete from evidence.facts where entity_id = $1`);

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

  /** Promoted figures the DCF draws on, as XBRL ingestion would have left them. */
  async function plantFacts(): Promise<void> {
    await inTransaction(pool, async (client) => {
      const definitions = await ensureFactDefinitions(client, [
        { code: 'free_cash_flow', name: 'Free cash flow', valueType: 'numeric', canonicalUnit: 'USD' },
        { code: 'net_debt', name: 'Net debt', valueType: 'numeric', canonicalUnit: 'USD' },
      ]);
      for (const [code, value] of [
        ['free_cash_flow', 91_300_000],
        ['net_debt', 18_000_000],
      ] as const) {
        const definitionId = definitions.get(code);
        if (!definitionId) throw new Error(`no fact definition for ${code}`);
        const factId = await upsertFact(client, companyId, definitionId, {
          periodStart: '2025-01-01',
          periodEnd: '2025-12-31',
        });
        const { rows } = await client.query<{ id: string }>(
          `insert into evidence.fact_versions
             (fact_id, numeric_value, unit, currency, observed_at, extraction_method,
              source_document_version_id)
           values ($1, $2::numeric, 'USD', 'USD', now(), 'xbrl', $3)
           returning id`,
          [factId, String(value), documentVersionId],
        );
        await client.query(`select evidence.promote_fact_version($1, 'system')`, [rows[0]!.id]);
      }
    });
  }

  async function researchAndDecide(
    asOfDate: string,
    options: { assumptions: Record<string, number>; conclusion: string; verdict: string },
  ): Promise<string> {
    const transport = stub(options);
    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate,
      transport,
      apiKey: 'test-key',
    });
    await decide(pool, { runId: result.runId, calc, transport, apiKey: 'test-key' });
    return result.runId;
  }

  beforeAll(async () => {
    pool = createPool(url);

    // A fifth issuer: the other database suites own MP, USA Rare Earth,
    // NioCorp and Energy Fuels, and vitest runs the files in parallel.
    const outcome = await resolveCompany(pool, 'Critical Metals');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing Critical Metals');
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
      [source.rows[0]!.id, `read-test-${run}`, TITLE],
    );
    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [document.rows[0]!.id, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [document.rows[0]!.id, `read-hash-${run}`, CHUNK_TEXT],
    );
    documentVersionId = version.rows[0]!.id;
    await pool.query(
      `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
       values ($1, 0, $2)`,
      [documentVersionId, CHUNK_TEXT],
    );

    await plantFacts();

    await researchAndDecide('2026-05-31', {
      assumptions: ASSUMPTIONS_V1,
      conclusion: 'The computed equity value is above what the market pays.',
      verdict: 'neutral',
    });
    await researchAndDecide('2026-06-30', {
      assumptions: ASSUMPTIONS_V2,
      conclusion: 'At a lower discount rate the gap to the market price widens.',
      verdict: 'bullish',
    });
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await purge();
    await pool.end();
  });

  it('lists companies with the verdict of their latest thesis', async () => {
    const companies = await companyList(pool);
    const row = companies.find((company) => company.companyId === companyId);
    expect(row).toBeDefined();
    expect(row!.commonName).toBe('Critical Metals');
    expect(row!.verdict).toBe('bullish');
    expect(row!.thesisVersionNo).toBe(2);
    expect(row!.listings.map((listing) => listing.ticker)).toContain('CRML');
  });

  it('assembles the company page from the thesis, its assumptions and its valuation', async () => {
    const page = await companyPage(pool, companyId);
    expect(page).not.toBeNull();
    const view = page!;

    expect(view.thesis).not.toBeNull();
    expect(view.thesis!.versionNo).toBe(2);
    expect(view.thesis!.verdict).toBe('bullish');

    // Risks, catalysts, drivers and conclusions all arrive as typed nodes, and
    // each one that asserts something names what it rests on.
    expect(view.nodes.map((node) => node.nodeType)).toEqual(
      expect.arrayContaining(['CONCLUSION', 'DRIVER', 'ASSUMPTION']),
    );
    expect(view.nodes.every((node) => node.anchor !== null)).toBe(true);
    expect(view.edges.length).toBe(2);

    const rate = view.assumptions.find((assumption) => assumption.code === 'discount_rate');
    expect(rate).toBeDefined();
    expect(rate!.value).toBe(0.09);
    expect(rate!.status).toBe('approved');
    expect(rate!.approvedBy).toBe('policy');
    expect(rate!.proposedBy).toBe('llm');
    expect(rate!.inScenario).toBe(true);
    expect(rate!.sourceClaimKey).toBe(`discount_rate_basis_${run}`);

    expect(view.valuation).not.toBeNull();
    const equity = view.valuation!.outputs.find((output) => output.code.startsWith('dcf_equity'));
    expect(equity).toBeDefined();
    expect(equity!.value).toBe(1_410_000_000);
    // Two runs of the same method, so the range is real rather than a point.
    expect(equity!.runs).toBe(2);
    expect(equity!.low).toBe(1_105_000_000);
    expect(equity!.high).toBe(1_410_000_000);

    expect(view.evidence.claims).toBeGreaterThan(0);
    expect(view.evidence.citations).toBeGreaterThan(0);
    // Corpus counts are for the whole subject, so they are floors: this suite
    // owns the issuer by convention, not by a lock, and anything else that
    // ingests for it is legitimately part of what the page counts.
    expect(view.evidence.chunks).toBeGreaterThanOrEqual(1);
    expect(view.evidence.documents).toBeGreaterThanOrEqual(1);
    expect(view.evidence.promotedFacts).toBeGreaterThanOrEqual(2);
    expect(view.evidence.claimsByStatus.some((row) => row.status === 'DERIVED')).toBe(true);

    expect(view.runs.length).toBe(2);
    expect(view.runs[0]!.status).toBe('completed');
  });

  it('reaches the filing from a number on the page, both ways round', async () => {
    const page = await companyPage(pool, companyId);
    const view = page!;

    // Route one: the valuation's own input. A figure the engine consumed names
    // the fact revision it came from, and that revision names its filing.
    const baseCashFlow = view.valuation!.inputs.find(
      (input) => input.kind === 'fact' && input.code === 'free_cash_flow',
    );
    expect(baseCashFlow).toBeDefined();
    expect(baseCashFlow!.value).toBe(91_300_000);
    expect(baseCashFlow!.extractionMethod).toBe('xbrl');
    expect(baseCashFlow!.sourceDocumentVersionId).not.toBeNull();

    const filing = await documentPage(pool, baseCashFlow!.sourceDocumentVersionId!);
    expect(filing).not.toBeNull();
    expect(filing!.title).toBe(TITLE);
    expect(filing!.sourceTier).toBe(1);
    expect(filing!.documentType).toBe('10-K');
    expect(filing!.chunks.length).toBe(1);
    expect(filing!.chunks[0]!.text).toContain(MARKER);

    // Route two: a thesis node's claim, through its quote, to the same filing.
    const driver = view.nodes.find((node) => node.anchor?.kind === 'claim');
    expect(driver).toBeDefined();
    const anchor = driver!.anchor as { kind: 'claim'; claimId: string };

    const detail = await claimDetail(pool, anchor.claimId);
    expect(detail).not.toBeNull();
    expect(detail!.createdBy).toBe('llm');
    // The LLM never authors a VERIFIED claim (invariant C.7).
    expect(detail!.status).not.toBe('VERIFIED');
    expect(detail!.evidence.length).toBeGreaterThan(0);

    const citation = detail!.evidence[0]!;
    expect(citation.quote).toBe(DRIVER_QUOTE);
    expect(citation.sourceTier).toBe(1);
    expect(citation.documentVersionId).toBe(filing!.documentVersionId);

    const cited = filing!.chunks.find((chunk) => chunk.chunkId === citation.chunkId);
    expect(cited).toBeDefined();
    // The gate: the quote on the page is text that is really in the filing.
    expect(cited!.text).toContain(citation.quote);
    expect(filing!.citations).toBeGreaterThan(0);

    // The same claim_key answered by the earlier run is kept, not replaced.
    expect(detail!.otherVersions.length).toBeGreaterThan(0);
  });

  it('says what changed between this thesis version and the one before it', async () => {
    const view = (await companyPage(pool, companyId))!;
    expect(view.changed).not.toBeNull();
    const changed = view.changed!;

    expect(changed.previousVersionNo).toBe(1);
    expect(changed.verdictFrom).toBe('neutral');
    expect(changed.verdictTo).toBe('bullish');

    // The driver rests on the same claim_key in both versions, so it is not
    // reported as new even though the claim row itself is a different row.
    expect(changed.nodes.some((node) => node.key === `claim:${DRIVER_KEY}`)).toBe(false);

    const conclusion = changed.nodes.find((node) => node.nodeType === 'CONCLUSION');
    expect(conclusion).toBeDefined();
    expect(conclusion!.change).toBe('restated');
    expect(conclusion!.previousStatement).toContain('above what the market pays');

    expect(changed.assumptions).toContainEqual({ code: 'discount_rate', from: 0.11, to: 0.09 });
  });

  it('reports a run and the modules it ran', async () => {
    const view = (await companyPage(pool, companyId))!;
    const status = await runStatus(pool, view.thesis!.researchRunId);
    expect(status).not.toBeNull();
    expect(status!.status).toBe('completed');
    expect(status!.claims).toBeGreaterThan(0);
    expect(status!.thesisVersionId).toBe(view.thesis!.thesisVersionId);
    expect(status!.modules.map((module) => module.code)).toEqual(
      expect.arrayContaining(['entity_resolution', 'company_profile', 'valuation_assumptions']),
    );
    expect(status!.modules.every((module) => module.status === 'completed')).toBe(true);
  });

  it('returns null for a company that does not exist', async () => {
    expect(await companyPage(pool, randomUUID())).toBeNull();
    expect(await claimDetail(pool, randomUUID())).toBeNull();
    expect(await documentPage(pool, randomUUID())).toBeNull();
  });
});
