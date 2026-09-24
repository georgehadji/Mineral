import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import { zodToJsonSchema, type Transport } from '@mineral/ai';
import { CalcResponseSchema, type CalcResponse } from '@mineral/schemas';
import {
  DCF_ASSUMPTION_CODES,
  ThesisOutputSchema,
  applyPolicy,
  validateThesis,
  type PolicyDecision,
  type PolicyInput,
  type ThesisOutput,
} from '@mineral/research';
import { inTransaction } from './client.ts';
import { callModel } from './model-repository.ts';
import { recordCalculation } from './calc-repository.ts';
import { ensureModuleDefinitions, registerPrompt, type Step } from './research-repository.ts';

/**
 * The decision layer, persistent half (report J.8).
 *
 * A completed research run leaves claims and proposed assumptions. This turns
 * that into a decision in four steps, each of which reads stored rows rather
 * than anything held in memory from the run:
 *
 *   policy     deterministic approval of proposed assumptions
 *   scenario   the approved set, held together under a name
 *   valuation  the Python engine over that set, into valuation.calculation_runs
 *   synthesis  one model call, into a thesis version with nodes and edges
 *
 * Report I.22 is the reason the first three are not modules: a module is pure
 * and may not persist, and approving an assumption or recording a calculation
 * is persistence. They are deterministic steps over the run's output instead,
 * which also means re-deciding an old run is possible without re-running it.
 *
 * `final_synthesis` is declared in the module registry but does not run in the
 * recipe DAG either, for the same reason and one more: it writes thesis rows,
 * not claims, and its declared dependencies -- contradiction_check,
 * numerical_check, source_check -- are implemented as the deterministic
 * verification pass of phase J.7, which runs over stored claims rather than as
 * three modules. The registry stays the source of DAG truth for everything the
 * recipe does contain.
 */

export class DecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecisionError';
  }
}

/** The analytics service, as a seam. Keeps the tests off the network. */
export type CalcFn = (
  method: string,
  inputs: Record<string, unknown>,
  currency: string,
) => Promise<unknown>;

export interface DecideInput {
  runId: UUID;
  step?: Step;
  transport?: Transport;
  apiKey?: string;
  cacheOnly?: boolean;
  calc?: CalcFn;
  analyticsUrl?: string;
}

export interface DecideResult {
  runId: UUID;
  thesisVersionId: UUID;
  versionNo: number;
  verdict: string;
  confidence: number;
  decisions: PolicyDecision[];
  scenarioId: UUID | null;
  calculationRunId: UUID | null;
  /** Why no valuation was produced, when none was. */
  valuationSkipped: string | null;
  nodeCount: number;
  edgeCount: number;
  /** True when this run already had a thesis and it was returned untouched. */
  reused: boolean;
}

const inlineStep: Step = (_name, fn) => fn();

const SYNTHESIS_PROMPT_VERSION = '1.0.0';

/** Facts a DCF may draw on, in the order a base cash flow is preferred. */
const BASE_CASH_FLOW_CODES = ['free_cash_flow', 'operating_cash_flow'];
const OPTIONAL_FACT_CODES = ['net_debt', 'shares_outstanding'];

// --- loading ----------------------------------------------------------------

interface RunRow {
  subjectId: UUID;
  asOfDate: string;
  legalName: string;
  commonName: string | null;
}

async function loadRun(pool: Pool, runId: UUID): Promise<RunRow> {
  const { rows } = await pool.query<{
    subject_id: string;
    as_of_date: string;
    status: string;
    legal_name: string;
    common_name: string | null;
  }>(
    `select r.subject_id, r.as_of_date::text, r.status, c.legal_name, c.common_name
       from research.runs r
       join core.companies c on c.id = r.subject_id
      where r.id = $1`,
    [runId],
  );
  const row = rows[0];
  if (!row) throw new DecisionError(`no research run ${runId}`);
  if (row.status !== 'completed') {
    throw new DecisionError(`run ${runId} is ${row.status}; a decision needs a completed run`);
  }
  return {
    subjectId: row.subject_id,
    asOfDate: row.as_of_date,
    legalName: row.legal_name,
    commonName: row.common_name,
  };
}

