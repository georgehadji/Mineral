/**
 * Integration test. Needs a PostgreSQL database with the migrations and the
 * issuer seed applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.10 gate: a 10-Q lands, and an alert fires carrying the
 * reference to the row that caused it. The other rules are checked the same
 * way -- a promoted revision displaces the number an approved assumption was
 * founded on, and a later calculation moves the valuation the thesis was
 * written against -- because a monitor that only notices new documents is a
 * feed reader, not a watch on a thesis.
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
import { driftReport, ensureAlertRules, monitor } from './monitoring-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('monitoring', () => {
  let pool: Pool;
  let companyId: string;
  let userId: string;
  let documentId: string;
  let documentVersionId: string;
  let sourceId: string;
  let cashFlowFactId: string;
  let cashFlowVersionId: string;

  const run = randomUUID().slice(0, 8);
  const SOURCE_PREFIX = 'monitor-test-source-';
  const EMAIL = `monitor-${run}@localhost.invalid`;

  const MARKER =
    'The Company generated 91,300,000 of cash from operations during the year ended December 31, 2025.';
  const DEBT_LINE =
    'Borrowings outstanding at year end were 18,000,000 at a weighted average rate of 8.5 percent.';
  const CHUNK_TEXT =
    'The Nolans project is the company only rare earth asset in development. ' +
    MARKER +
    ' ' +
    DEBT_LINE;

  const ASSUMPTIONS: Record<string, number> = {
    discount_rate: 0.11,
    terminal_growth: 0.025,
    growth_rate: 0.05,
    projection_years: 5,
  };

  const MODULE_MARKERS: [string, string][] = [
    ['Describe what this company does', 'company_profile'],
    ['How does this company earn revenue', 'business_model'],
    ['Assess financial quality', 'financial_quality'],
    ['Which commodities does this company', 'commodity_exposure'],
    ['How is this company funded', 'capital_structure'],
    ['Propose these inputs', 'valuation_assumptions'],
  ];

  const DRIVER_QUOTE = 'The Nolans project is the company only rare earth asset in development.';
  const DRIVER_KEY = `sole_asset_${run}`;
  const VALUE_CODE = `dcf_equity_value_${run}`;

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

  /** The revision of free cash flow this run was allowed to see. */
  function citedFactVersionId(prompt: string): string {
    const found = prompt.match(/\[fact_version_id: ([0-9a-f-]{36})\][^\n]*\(free_cash_flow\)/);
    if (!found) throw new Error('free cash flow is not in this prompt');
    return found[1]!;
  }

  /**
   * The assumptions module founds its claims on the promoted figure rather than
   * on prose. That is what makes the assumption rule testable at all: an
   * assumption resting on a number can be undone by that number moving, and an
   * assumption resting only on a sentence cannot.
   */
  const transport: Transport = async (_url, init) => {
    const request = JSON.parse(init.body) as { messages: { content: string }[] };
    const prompt = request.messages.map((message) => message.content).join('\n');

    if (prompt.includes('You write the investment thesis')) {
      const approved = [...prompt.matchAll(/\[assumption_code: (\w+)\]/g)].map((m) => m[1]!);
      const hasValuation = !prompt.includes('No valuation was produced');
      return toolReply({
        verdict: 'bullish',
        summary: 'One project, one approved rate, and filings that carry both.',
        confidence: 0.6,
        nodes: [
          {
            key: 'driver',
            node_type: 'DRIVER',
            statement: 'Development rests on a single rare earth project.',
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
            statement: 'The computed equity value is above what the market pays.',
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

    if (code !== 'valuation_assumptions') {
      return toolReply({
        claims: [
          {
            claim_key: code === 'company_profile' ? DRIVER_KEY : `${code}_finding_${run}`,
            claim_type: 'business_fact',
            statement: 'The company holds one rare earth project in development.',
            status: 'DERIVED',
            confidence: 0.9,
            evidence: [
              {
                chunk_id: citedChunkId(prompt),
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

    const factVersionId = citedFactVersionId(prompt);
    return toolReply({
      claims: Object.keys(ASSUMPTION_BANDS).map((assumptionCode) => ({
        claim_key: `${assumptionCode}_basis_${run}`,
        claim_type: 'metric',
        statement: `Evidence bearing on ${assumptionCode}.`,
        status: 'DERIVED',
        confidence: 0.8,
        evidence: [
          {
            chunk_id: null,
            fact_version_id: factVersionId,
            quote: null,
            role: 'supports',
            strength: 0.8,
          },
        ],
      })),
      assumptions: Object.entries(ASSUMPTIONS).map(([assumptionCode, value]) => ({
        code: assumptionCode,
        name: assumptionCode.replace(/_/g, ' '),
        value,
        unit: ASSUMPTION_BANDS[assumptionCode]?.unit ?? null,
        min_value: null,
        max_value: null,
        rationale: 'Read off the promoted cash flow.',
        source_claim_key: `${assumptionCode}_basis_${run}`,
      })),
    });
  };

  const calc: CalcFn = async (method, inputs, currency) => ({
    method,
    engine: 'dcf',
    engine_version: '1.0.0',
    currency,
    inputs,
    outputs: [
      {
        code: VALUE_CODE,
        name: 'DCF equity value',
        value: 1_000_000_000,
        unit: currency,
        inputs: ['base_cash_flow', 'growth_rates', 'discount_rate', 'terminal_growth', 'net_debt'],
      },
    ],
    detail: {},
  });

  async function purge(): Promise<void> {
    const forSubject = (sql: string) => pool.query(sql, [companyId]);

    await forSubject(`delete from monitoring.alert_events where alert_rule_id in (
      select id from monitoring.alert_rules where entity_id = $1)`);
    await forSubject(`delete from monitoring.alert_rules where entity_id = $1`);

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

    await pool.query(`delete from core.users where email like $1`, ['monitor-%@localhost.invalid']);
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
        if (code === 'free_cash_flow') {
          cashFlowFactId = factId;
          cashFlowVersionId = rows[0]!.id;
        }
      }
    });
  }

  /** A second filing about the same company, as a quarterly re-ingest leaves it. */
  async function ingestQuarterly(): Promise<string> {
    const document = await pool.query<{ id: string }>(
      `insert into evidence.documents (source_id, external_id, document_type, title, published_at)
       values ($1, $2, '10-Q', $3, now()) returning id`,
      [sourceId, `monitor-10q-${run}`, `Quarterly report (monitor ${run})`],
    );
    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [document.rows[0]!.id, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [document.rows[0]!.id, `monitor-10q-hash-${run}`, 'Revenue fell in the third quarter.'],
    );
    return version.rows[0]!.id;
  }

  beforeAll(async () => {
    pool = createPool(url);

    // A seventh issuer: the other database suites own MP, USA Rare Earth,
    // NioCorp, Energy Fuels and Critical Metals, Lynas is kept empty on
    // purpose, and vitest runs the files in parallel.
    const outcome = await resolveCompany(pool, 'Arafura');
    if (outcome.status !== 'resolved') throw new Error('seed 001 is missing Arafura');
    companyId = outcome.company.companyId;

    await purge();

    const user = await pool.query<{ id: string }>(
      `insert into core.users (email) values ($1) returning id`,
      [EMAIL],
    );
    userId = user.rows[0]!.id;

    const source = await pool.query<{ id: string }>(
      `insert into evidence.sources (source_name, source_type, source_tier, publisher)
       values ($1, 'filing', 1, 'Test') returning id`,
      [`${SOURCE_PREFIX}${run}`],
    );
    sourceId = source.rows[0]!.id;

    const document = await pool.query<{ id: string }>(
      `insert into evidence.documents (source_id, external_id, document_type, title, published_at)
       values ($1, $2, '10-K', $3, now()) returning id`,
      [sourceId, `monitor-10k-${run}`, `Annual report (monitor ${run})`],
    );
    documentId = document.rows[0]!.id;
    await pool.query(
      `insert into evidence.document_subjects (document_id, entity_id, role) values ($1, $2, 'issuer')`,
      [documentId, companyId],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [documentId, `monitor-hash-${run}`, CHUNK_TEXT],
    );
    documentVersionId = version.rows[0]!.id;
    await pool.query(
      `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
       values ($1, 0, $2)`,
      [documentVersionId, CHUNK_TEXT],
    );

    await plantFacts();

    const result = await runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      asOfDate: '2026-06-30',
      transport,
      apiKey: 'test-key',
    });
    await decide(pool, { runId: result.runId, calc, transport, apiKey: 'test-key' });

    await ensureAlertRules(pool, { userId, companyId });
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await purge();
    await pool.end();
  });

  it('creates the rules it knows how to evaluate, once', async () => {
    const again = await ensureAlertRules(pool, { userId, companyId });
    expect(again.map((rule) => rule.ruleType).sort()).toEqual([
      'assumption_invalidated',
      'new_primary_source',
      'valuation_threshold',
    ]);
  });

  it('says nothing about a company that has no thesis to drift from', async () => {
    const lynas = await resolveCompany(pool, 'Lynas');
    if (lynas.status !== 'resolved') throw new Error('seed 001 is missing Lynas');
    const report = await driftReport(pool, lynas.company.companyId);
    expect(report.thesis).toBeNull();
    expect(report.newSources).toEqual([]);
    expect(report.affected).toEqual([]);
  });

  it('is quiet while nothing has moved', async () => {
    const { report, created } = await monitor(pool, companyId);
    expect(report.thesis?.verdict).toBe('bullish');
    expect(report.newSources).toEqual([]);
    expect(report.affected).toEqual([]);
    expect(created).toEqual([]);
  });

  // The phase gate.
  it('fires an alert carrying the trigger reference when a 10-Q lands', async () => {
    const quarterlyVersionId = await ingestQuarterly();

    const { report, created } = await monitor(pool, companyId);
    expect(report.newSources.map((source) => source.documentVersionId)).toEqual([quarterlyVersionId]);

    const alert = created.find((entry) => entry.finding.eventType === 'new_primary_source');
    expect(alert).toBeDefined();
    expect(alert!.finding).toMatchObject({
      severity: 'warning',
      triggerRefType: 'document_version',
      triggerRefId: quarterlyVersionId,
    });

    const stored = await pool.query<{
      event_type: string;
      severity: string;
      trigger_ref_type: string;
      trigger_ref_id: string;
    }>(
      `select event_type, severity, trigger_ref_type, trigger_ref_id
         from monitoring.alert_events where id = $1`,
      [alert!.alertEventId],
    );
    expect(stored.rows[0]).toEqual({
      event_type: 'new_primary_source',
      severity: 'warning',
      trigger_ref_type: 'document_version',
      trigger_ref_id: quarterlyVersionId,
    });
  });

  it('reports the same drift again without writing the alert twice', async () => {
    const before = await pool.query<{ count: string }>(
      `select count(*) from monitoring.alert_events where alert_rule_id in (
         select id from monitoring.alert_rules where entity_id = $1)`,
      [companyId],
    );
    const { report, findings, created } = await monitor(pool, companyId);
    expect(report.newSources.length).toBe(1);
    expect(findings.length).toBeGreaterThan(0);
    expect(created).toEqual([]);
    const after = await pool.query<{ count: string }>(
      `select count(*) from monitoring.alert_events where alert_rule_id in (
         select id from monitoring.alert_rules where entity_id = $1)`,
      [companyId],
    );
    expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
  });

  it('invalidates an assumption when the figure it was founded on moves', async () => {
    const promoted = await inTransaction(pool, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `insert into evidence.fact_versions
           (fact_id, numeric_value, unit, currency, observed_at, extraction_method,
            source_document_version_id)
         values ($1, $2::numeric, 'USD', 'USD', now(), 'xbrl', $3)
         returning id`,
        [cashFlowFactId, '70000000', documentVersionId],
      );
      await client.query(`select evidence.promote_fact_version($1, 'system')`, [rows[0]!.id]);
      return rows[0]!.id;
    });

    const { report, created } = await monitor(pool, companyId);

    const node = report.affected.find((entry) => entry.assumptionCode === 'discount_rate');
    expect(node).toBeDefined();
    expect(node!.reasons).toContainEqual({
      kind: 'fact_moved',
      triggerRefType: 'fact_version',
      triggerRefId: promoted,
      citedFactVersionId: cashFlowVersionId,
      code: 'free_cash_flow',
      from: 91_300_000,
      to: 70_000_000,
    });

    const alert = created.find(
      (entry) =>
        entry.finding.eventType === 'assumption_invalidated' &&
        entry.finding.payload.assumptionCode === 'discount_rate',
    );
    expect(alert).toBeDefined();
    expect(alert!.finding.triggerRefId).toBe(promoted);
    expect(alert!.finding.severity).toBe('warning');
  });

  it('reports a superseded filing as drift without calling it an assumption', async () => {
    await pool.query(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 2, $2, $3)`,
      [documentId, `monitor-hash-amended-${run}`, `${CHUNK_TEXT} As amended.`],
    );

    const { report, created } = await monitor(pool, companyId);

    const driver = report.affected.find((node) => node.nodeType === 'DRIVER');
    expect(driver).toBeDefined();
    expect(driver!.reasons.map((reason) => reason.kind)).toContain('document_superseded');
    expect(driver!.assumptionVersionId).toBeNull();

    // Assumption nodes cite the figure, not the prose, so an amended filing is
    // drift to read about rather than an invalidated input. It is still a
    // primary source the thesis never saw, and that rule does fire.
    expect(
      created.filter((entry) => entry.finding.eventType === 'assumption_invalidated'),
    ).toEqual([]);
    expect(created.map((entry) => entry.finding.eventType)).toEqual(['new_primary_source']);
  });

  it('fires when the valuation moves past the threshold since the thesis', async () => {
    const moved = await pool.query<{ id: string }>(
      `insert into valuation.calculation_runs
         (subject_type, subject_id, method, engine, engine_version, status,
          input_snapshot, output, calculated_at)
       values ('company', $1, 'dcf', 'dcf', '1.0.0', 'completed',
               $2::jsonb, $3::jsonb, now())
       returning id`,
      [
        companyId,
        JSON.stringify({ currency: 'USD', inputs: { discount_rate: 0.14 } }),
        JSON.stringify({
          outputs: [
            { code: VALUE_CODE, name: 'DCF equity value', value: 700_000_000, unit: 'USD' },
          ],
          detail: {},
        }),
      ],
    );

    const { report, created } = await monitor(pool, companyId);

    expect(report.valuation).toMatchObject({
      method: 'dcf',
      latestCalculationRunId: moved.rows[0]!.id,
    });
    const move = report.valuation!.moves.find((entry) => entry.code === VALUE_CODE);
    expect(move).toMatchObject({ from: 1_000_000_000, to: 700_000_000 });
    expect(move!.changePct).toBeCloseTo(-0.3, 6);

    const alert = created.find((entry) => entry.finding.eventType === 'valuation_threshold');
    expect(alert).toBeDefined();
    expect(alert!.finding).toMatchObject({
      severity: 'critical',
      triggerRefType: 'calculation_run',
      triggerRefId: moved.rows[0]!.id,
    });
  });
});
