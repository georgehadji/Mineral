/**
 * Integration test. Needs a PostgreSQL database with the migrations and the
 * issuer seed applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.8 gate: a thesis version links the run it came from, the
 * claims under its nodes, the approved assumption versions, and the valuation
 * run computed from them. The analytics service is stubbed; what is under test
 * is the chain of links, not the arithmetic, which phase J.4 already covers.
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

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the decision layer', () => {
  let pool: Pool;
  let companyId: string;
  let documentVersionId: string;
  let firstRunId: string;
  let firstTransport: Transport;
  const run = randomUUID().slice(0, 8);
  const SOURCE_PREFIX = 'decide-test-source-';

  const MARKER =
    'The Company generated 118,400,000 of cash from operations and spent 42,000,000 on capital projects.';
  const CHUNK_TEXT =
    'White Mesa is the only conventional uranium mill operating in the United States. ' +
    MARKER +
    ' Debt outstanding at year end was 35,000,000 at a weighted average rate of 9.0 percent.';

  /** A sane proposal, and the codes policy knows, taken from policy itself. */
  const GOOD_ASSUMPTIONS: Record<string, number> = {
    discount_rate: 0.11,
    terminal_growth: 0.025,
    growth_rate: 0.05,
    projection_years: 5,
  };

  /** Which module is asking, by the one phrase each prompt owns. */
  const MODULE_MARKERS: [string, string][] = [
    ['Describe what this company does', 'company_profile'],
    ['How does this company earn revenue', 'business_model'],
    ['Assess financial quality', 'financial_quality'],
    ['Which commodities does this company', 'commodity_exposure'],
    ['What industry does this company operate in', 'industry_position'],
    ['Which stages of its supply chain does this company occupy', 'supply_chain_position'],
    ['How is this company funded', 'capital_structure'],
    ['Propose these inputs', 'valuation_assumptions'],
  ];

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
    // Modules are shown short handles now, not uuids: [chunk 7].
    const ids = [...prompt.slice(0, at).matchAll(/\[chunk (\d+)\]/g)];
    const last = ids.at(-1);
    if (!last) throw new Error('no chunk id before the planted text');
    return last[1]!;
  }

  const finding = (code: string, chunkId: string) => ({
    claim_key: `${code}_finding_${run}`,
    claim_type: 'business_fact',
    statement: 'The company operates the only conventional uranium mill in the United States.',
    status: 'DERIVED',
    confidence: 0.9,
    evidence: [
      {
        chunk_id: chunkId,
        fact_version_id: null,
        quote: 'White Mesa is the only conventional uranium mill operating in the United States.',
        role: 'supports',
        strength: 0.9,
      },
    ],
  });

  /**
   * One stub for the whole run and the synthesis after it. `assumptions` is
   * what valuation_assumptions proposes; `thesis` is what final_synthesis
   * returns, given the claim keys and approved codes it is allowed to cite.
   */
  function stub(options: {
    assumptions?: Record<string, number>;
    thesis?: (context: { claimKey: string; approved: string[]; hasValuation: boolean }) => unknown;
  }): Transport {
    const proposed = options.assumptions ?? GOOD_ASSUMPTIONS;
    return async (_url, init) => {
      const request = JSON.parse(init.body) as { messages: { content: string }[] };
      const prompt = request.messages.map((message) => message.content).join('\n');

      if (prompt.includes('You write the investment thesis')) {
        const approved = [...prompt.matchAll(/\[assumption_code: (\w+)\]/g)].map((m) => m[1]!);
        const claimKey = /\[claim_key: (\S+)\]/.exec(prompt)?.[1] ?? '';
        const hasValuation = !prompt.includes('No valuation was produced');
        const build = options.thesis ?? defaultThesis;
        return toolReply(build({ claimKey, approved, hasValuation }));
      }

      const entry = MODULE_MARKERS.find(([phrase]) => prompt.includes(phrase));
      if (!entry) throw new Error(`no stubbed answer for this prompt:\n${prompt.slice(0, 200)}`);
      const [, code] = entry;
      const chunkId = citedChunkId(prompt);

      if (code !== 'valuation_assumptions') {
        return toolReply({ claims: [finding(code, chunkId)] });
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
              quote:
                'Debt outstanding at year end was 35,000,000 at a weighted average rate of 9.0 percent.',
              role: 'supports',
              strength: 0.8,
            },
          ],
        })),
        assumptions: Object.entries(proposed).map(([assumptionCode, value]) => ({
          code: assumptionCode,
          name: assumptionCode.replace(/_/g, ' '),
          value,
          unit: ASSUMPTION_BANDS[assumptionCode]?.unit ?? null,
          min_value: null,
          max_value: null,
          rationale: 'Read off the disclosed debt terms.',
          source_claim_key: `${assumptionCode}_basis_${run}`,
        })),
      });
    };
  }

  const defaultThesis = (context: {
    claimKey: string;
    approved: string[];
    hasValuation: boolean;
  }) => ({
    verdict: 'bullish',
    summary: 'A sole domestic mill, valued on a growth rate the filings support.',
    confidence: 0.62,
    nodes: [
      {
        key: 'driver',
        node_type: 'DRIVER',
        statement: 'It runs the only conventional uranium mill in the country.',
        confidence: 0.85,
        claim_key: context.claimKey,
      },
      {
        key: 'rate',
        node_type: 'ASSUMPTION',
        statement: 'Cash flows are discounted at the rate policy approved.',
        confidence: 0.6,
        assumption_code: context.approved[0] ?? null,
      },
      {
        key: 'value',
        node_type: 'CONCLUSION',
        statement: 'The computed equity value exceeds what the market pays.',
        confidence: 0.62,
        from_valuation: context.hasValuation,
      },
    ],
    edges: [
      { from: 'driver', edge_type: 'SUPPORTS', to: 'value' },
      { from: 'value', edge_type: 'DEPENDS_ON', to: 'rate' },
    ],
  });

  /** Stands in for POST /calc/dcf, so the suite needs no Python process. */
  const calc: CalcFn = async (method, inputs, currency) => ({
    method,
    engine: 'dcf',
    engine_version: '1.0.0',
    currency,
    inputs,
    outputs: [
      {
        code: `dcf_enterprise_value_${run}`,
        name: 'DCF enterprise value',
        value: 1_284_000_000,
        unit: currency,
        inputs: ['base_cash_flow', 'growth_rates', 'discount_rate', 'terminal_growth'],
      },
      {
        code: `dcf_equity_value_${run}`,
        name: 'DCF equity value',
        value: 1_249_000_000,
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
  async function plantFacts(
    figures: ReadonlyArray<readonly [string, number]> = [
      ['free_cash_flow', 76_400_000],
      ['net_debt', 35_000_000],
    ],
    year = 2025,
    shape: 'flow' | 'balance' = 'flow',
  ): Promise<void> {
    await inTransaction(pool, async (client) => {
      const definitions = await ensureFactDefinitions(
        client,
        figures.map(([code]) => ({ code, name: code, valueType: 'numeric' as const, canonicalUnit: 'USD' })),
      );
      for (const [code, value] of figures) {
        const definitionId = definitions.get(code);
        if (!definitionId) throw new Error(`no fact definition for ${code}`);
        const factId = await upsertFact(
          client,
          companyId,
          definitionId,
          shape === 'flow'
            ? { periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` }
            : { asOfDate: `${year}-12-31` },
        );
        // Invariant C.1: a promoted revision names the document it was read
        // from, unless it was calculated or came from a data provider.
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

  /** One stub serves both halves: the modules, then the synthesis after them. */
  async function research(asOfDate: string, transport: Transport): Promise<string> {
    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate,
      transport,
      apiKey: 'test-key',
    });
    return result.runId;
  }

  const decideWith = (runId: string, transport: Transport) =>
    decide(pool, { runId, calc, transport, apiKey: 'test-key' });

  beforeAll(async () => {
    pool = createPool(url);

    // A third issuer: the runtime suite fixtures MP and the verification suite
    // NioCorp, and vitest runs the three files in parallel.
    const outcome = await resolveCompany(pool, 'Energy Fuels');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing Energy Fuels');
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
      [source.rows[0]!.id, `decide-test-${run}`, `Annual report (decide ${run})`],
    );
    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [document.rows[0]!.id, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [document.rows[0]!.id, `decide-hash-${run}`, CHUNK_TEXT],
    );
    documentVersionId = version.rows[0]!.id;
    await pool.query(
      `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
       values ($1, 0, $2)`,
      [version.rows[0]!.id, CHUNK_TEXT],
    );

    await plantFacts();
  });

  afterAll(async () => {
    if (!pool) return;
    await purge();
    await pool.end();
  });

  it('writes a thesis that links its run, its claims, its assumptions and its valuation', async () => {
    firstTransport = stub({});
    firstRunId = await research('2026-08-31', firstTransport);
    const runId = firstRunId;
    const result = await decideWith(runId, firstTransport);

    expect(result.reused).toBe(false);
    expect(result.valuationSkipped).toBeNull();
    expect(result.calculationRunId).not.toBeNull();
    expect(result.decisions.every((decision) => decision.status === 'approved')).toBe(true);
    expect(result.decisions).toHaveLength(Object.keys(GOOD_ASSUMPTIONS).length);

    // The gate: one thesis version, reaching all four ways at once.
    const { rows } = await pool.query<{
      research_run_id: string;
      verdict: string;
      version_no: number;
      claim_nodes: number;
      assumption_nodes: number;
      valuation_nodes: number;
    }>(
      `select tv.research_run_id, tv.verdict, tv.version_no,
              count(*) filter (where n.claim_id is not null)::int as claim_nodes,
              count(*) filter (where n.assumption_version_id is not null)::int as assumption_nodes,
              count(*) filter (where n.calculation_run_id is not null)::int as valuation_nodes
         from research.thesis_versions tv
         join research.thesis_nodes n on n.thesis_version_id = tv.id
        where tv.id = $1
        group by tv.id`,
      [result.thesisVersionId],
    );
    expect(rows[0]).toMatchObject({ research_run_id: runId, verdict: 'bullish' });
    expect(rows[0]!.claim_nodes).toBeGreaterThan(0);
    expect(rows[0]!.assumption_nodes).toBeGreaterThan(0);
    expect(rows[0]!.valuation_nodes).toBe(1);

    const edges = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.thesis_edges e
         join research.thesis_nodes n on n.id = e.from_node_id
        where n.thesis_version_id = $1`,
      [result.thesisVersionId],
    );
    expect(Number(edges.rows[0]!.count)).toBe(2);

    // The assumption a node points at is approved, by policy, not by the model.
    const approved = await pool.query<{ status: string; approved_by: string; proposed_by: string }>(
      `select av.status, av.approved_by, av.proposed_by
         from research.thesis_nodes n
         join valuation.assumption_versions av on av.id = n.assumption_version_id
        where n.thesis_version_id = $1`,
      [result.thesisVersionId],
    );
    expect(approved.rows[0]).toMatchObject({
      status: 'approved',
      approved_by: 'policy',
      proposed_by: 'llm',
    });

    // The valuation names the run, the scenario, and every input it used.
    const calculation = await pool.query<{
      research_run_id: string;
      scenario_id: string;
      facts: number;
      assumptions: number;
    }>(
      `select cr.research_run_id, cr.scenario_id,
              count(*) filter (where i.fact_version_id is not null)::int as facts,
              count(*) filter (where i.assumption_version_id is not null)::int as assumptions
         from valuation.calculation_runs cr
         join valuation.calculation_run_inputs i on i.calculation_run_id = cr.id
        where cr.id = $1
        group by cr.id`,
      [result.calculationRunId],
    );
    expect(calculation.rows[0]).toMatchObject({
      research_run_id: runId,
      scenario_id: result.scenarioId,
    });
    expect(calculation.rows[0]!.facts).toBe(2);
    expect(calculation.rows[0]!.assumptions).toBe(4);
  });

  it('returns the thesis it already wrote instead of writing another', async () => {
    // The same run, not a fresh one: deciding promoted calculated facts, which
    // change the snapshot, so asking for a run "as of" the same date now yields
    // a different one. Re-deciding is what has to be idempotent here.
    const again = await decideWith(firstRunId, firstTransport);

    expect(again.reused).toBe(true);
    expect(again.nodeCount).toBe(3);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.thesis_versions where research_run_id = $1`,
      [firstRunId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('writes a second thesis for the same run on request, valued on the approvals it already had', async () => {
    const second = await decide(pool, { runId: firstRunId, calc, transport: firstTransport, apiKey: 'test-key', again: true });

    expect(second.reused).toBe(false);
    expect(second.calculationRunId).not.toBeNull();
    expect(second.decisions).toHaveLength(Object.keys(GOOD_ASSUMPTIONS).length);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.thesis_versions where research_run_id = $1`,
      [firstRunId],
    );
    expect(Number(rows[0]!.count)).toBe(2);
  });

  it('refuses an out-of-band assumption and writes the thesis without a valuation', async () => {
    const transport = stub({ assumptions: { ...GOOD_ASSUMPTIONS, discount_rate: 0.9 } });
    const runId = await research('2026-08-30', transport);
    const result = await decideWith(runId, transport);

    const rejected = result.decisions.filter((decision) => decision.status === 'rejected');
    expect(rejected.map((decision) => decision.code)).toEqual(['discount_rate']);
    expect(rejected[0]!.reason).toContain('outside the allowed band');

    expect(result.calculationRunId).toBeNull();
    expect(result.valuationSkipped).toContain('discount_rate');

    // The refused value is on the record as refused, not quietly dropped.
    const stored = await pool.query<{ status: string }>(
      `select av.status from valuation.assumption_versions av
         join valuation.assumptions a on a.id = av.assumption_id
         join research.claims c on c.id = av.source_claim_id
        where a.subject_id = $1 and a.code = 'discount_rate' and c.run_id = $2`,
      [companyId, runId],
    );
    expect(stored.rows[0]!.status).toBe('rejected');

    // The scenario still holds the discount rate approved earlier -- a refusal
    // withdraws the new proposal, it does not unmake the standing one -- but
    // the refused revision itself is nowhere in it.
    const scenario = await pool.query<{ count: string }>(
      `select count(*)::text as count from valuation.scenario_assumptions sa
         join valuation.scenarios s on s.id = sa.scenario_id
        where s.subject_id = $1 and sa.assumption_version_id = (
          select av.id from valuation.assumption_versions av
            join valuation.assumptions a on a.id = av.assumption_id
            join research.claims c on c.id = av.source_claim_id
           where a.subject_id = $1 and a.code = 'discount_rate' and c.run_id = $2)`,
      [companyId, runId],
    );
    expect(Number(scenario.rows[0]!.count)).toBe(0);

    const nodes = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.thesis_nodes
        where thesis_version_id = $1 and calculation_run_id is not null`,
      [result.thesisVersionId],
    );
    expect(Number(nodes.rows[0]!.count)).toBe(0);
  });

  it('refuses a thesis node citing a finding the run never produced', async () => {
    const inventing = stub({
      assumptions: GOOD_ASSUMPTIONS,
      thesis: (context) => {
        const base = defaultThesis(context) as { nodes: { claim_key?: string | null }[] };
        base.nodes[0]!.claim_key = 'a_finding_nobody_made';
        return base;
      },
    });
    const runId = await research('2026-08-29', inventing);

    await expect(decideWith(runId, inventing)).rejects.toThrow(/which this run did not produce/);

    const { rows } = await pool.query<{ count: string }>(
      `select count(*)::text as count from research.thesis_versions where research_run_id = $1`,
      [runId],
    );
    expect(Number(rows[0]!.count)).toBe(0);
  });

  it('values from the latest year\'s cash flow after capex, not an older free cash flow', async () => {
    // 2025 already has a free cash flow of 76.4M; 2026 has only the two filed lines.
    await plantFacts(
      [
        ['operating_cash_flow', 100_000_000],
        ['capital_expenditure', 40_000_000],
      ],
      2026,
    );
    let base: unknown;
    const withRatios: CalcFn = async (method, inputs, currency) => {
      if (method !== 'ratios') {
        base = inputs.base_cash_flow;
        return calc(method, inputs, currency);
      }
      const flow = (inputs.operating_cash_flow as number) - (inputs.capital_expenditure as number);
      return {
        method,
        engine: 'ratios',
        engine_version: '1.0.0',
        currency,
        inputs,
        outputs: [
          {
            code: 'free_cash_flow',
            name: 'Free cash flow',
            value: flow,
            unit: currency,
            inputs: ['operating_cash_flow', 'capital_expenditure'],
          },
        ],
        detail: {},
      };
    };

    await decide(pool, { runId: firstRunId, calc: withRatios, transport: firstTransport, apiKey: 'test-key', again: true });

    expect(base).toBe(60_000_000);
  });

  it('values nothing when the latest year has operating cash flow but no capex', async () => {
    await plantFacts([['operating_cash_flow', 120_000_000]], 2027);

    const result = await decide(pool, { runId: firstRunId, calc, transport: firstTransport, apiKey: 'test-key', again: true });

    expect(result.calculationRunId).toBeNull();
    expect(result.valuationSkipped).toMatch(/no capital_expenditure filed for the same year/);
  });

  it('bridges to equity with net debt from the latest balance carrying debt and cash', async () => {
    await plantFacts(
      [
        ['operating_cash_flow', 150_000_000],
        ['capital_expenditure', 50_000_000],
      ],
      2028,
    );
    await plantFacts(
      [
        ['total_debt', 300_000_000],
        ['cash_and_equivalents', 120_000_000],
      ],
      2028,
      'balance',
    );
    let dcfInputs: Record<string, unknown> = {};
    const engine: CalcFn = async (method, inputs, currency) => {
      if (method !== 'ratios') {
        dcfInputs = inputs;
        return calc(method, inputs, currency);
      }
      const [code, value, from] =
        'total_debt' in inputs
          ? ['net_debt', (inputs.total_debt as number) - (inputs.cash_and_equivalents as number), ['total_debt', 'cash_and_equivalents']]
          : ['free_cash_flow', (inputs.operating_cash_flow as number) - (inputs.capital_expenditure as number), ['operating_cash_flow', 'capital_expenditure']];
      return {
        method,
        engine: 'ratios',
        engine_version: '1.0.0',
        currency,
        inputs,
        outputs: [{ code, name: code, value, unit: currency, inputs: from }],
        detail: {},
      };
    };

    const result = await decide(pool, { runId: firstRunId, calc: engine, transport: firstTransport, apiKey: 'test-key', again: true });

    expect(result.calculationRunId).not.toBeNull();
    expect(dcfInputs.base_cash_flow).toBe(100_000_000);
    // Not the 35M planted for 2025: the bridge is the latest balance, 300M less 120M.
    expect(dcfInputs.net_debt).toBe(180_000_000);
  });
});