interface ProposalRow extends PolicyInput {
  assumptionVersionId: UUID;
  assumptionId: UUID;
  name: string;
}

/**
 * The latest proposal per assumption that rests on a claim from this run. The
 * join is inner on purpose: a proposal with no source claim has no run to
 * belong to, and the runtime refuses to write one in the first place.
 */
async function loadProposals(pool: Pool, runId: UUID): Promise<ProposalRow[]> {
  const { rows } = await pool.query<{
    id: string;
    assumption_id: string;
    code: string;
    name: string;
    value: number;
    min_value: number | null;
    max_value: number | null;
    rationale: string | null;
    epistemic_status: string;
  }>(
    `select distinct on (a.id)
            av.id, a.id as assumption_id, a.code, a.name,
            av.value_numeric::float8 as value,
            av.min_value::float8, av.max_value::float8,
            av.rationale, c.epistemic_status
       from valuation.assumption_versions av
       join valuation.assumptions a on a.id = av.assumption_id
       join research.claims c on c.id = av.source_claim_id
      where c.run_id = $1 and av.status = 'proposed'
      order by a.id, av.version_no desc`,
    [runId],
  );
  return rows.map((row) => ({
    assumptionVersionId: row.id,
    assumptionId: row.assumption_id,
    code: row.code,
    name: row.name,
    value: row.value,
    minValue: row.min_value,
    maxValue: row.max_value,
    rationale: row.rationale,
    sourceClaimStatus: row.epistemic_status,
  }));
}

interface FactRow {
  code: string;
  factVersionId: UUID;
  value: number;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  asOfDate: string | null;
}

async function loadValuationFacts(pool: Pool, subjectId: UUID): Promise<Map<string, FactRow>> {
  const codes = [...BASE_CASH_FLOW_CODES, ...OPTIONAL_FACT_CODES];
  const { rows } = await pool.query<{
    code: string;
    fact_version_id: string;
    value: number;
    currency: string | null;
    period_start: string | null;
    period_end: string | null;
    as_of_date: string | null;
  }>(
    `select distinct on (fd.code)
            fd.code, fv.id as fact_version_id, fv.numeric_value::float8 as value, fv.currency,
            f.period_start::text, f.period_end::text, f.as_of_date::text
       from evidence.facts f
       join evidence.fact_definitions fd on fd.id = f.fact_definition_id
       join evidence.fact_versions fv on fv.id = f.current_version_id
      where f.entity_id = $1 and fv.numeric_value is not null and fd.code = any($2::text[])
      order by fd.code, f.period_end desc nulls last, f.as_of_date desc nulls last`,
    [subjectId, codes],
  );
  return new Map(
    rows.map((row) => [
      row.code,
      {
        code: row.code,
        factVersionId: row.fact_version_id,
        value: row.value,
        currency: row.currency,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        asOfDate: row.as_of_date,
      },
    ]),
  );
}

interface FindingRow {
  claimId: UUID;
  claimKey: string;
  claimType: string;
  statement: string;
  status: string;
  evidenceCount: number;
}

/**
 * What the synthesis is allowed to build on. CONTRADICTED claims are left out:
 * verification already ruled on them, and a thesis that quietly reuses one is
 * the failure the verification pass exists to prevent.
 */
async function loadFindings(pool: Pool, runId: UUID): Promise<FindingRow[]> {
  const { rows } = await pool.query<{
    id: string;
    claim_key: string;
    claim_type: string;
    statement: string;
    epistemic_status: string;
    evidence_count: number;
  }>(
    `select c.id, c.claim_key, c.claim_type, c.statement, c.epistemic_status,
            count(ce.id)::int as evidence_count
       from research.claims c
       left join research.claim_evidence ce on ce.claim_id = c.id
      where c.run_id = $1 and c.epistemic_status <> 'CONTRADICTED'
      group by c.id
      order by c.claim_key`,
    [runId],
  );
  return rows.map((row) => ({
    claimId: row.id,
    claimKey: row.claim_key,
    claimType: row.claim_type,
    statement: row.statement,
    status: row.epistemic_status,
    evidenceCount: row.evidence_count,
  }));
}

// --- policy -----------------------------------------------------------------

async function recordPolicy(
  pool: Pool,
  proposals: readonly ProposalRow[],
  decisions: readonly PolicyDecision[],
): Promise<void> {
  const byCode = new Map(decisions.map((decision) => [decision.code, decision]));
  for (const proposal of proposals) {
    const decision = byCode.get(proposal.code);
    if (!decision) continue;
    if (decision.status === 'approved') {
      await pool.query(
        `update valuation.assumption_versions
            set status = 'approved', approved_by = 'policy', approved_at = now()
          where id = $1`,
        [proposal.assumptionVersionId],
      );
    } else {
      await pool.query(
        `update valuation.assumption_versions set status = 'rejected' where id = $1`,
        [proposal.assumptionVersionId],
      );
    }
  }
}

/**
 * The approved set under a name. One scenario per subject for now, called
 * `base`; alternatives are the scenario_model module's business, and that needs
 * more than one valuation method to compare (report J.11).
 */
async function ensureScenario(
  pool: Pool,
  subjectId: UUID,
  approved: readonly ProposalRow[],
  asOfDate: string,
): Promise<UUID> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into valuation.scenarios (subject_type, subject_id, name, description)
     values ('company', $1, 'base', $2)
     on conflict (subject_id, name) do update set description = excluded.description
     returning id`,
    [subjectId, `Policy-approved assumptions as of ${asOfDate}`],
  );
  const scenarioId = rows[0]?.id;
  if (!scenarioId) throw new DecisionError('could not open the base scenario');

  for (const proposal of approved) {
    // The trigger on this table refuses anything not already approved, which is
    // why the update above happens first.
    await pool.query(
      `insert into valuation.scenario_assumptions
         (scenario_id, assumption_id, assumption_version_id)
       values ($1, $2, $3)
       on conflict (scenario_id, assumption_id)
         do update set assumption_version_id = excluded.assumption_version_id`,
      [scenarioId, proposal.assumptionId, proposal.assumptionVersionId],
    );
  }
  return scenarioId;
}

// --- valuation --------------------------------------------------------------

function httpCalc(baseUrl: string): CalcFn {
  return async (method, inputs, currency) => {
    const response = await fetch(`${baseUrl}/calc/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ inputs, currency }),
    }).catch((error: Error) => {
      throw new DecisionError(
        `the analytics service at ${baseUrl} is not answering (${error.message}); start it with pnpm analytics`,
      );
    });
    const body: unknown = await response.json();
    if (!response.ok) {
      const detail = (body as { detail?: unknown }).detail ?? body;
      throw new DecisionError(`${method} failed: ${JSON.stringify(detail)}`);
    }
    return body;
  };
}

interface ValuationOutcome {
  calculationRunId: UUID | null;
  response: CalcResponse | null;
  skipped: string | null;
}

/**
 * One DCF over the approved set. Every number the engine receives is either an
 * approved assumption or a promoted fact revision, and the run records which
 * was which, so "why is it worth this" is answerable by query rather than by
 * reading a prompt.
 */
async function runValuation(
  pool: Pool,
  params: {
    subjectId: UUID;
    runId: UUID;
    scenarioId: UUID;
    approved: readonly ProposalRow[];
    calc: CalcFn;
  },
): Promise<ValuationOutcome> {
  const byCode = new Map(params.approved.map((proposal) => [proposal.code, proposal]));
  const missing = DCF_ASSUMPTION_CODES.filter((code) => !byCode.has(code));
  if (missing.length > 0) {
    return { calculationRunId: null, response: null, skipped: `policy approved no ${missing.join(', ')}` };
  }

  const facts = await loadValuationFacts(pool, params.subjectId);
  const baseCode = BASE_CASH_FLOW_CODES.find((code) => facts.has(code));
  const base = baseCode ? facts.get(baseCode)! : undefined;
  if (!base) {
    return {
      calculationRunId: null,
      response: null,
      skipped: `no promoted ${BASE_CASH_FLOW_CODES.join(' or ')} fact to project from`,
    };
  }

  const years = byCode.get('projection_years')!.value;
  const growth = byCode.get('growth_rate')!.value;
  const inputs: Record<string, unknown> = {
    base_cash_flow: base.value,
    // The engine takes one rate per projected year. Repeating a single approved
    // rate is expansion, not arithmetic: no new number is invented.
    growth_rates: Array.from({ length: years }, () => growth),
    discount_rate: byCode.get('discount_rate')!.value,
    terminal_growth: byCode.get('terminal_growth')!.value,
  };
  const inputFactVersions: Record<string, UUID> = { base_cash_flow: base.factVersionId };
  for (const code of OPTIONAL_FACT_CODES) {
    const fact = facts.get(code);
    if (!fact) continue;
    inputs[code] = fact.value;
    inputFactVersions[code] = fact.factVersionId;
  }

  const response = CalcResponseSchema.parse(
    await params.calc('dcf', inputs, base.currency ?? 'USD'),
  );
  const recorded = await recordCalculation(pool, {
    subjectEntityId: params.subjectId,
    response,
    inputFactVersions,
    inputAssumptionVersions: Object.fromEntries(
      params.approved.map((proposal) => [proposal.code, proposal.assumptionVersionId]),
    ),
    period: {
      periodStart: base.periodStart,
      periodEnd: base.periodEnd,
      asOfDate: base.asOfDate,
    },
    researchRunId: params.runId,
    scenarioId: params.scenarioId,
  });
  return { calculationRunId: recorded.calculationRunId, response, skipped: null };
}

// --- synthesis --------------------------------------------------------------

const SYNTHESIS_SYSTEM =
  'You write the investment thesis for one company from findings that are already evidenced, ' +
  'assumptions that are already approved, and a valuation that is already computed. You add no ' +
  'facts and no numbers of your own.\n' +
  'Every node that asserts something names what it rests on: claim_key for a finding, ' +
  'assumption_code for an approved assumption, from_valuation for the calculated valuation. ' +
  'Copy those identifiers exactly; a node naming something that is not listed is rejected.\n' +
  'Set from_valuation only when a valuation appears below. When none was produced, that absence ' +
  'is worth saying, but say it on a CONCLUSION node: a node claiming to rest on a valuation ' +
  'that does not exist is rejected like any other dangling reference.\n' +
  'Include at least one CONCLUSION node and connect the graph with edges. Say ' +
  'insufficient_evidence when the findings do not support a direction: that is a real verdict ' +
  'here, not a failure.';

function renderFindings(findings: readonly FindingRow[]): string {
  return findings
    .map(
      (finding) =>
        `[claim_key: ${finding.claimKey}] (${finding.status}, ${finding.evidenceCount} citation` +
        `${finding.evidenceCount === 1 ? '' : 's'}) ${finding.statement}`,
    )
    .join('\n');
}

function renderAssumptions(approved: readonly ProposalRow[]): string {
  if (approved.length === 0) return 'Policy approved no assumptions.';
  return approved
    .map(
      (proposal) =>
        `[assumption_code: ${proposal.code}] ${proposal.name} = ${proposal.value}` +
        `${proposal.rationale ? ` -- ${proposal.rationale}` : ''}`,
    )
    .join('\n');
}

function renderValuation(outcome: ValuationOutcome): string {
  if (!outcome.response) return `No valuation was produced: ${outcome.skipped}.`;
  return (
    `Method ${outcome.response.method}, engine ${outcome.response.engine} ` +
    `${outcome.response.engine_version}, currency ${outcome.response.currency}\n` +
    outcome.response.outputs
      .map((output) => `- ${output.name}: ${output.value} ${output.unit}`)
      .join('\n')
  );
}

/**
 * The synthesis prompt is registered like a module's, so a stored model run
 * names the exact text that produced it. The definition row it hangs off is
 * the one the registry already declares for final_synthesis.
 */
async function ensureSynthesisPrompt(pool: Pool): Promise<UUID | null> {
  const definitionIds = await ensureModuleDefinitions(pool);
  const definitionId = definitionIds.get('final_synthesis');
  if (!definitionId) return null;

  const responseSchema = JSON.stringify(zodToJsonSchema(ThesisOutputSchema));
  return registerPrompt(pool, definitionId, SYNTHESIS_PROMPT_VERSION, SYNTHESIS_SYSTEM, responseSchema);
}

async function persistThesis(
  client: PoolClient,
  params: {
    subjectId: UUID;
    runId: UUID;
    output: ThesisOutput;
    claimIds: ReadonlyMap<string, UUID>;
    assumptionVersionIds: ReadonlyMap<string, UUID>;
    calculationRunId: UUID | null;
  },
): Promise<{ thesisVersionId: UUID; versionNo: number }> {
  // version_no is assigned by the trigger, which locks core.entities first.
  const { rows } = await client.query<{ id: string; version_no: number }>(
    `insert into research.thesis_versions
       (subject_type, subject_id, version_no, verdict, summary, confidence, research_run_id)
     values ('company', $1, 0, $2, $3, $4, $5)
     returning id, version_no`,
    [
      params.subjectId,
      params.output.verdict,
      params.output.summary,
      params.output.confidence,
      params.runId,
    ],
  );
  const thesis = rows[0];
  if (!thesis) throw new DecisionError('could not write the thesis version');

  const nodeIds = new Map<string, UUID>();
  for (const node of params.output.nodes) {
    const { rows: nodeRows } = await client.query<{ id: string }>(
      `insert into research.thesis_nodes
         (thesis_version_id, node_type, statement, claim_id, assumption_version_id,
          calculation_run_id, confidence)
       values ($1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [
        thesis.id,
        node.node_type,
        node.statement,
        node.claim_key ? params.claimIds.get(node.claim_key) ?? null : null,
        node.assumption_code ? params.assumptionVersionIds.get(node.assumption_code) ?? null : null,
        node.from_valuation ? params.calculationRunId : null,
        node.confidence,
      ],
    );
    const nodeId = nodeRows[0]?.id;
    if (!nodeId) throw new DecisionError(`could not write thesis node ${node.key}`);
    nodeIds.set(node.key, nodeId);
  }

  for (const edge of params.output.edges) {
    await client.query(
      `insert into research.thesis_edges (from_node_id, edge_type, to_node_id)
       values ($1, $2, $3) on conflict do nothing`,
      [nodeIds.get(edge.from), edge.edge_type, nodeIds.get(edge.to)],
    );
  }
  return { thesisVersionId: thesis.id, versionNo: thesis.version_no };
}

// --- orchestration ----------------------------------------------------------

export async function decide(pool: Pool, input: DecideInput): Promise<DecideResult> {
  const step = input.step ?? inlineStep;
  const calc =
    input.calc ?? httpCalc(input.analyticsUrl ?? process.env.ANALYTICS_URL ?? 'http://127.0.0.1:8000');

  const run = await loadRun(pool, input.runId);

  const existing = await pool.query<{ id: string; version_no: number; verdict: string; confidence: string | null }>(
    `select id, version_no, verdict, confidence::text
       from research.thesis_versions where research_run_id = $1
      order by version_no desc limit 1`,
    [input.runId],
  );
  if (existing.rows[0]) {
    const thesis = existing.rows[0];
    const counts = await pool.query<{ nodes: string; edges: string }>(
      `select (select count(*) from research.thesis_nodes where thesis_version_id = $1)::text as nodes,
              (select count(*) from research.thesis_edges e
                 join research.thesis_nodes n on n.id = e.from_node_id
                where n.thesis_version_id = $1)::text as edges`,
      [thesis.id],
    );
    return {
      runId: input.runId,
      thesisVersionId: thesis.id,
      versionNo: thesis.version_no,
      verdict: thesis.verdict,
      confidence: Number(thesis.confidence ?? 0),
      decisions: [],
      scenarioId: null,
      calculationRunId: null,
      valuationSkipped: null,
      nodeCount: Number(counts.rows[0]?.nodes ?? 0),
      edgeCount: Number(counts.rows[0]?.edges ?? 0),
      reused: true,
    };
  }

  const proposals = await loadProposals(pool, input.runId);
  const decisions = await step('assumption-policy', async () => {
    const verdicts = applyPolicy(proposals);
    await recordPolicy(pool, proposals, verdicts);
    return verdicts;
  });
  const approvedCodes = new Set(
    decisions.filter((decision) => decision.status === 'approved').map((decision) => decision.code),
  );
  const approved = proposals.filter((proposal) => approvedCodes.has(proposal.code));

  const scenarioId =
    approved.length === 0
      ? null
      : await step('scenario', () => ensureScenario(pool, run.subjectId, approved, run.asOfDate));

  const valuation: ValuationOutcome = scenarioId
    ? await step('valuation-calc', () =>
        runValuation(pool, {
          subjectId: run.subjectId,
          runId: input.runId,
          scenarioId,
          approved,
          calc,
        }),
      )
    : { calculationRunId: null, response: null, skipped: 'policy approved no assumptions' };

  const findings = await loadFindings(pool, input.runId);
  // Report I.23 again, one layer up: a thesis written over nothing evidenced is
  // the same laundering as a run over no evidence, with more authority on it.
  if (!findings.some((finding) => finding.status !== 'UNKNOWN' && finding.evidenceCount > 0)) {
    throw new DecisionError(
      `nothing to conclude for ${run.legalName}: run ${input.runId} left no evidenced finding standing`,
    );
  }

  const output = await step('final-synthesis', async () => {
    const promptVersionId = await ensureSynthesisPrompt(pool);
    const result = await callModel(pool, {
      task: 'synthesis',
      system: SYNTHESIS_SYSTEM,
      user:
        `Subject: ${run.legalName}` +
        `${run.commonName && run.commonName !== run.legalName ? ` (${run.commonName})` : ''}` +
        `, as of ${run.asOfDate}\n\n` +
        `Findings:\n${renderFindings(findings)}\n\n` +
        `Approved assumptions:\n${renderAssumptions(approved)}\n\n` +
        `Valuation:\n${renderValuation(valuation)}`,
      schema: ThesisOutputSchema,
      researchRunId: input.runId,
      promptVersionId,
      transport: input.transport,
      apiKey: input.apiKey,
      cacheOnly: input.cacheOnly,
    });
    return validateThesis(result.value, {
      claimKeys: new Set(findings.map((finding) => finding.claimKey)),
      assumptionCodes: approvedCodes,
      hasValuation: valuation.calculationRunId !== null,
    });
  });

  // First claim wins where two modules chose the same key; the synthesis cites
  // a finding, and two identical keys are two statements of one finding.
  const claimIds = new Map<string, UUID>();
  for (const finding of findings) {
    if (!claimIds.has(finding.claimKey)) claimIds.set(finding.claimKey, finding.claimId);
  }

  const written = await inTransaction(pool, (client) =>
    persistThesis(client, {
      subjectId: run.subjectId,
      runId: input.runId,
      output,
      claimIds,
      assumptionVersionIds: new Map(
        approved.map((proposal) => [proposal.code, proposal.assumptionVersionId]),
      ),
      calculationRunId: valuation.calculationRunId,
    }),
  );

  return {
    runId: input.runId,
    thesisVersionId: written.thesisVersionId,
    versionNo: written.versionNo,
    verdict: output.verdict,
    confidence: output.confidence,
    decisions,
    scenarioId,
    calculationRunId: valuation.calculationRunId,
    valuationSkipped: valuation.skipped,
    nodeCount: output.nodes.length,
    edgeCount: output.edges.length,
    reused: false,
  };
}
