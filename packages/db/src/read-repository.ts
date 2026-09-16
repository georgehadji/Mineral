import type { Pool } from 'pg';
import type { UUID } from '@mineral/domain';

/**
 * Read models (report J.9).
 *
 * Invariant C.9: a report is a read model, never source of truth. Nothing in
 * this file writes, and nothing in it computes a number that is not already
 * stored. Every figure on a company page is read back from the row that
 * recorded it, so a page can be stale but it cannot disagree with the record.
 *
 * That rule is also why the shapes here are wide and flat. A page that has to
 * join two of these together in the browser would be doing analysis, and
 * analysis belongs upstream where it is versioned and recorded.
 */

// --- shared shapes ----------------------------------------------------------

export interface Listing {
  ticker: string;
  mic: string;
}

export interface CompanySummary {
  companyId: UUID;
  legalName: string;
  commonName: string | null;
  countryCode: string | null;
  website: string | null;
  listings: Listing[];
  /** The latest thesis, when one exists. Null all the way down when none does. */
  thesisVersionNo: number | null;
  verdict: string | null;
  confidence: number | null;
  thesisAt: string | null;
}

export type ThesisAnchor =
  | { kind: 'claim'; claimId: UUID; claimKey: string; status: string }
  | { kind: 'assumption'; assumptionVersionId: UUID; code: string; value: number | null }
  | { kind: 'valuation'; calculationRunId: UUID }
  | null;

export interface ThesisNodeView {
  nodeId: UUID;
  nodeType: string;
  statement: string;
  confidence: number | null;
  anchor: ThesisAnchor;
}

export interface ThesisEdgeView {
  fromNodeId: UUID;
  edgeType: string;
  toNodeId: UUID;
}

export interface ThesisView {
  thesisVersionId: UUID;
  versionNo: number;
  verdict: string;
  summary: string;
  confidence: number | null;
  createdAt: string;
  researchRunId: UUID;
  asOfDate: string;
}

export interface AssumptionView {
  assumptionId: UUID;
  assumptionVersionId: UUID;
  versionNo: number;
  code: string;
  name: string;
  unit: string | null;
  value: number | null;
  minValue: number | null;
  maxValue: number | null;
  rationale: string | null;
  status: string;
  proposedBy: string;
  approvedBy: string | null;
  approvedAt: string | null;
  sourceClaimId: UUID | null;
  sourceClaimKey: string | null;
  /** True when this exact revision is the one the base scenario holds. */
  inScenario: boolean;
}

export interface ValuationOutputView {
  code: string;
  name: string;
  value: number;
  unit: string;
  /** The range this figure has taken across every run of the same method. With
   *  one scenario low equals high; a second scenario widens it without any
   *  change here, which is what makes this a read model rather than a report. */
  low: number;
  high: number;
  runs: number;
}

export interface ValuationInputView {
  role: string | null;
  kind: 'fact' | 'assumption';
  code: string;
  name: string;
  value: number | null;
  unit: string | null;
  /** Set for a fact read off a filing. The drill-down target for a number. */
  sourceDocumentVersionId: UUID | null;
  extractionMethod: string | null;
  factVersionId: UUID | null;
  assumptionVersionId: UUID | null;
}

export interface ValuationView {
  calculationRunId: UUID;
  method: string;
  engine: string;
  engineVersion: string;
  currency: string | null;
  calculatedAt: string;
  scenarioName: string | null;
  outputs: ValuationOutputView[];
  inputs: ValuationInputView[];
}

export interface EvidenceCounts {
  /** Claims of the thesis's run, by epistemic status. */
  claimsByStatus: { status: string; count: number }[];
  claims: number;
  citations: number;
  documents: number;
  documentVersions: number;
  chunks: number;
  promotedFacts: number;
}

export interface NodeChange {
  change: 'added' | 'removed' | 'restated';
  key: string;
  nodeType: string;
  statement: string;
  previousStatement: string | null;
}

export interface AssumptionChange {
  code: string;
  from: number | null;
  to: number | null;
}

export interface WhatChanged {
  previousVersionNo: number;
  verdictFrom: string;
  verdictTo: string;
  confidenceFrom: number | null;
  confidenceTo: number | null;
  nodes: NodeChange[];
  assumptions: AssumptionChange[];
}

export interface RunView {
  runId: UUID;
  companyId: UUID;
  asOfDate: string;
  status: string;
  depthMode: string;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: unknown;
  claims: number;
  modules: { code: string; status: string; attempt: number; startedAt: string | null }[];
  thesisVersionId: UUID | null;
}

export interface CompanyPage {
  company: CompanySummary;
  thesis: ThesisView | null;
  nodes: ThesisNodeView[];
  edges: ThesisEdgeView[];
  assumptions: AssumptionView[];
  valuation: ValuationView | null;
  evidence: EvidenceCounts;
  changed: WhatChanged | null;
  runs: RunView[];
}

export interface EvidenceView {
  evidenceId: UUID;
  role: string;
  strength: number | null;
  quote: string | null;
  chunkId: UUID | null;
  chunkIndex: number | null;
  pageNo: number | null;
  sectionPath: string | null;
  documentVersionId: UUID | null;
  documentId: UUID | null;
  documentTitle: string | null;
  documentType: string | null;
  externalId: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  sourceName: string | null;
  sourceTier: number | null;
  factVersionId: UUID | null;
  factCode: string | null;
  factValue: number | null;
  factUnit: string | null;
}

export interface ClaimDetail {
  claimId: UUID;
  claimKey: string;
  claimType: string;
  statement: string;
  status: string;
  confidence: number | null;
  createdBy: string;
  createdAt: string;
  runId: UUID | null;
  asOfDate: string | null;
  moduleCode: string | null;
  companyId: UUID;
  companyName: string;
  evidence: EvidenceView[];
  checks: {
    checkType: string;
    status: string;
    severity: string | null;
    message: string | null;
    checkedAt: string;
  }[];
  /** The same claim_key answered by other runs. Disagreement is kept, not
   *  averaged away (invariant C.13), so the page can show both. */
  otherVersions: {
    claimId: UUID;
    runId: UUID | null;
    asOfDate: string | null;
    status: string;
    statement: string;
  }[];
}

export interface DocumentChunkView {
  chunkId: UUID;
  chunkIndex: number;
  pageNo: number | null;
  sectionPath: string | null;
  text: string;
}

export interface DocumentPage {
  documentVersionId: UUID;
  versionNo: number;
  contentHash: string;
  capturedAt: string;
  storageUri: string | null;
  byteSize: number | null;
  mimeType: string | null;
  rawTextLength: number;
  documentId: UUID;
  title: string;
  documentType: string;
  externalId: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
  sourceName: string;
  sourceTier: number;
  publisher: string | null;
  chunks: DocumentChunkView[];
  /** How many stored claims rest on this version. */
  citations: number;
}

// --- helpers ----------------------------------------------------------------

/** pg returns numeric as a string to keep the precision the column promises.
 *  A read model hands out numbers, so the cast happens once, here. */
function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const LISTINGS_SELECT = `
  coalesce(
    (select json_agg(json_build_object('ticker', l.ticker, 'mic', e.mic) order by e.mic)
       from core.securities s
       join core.listings l on l.security_id = s.id
       join core.exchanges e on e.id = l.exchange_id
      where s.company_id = c.id),
    '[]'::json) as listings`;

interface CompanyRow {
  id: string;
  legal_name: string;
  common_name: string | null;
  country_code: string | null;
  website: string | null;
  listings: Listing[];
  version_no: number | null;
  verdict: string | null;
  confidence: string | null;
  thesis_at: string | null;
}

function toSummary(row: CompanyRow): CompanySummary {
  return {
    companyId: row.id,
    legalName: row.legal_name,
    commonName: row.common_name,
    countryCode: row.country_code,
    website: row.website,
    listings: row.listings,
    thesisVersionNo: row.version_no,
    verdict: row.verdict,
    confidence: num(row.confidence),
    thesisAt: row.thesis_at,
  };
}

/** The latest thesis per subject, as a lateral so the list query stays one trip. */
const LATEST_THESIS_LATERAL = `
  left join lateral (
    select tv.id, tv.version_no, tv.verdict, tv.confidence::text,
           tv.created_at::text as thesis_at, tv.research_run_id, tv.summary
      from research.thesis_versions tv
     where tv.subject_id = c.id
     order by tv.version_no desc
     limit 1
  ) t on true`;

// --- company list -----------------------------------------------------------

export async function companyList(pool: Pool): Promise<CompanySummary[]> {
  const { rows } = await pool.query<CompanyRow>(
    `select c.id, c.legal_name, c.common_name, c.country_code, c.website,
            ${LISTINGS_SELECT},
            t.version_no, t.verdict, t.confidence, t.thesis_at
       from core.companies c
       ${LATEST_THESIS_LATERAL}
      where c.status = 'active'
      order by coalesce(c.common_name, c.legal_name)`,
  );
  return rows.map(toSummary);
}

// --- company page -----------------------------------------------------------

interface ThesisRow {
  id: string;
  version_no: number;
  verdict: string;
  summary: string;
  confidence: string | null;
  created_at: string;
  research_run_id: string;
  as_of_date: string;
}

async function loadThesis(pool: Pool, companyId: UUID, versionNo?: number): Promise<ThesisRow | null> {
  const { rows } = await pool.query<ThesisRow>(
    `select tv.id, tv.version_no, tv.verdict, tv.summary, tv.confidence::text,
            tv.created_at::text, tv.research_run_id, r.as_of_date::text
       from research.thesis_versions tv
       join research.runs r on r.id = tv.research_run_id
      where tv.subject_id = $1 and ($2::int is null or tv.version_no = $2)
      order by tv.version_no desc
      limit 1`,
    [companyId, versionNo ?? null],
  );
  return rows[0] ?? null;
}

interface NodeRow {
  id: string;
  node_type: string;
  statement: string;
  confidence: string | null;
  claim_id: string | null;
  claim_key: string | null;
  claim_status: string | null;
  assumption_version_id: string | null;
  assumption_code: string | null;
  assumption_value: string | null;
  calculation_run_id: string | null;
}

async function loadNodes(pool: Pool, thesisVersionId: UUID): Promise<NodeRow[]> {
  const { rows } = await pool.query<NodeRow>(
    `select n.id, n.node_type, n.statement, n.confidence::text,
            n.claim_id, cl.claim_key, cl.epistemic_status as claim_status,
            n.assumption_version_id, a.code as assumption_code,
            av.value_numeric::text as assumption_value,
            n.calculation_run_id
       from research.thesis_nodes n
       left join research.claims cl on cl.id = n.claim_id
       left join valuation.assumption_versions av on av.id = n.assumption_version_id
       left join valuation.assumptions a on a.id = av.assumption_id
      where n.thesis_version_id = $1
      order by array_position(
        array['CONCLUSION','DRIVER','ASSUMPTION','RISK','CATALYST','UNKNOWN'], n.node_type),
        n.statement`,
    [thesisVersionId],
  );
  return rows;
}

function toNodeView(row: NodeRow): ThesisNodeView {
  let anchor: ThesisAnchor = null;
  if (row.claim_id) {
    anchor = {
      kind: 'claim',
      claimId: row.claim_id,
      claimKey: row.claim_key ?? '',
      status: row.claim_status ?? 'UNKNOWN',
    };
  } else if (row.assumption_version_id) {
    anchor = {
      kind: 'assumption',
      assumptionVersionId: row.assumption_version_id,
      code: row.assumption_code ?? '',
      value: num(row.assumption_value),
    };
  } else if (row.calculation_run_id) {
    anchor = { kind: 'valuation', calculationRunId: row.calculation_run_id };
  }
  return {
    nodeId: row.id,
    nodeType: row.node_type,
    statement: row.statement,
    confidence: num(row.confidence),
    anchor,
  };
}

/** What a node is about, stable across thesis versions. Claim ids are per-run
 *  rows, so a claim anchor is keyed by its claim_key instead; that is the
 *  column the schema comments call "stable semantic identity across runs". */
function nodeKey(row: NodeRow): string {
  if (row.claim_key) return `claim:${row.claim_key}`;
  if (row.assumption_code) return `assumption:${row.assumption_code}`;
  if (row.calculation_run_id) return 'valuation';
  return `statement:${row.statement.trim().toLowerCase()}`;
}

async function loadEdges(pool: Pool, thesisVersionId: UUID): Promise<ThesisEdgeView[]> {
  const { rows } = await pool.query<{ from_node_id: string; edge_type: string; to_node_id: string }>(
    `select e.from_node_id, e.edge_type, e.to_node_id
       from research.thesis_edges e
       join research.thesis_nodes n on n.id = e.from_node_id
      where n.thesis_version_id = $1`,
    [thesisVersionId],
  );
  return rows.map((row) => ({
    fromNodeId: row.from_node_id,
    edgeType: row.edge_type,
    toNodeId: row.to_node_id,
  }));
}

/**
 * The latest revision of every assumption this subject has, whatever policy
 * decided. A refused proposal is shown too: "what was rejected and why" is
 * part of reading a valuation honestly, and hiding it would leave the page
 * saying only what survived.
 */
async function loadAssumptions(pool: Pool, companyId: UUID): Promise<AssumptionView[]> {
  const { rows } = await pool.query<{
    assumption_id: string;
    id: string;
    version_no: number;
    code: string;
    name: string;
    unit: string | null;
    value_numeric: string | null;
    min_value: string | null;
    max_value: string | null;
    rationale: string | null;
    status: string;
    proposed_by: string;
    approved_by: string | null;
    approved_at: string | null;
    source_claim_id: string | null;
    claim_key: string | null;
    in_scenario: boolean;
  }>(
    `select distinct on (a.id)
            a.id as assumption_id, av.id, av.version_no, a.code, a.name, a.unit,
            av.value_numeric::text, av.min_value::text, av.max_value::text,
            av.rationale, av.status, av.proposed_by, av.approved_by,
            av.approved_at::text, av.source_claim_id, cl.claim_key,
            exists (select 1 from valuation.scenario_assumptions sa
                     where sa.assumption_version_id = av.id) as in_scenario
       from valuation.assumptions a
       join valuation.assumption_versions av on av.assumption_id = a.id
       left join research.claims cl on cl.id = av.source_claim_id
      where a.subject_id = $1
      order by a.id, av.version_no desc`,
    [companyId],
  );
  return rows
    .map((row) => ({
      assumptionId: row.assumption_id,
      assumptionVersionId: row.id,
      versionNo: row.version_no,
      code: row.code,
      name: row.name,
      unit: row.unit,
      value: num(row.value_numeric),
      minValue: num(row.min_value),
      maxValue: num(row.max_value),
      rationale: row.rationale,
      status: row.status,
      proposedBy: row.proposed_by,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      sourceClaimId: row.source_claim_id,
      sourceClaimKey: row.claim_key,
      inScenario: row.in_scenario,
    }))
    .sort((left, right) => left.code.localeCompare(right.code));
}

async function loadValuation(pool: Pool, companyId: UUID): Promise<ValuationView | null> {
  const { rows } = await pool.query<{
    id: string;
    method: string;
    engine: string;
    engine_version: string;
    calculated_at: string;
    currency: string | null;
    scenario_name: string | null;
    outputs: { code: string; name: string; value: number; unit: string }[] | null;
  }>(
    `select cr.id, cr.method, cr.engine, cr.engine_version, cr.calculated_at::text,
            cr.input_snapshot->>'currency' as currency,
            s.name as scenario_name,
            cr.output->'outputs' as outputs
       from valuation.calculation_runs cr
       left join valuation.scenarios s on s.id = cr.scenario_id
      where cr.subject_id = $1 and cr.status = 'completed'
      order by cr.calculated_at desc
      limit 1`,
    [companyId],
  );
  const run = rows[0];
  if (!run) return null;

  const spread = await pool.query<{ code: string; low: number; high: number; runs: number }>(
    `select o->>'code' as code,
            min((o->>'value')::float8) as low,
            max((o->>'value')::float8) as high,
            count(*)::int as runs
       from valuation.calculation_runs cr,
            lateral jsonb_array_elements(cr.output->'outputs') o
      where cr.subject_id = $1 and cr.status = 'completed' and cr.method = $2
      group by 1`,
    [companyId, run.method],
  );
  const byCode = new Map(spread.rows.map((row) => [row.code, row]));

  const inputs = await pool.query<{
    role: string | null;
    fact_version_id: string | null;
    fact_code: string | null;
    fact_name: string | null;
    fact_value: number | null;
    fact_unit: string | null;
    currency: string | null;
    source_document_version_id: string | null;
    extraction_method: string | null;
    assumption_version_id: string | null;
    assumption_code: string | null;
    assumption_name: string | null;
    assumption_value: number | null;
    assumption_unit: string | null;
  }>(
    `select cri.role,
            cri.fact_version_id, fd.code as fact_code, fd.name as fact_name,
            fv.numeric_value::float8 as fact_value, fv.unit as fact_unit, fv.currency,
            fv.source_document_version_id, fv.extraction_method,
            cri.assumption_version_id, a.code as assumption_code, a.name as assumption_name,
            av.value_numeric::float8 as assumption_value, a.unit as assumption_unit
       from valuation.calculation_run_inputs cri
       left join evidence.fact_versions fv on fv.id = cri.fact_version_id
       left join evidence.facts f on f.id = fv.fact_id
       left join evidence.fact_definitions fd on fd.id = f.fact_definition_id
       left join valuation.assumption_versions av on av.id = cri.assumption_version_id
       left join valuation.assumptions a on a.id = av.assumption_id
      where cri.calculation_run_id = $1
      order by cri.fact_version_id nulls last, cri.role`,
    [run.id],
  );

  return {
    calculationRunId: run.id,
    method: run.method,
    engine: run.engine,
    engineVersion: run.engine_version,
    currency: run.currency,
    calculatedAt: run.calculated_at,
    scenarioName: run.scenario_name,
    outputs: (run.outputs ?? []).map((output) => {
      const range = byCode.get(output.code);
      return {
        code: output.code,
        name: output.name,
        value: output.value,
        unit: output.unit,
        low: range?.low ?? output.value,
        high: range?.high ?? output.value,
        runs: range?.runs ?? 1,
      };
    }),
    inputs: inputs.rows.map((row) =>
      row.fact_version_id
        ? {
            role: row.role,
            kind: 'fact' as const,
            code: row.fact_code ?? row.role ?? 'fact',
            name: row.fact_name ?? row.fact_code ?? 'fact',
            value: row.fact_value,
            unit: row.fact_unit ?? row.currency,
            sourceDocumentVersionId: row.source_document_version_id,
            extractionMethod: row.extraction_method,
            factVersionId: row.fact_version_id,
            assumptionVersionId: null,
          }
        : {
            role: row.role,
            kind: 'assumption' as const,
            code: row.assumption_code ?? row.role ?? 'assumption',
            name: row.assumption_name ?? row.assumption_code ?? 'assumption',
            value: row.assumption_value,
            unit: row.assumption_unit,
            sourceDocumentVersionId: null,
            extractionMethod: null,
            factVersionId: null,
            assumptionVersionId: row.assumption_version_id,
          },
    ),
  };
}

async function loadEvidenceCounts(
  pool: Pool,
  companyId: UUID,
  runId: UUID | null,
): Promise<EvidenceCounts> {
  const byStatus = runId
    ? await pool.query<{ status: string; count: number }>(
        `select c.epistemic_status as status, count(*)::int as count
           from research.claims c where c.run_id = $1
          group by 1 order by 1`,
        [runId],
      )
    : { rows: [] as { status: string; count: number }[] };

  const citations = runId
    ? await pool.query<{ count: number }>(
        `select count(ce.id)::int as count
           from research.claim_evidence ce
           join research.claims c on c.id = ce.claim_id
          where c.run_id = $1`,
        [runId],
      )
    : { rows: [{ count: 0 }] };

  const corpus = await pool.query<{
    documents: number;
    document_versions: number;
    chunks: number;
    promoted_facts: number;
  }>(
    `select
       (select count(*)::int from evidence.document_subjects ds
         where ds.entity_id = $1) as documents,
       (select count(*)::int from evidence.document_versions dv
          join evidence.document_subjects ds on ds.document_id = dv.document_id
         where ds.entity_id = $1) as document_versions,
       (select count(*)::int from evidence.document_chunks dc
          join evidence.document_versions dv on dv.id = dc.document_version_id
          join evidence.document_subjects ds on ds.document_id = dv.document_id
         where ds.entity_id = $1) as chunks,
       (select count(*)::int from evidence.facts f
          join evidence.fact_versions fv on fv.id = f.current_version_id
         where f.entity_id = $1 and fv.status = 'promoted') as promoted_facts`,
    [companyId],
  );

  const counts = corpus.rows[0] ?? {
    documents: 0,
    document_versions: 0,
    chunks: 0,
    promoted_facts: 0,
  };
  return {
    claimsByStatus: byStatus.rows,
    claims: byStatus.rows.reduce((total, row) => total + row.count, 0),
    citations: citations.rows[0]?.count ?? 0,
    documents: counts.documents,
    documentVersions: counts.document_versions,
    chunks: counts.chunks,
    promotedFacts: counts.promoted_facts,
  };
}

/**
 * The diff between this thesis version and the one before it. Nothing is
 * stored about the difference: it is derived on read from two versions that
 * are each immutable, which is the only way a "what changed" line can be
 * trusted not to have been written by the thing it describes.
 */
async function loadWhatChanged(
  pool: Pool,
  companyId: UUID,
  current: ThesisRow,
): Promise<WhatChanged | null> {
  const previous = await loadThesis(pool, companyId, current.version_no - 1);
  if (!previous) return null;

  const [currentNodes, previousNodes] = await Promise.all([
    loadNodes(pool, current.id),
    loadNodes(pool, previous.id),
  ]);
  const before = new Map(previousNodes.map((row) => [nodeKey(row), row]));
  const after = new Map(currentNodes.map((row) => [nodeKey(row), row]));

  const nodes: NodeChange[] = [];
  for (const [key, row] of after) {
    const was = before.get(key);
    if (!was) {
      nodes.push({
        change: 'added',
        key,
        nodeType: row.node_type,
        statement: row.statement,
        previousStatement: null,
      });
    } else if (was.statement !== row.statement || was.node_type !== row.node_type) {
      nodes.push({
        change: 'restated',
        key,
        nodeType: row.node_type,
        statement: row.statement,
        previousStatement: was.statement,
      });
    }
  }
  for (const [key, row] of before) {
    if (after.has(key)) continue;
    nodes.push({
      change: 'removed',
      key,
      nodeType: row.node_type,
      statement: row.statement,
      previousStatement: row.statement,
    });
  }

  // Assumptions are compared on the value each thesis version cited, so a
  // proposal that policy refused between the two versions shows up as no
  // change at all -- which is correct: the thesis never rested on it.
  const values = (rows: NodeRow[]) =>
    new Map(
      rows
        .filter((row) => row.assumption_code)
        .map((row) => [row.assumption_code!, num(row.assumption_value)]),
    );
  const previousValues = values(previousNodes);
  const currentValues = values(currentNodes);
  const assumptions: AssumptionChange[] = [];
  for (const code of new Set([...previousValues.keys(), ...currentValues.keys()])) {
    const from = previousValues.get(code) ?? null;
    const to = currentValues.get(code) ?? null;
    if (from !== to) assumptions.push({ code, from, to });
  }
  assumptions.sort((left, right) => left.code.localeCompare(right.code));

  return {
    previousVersionNo: previous.version_no,
    verdictFrom: previous.verdict,
    verdictTo: current.verdict,
    confidenceFrom: num(previous.confidence),
    confidenceTo: num(current.confidence),
    nodes,
    assumptions,
  };
}

interface RunRow {
  id: string;
  subject_id: string;
  as_of_date: string;
  status: string;
  depth_mode: string;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: unknown;
  claims: number;
  thesis_version_id: string | null;
}

const RUN_SELECT = `
  select r.id, r.subject_id, r.as_of_date::text, r.status, r.depth_mode,
         r.requested_at::text, r.started_at::text, r.completed_at::text, r.error,
         (select count(*)::int from research.claims c where c.run_id = r.id) as claims,
         (select tv.id from research.thesis_versions tv
           where tv.research_run_id = r.id order by tv.version_no desc limit 1)
           as thesis_version_id
    from research.runs r`;

async function attachModules(pool: Pool, rows: RunRow[]): Promise<RunView[]> {
  if (rows.length === 0) return [];
  const { rows: moduleRows } = await pool.query<{
    run_id: string;
    code: string;
    status: string;
    attempt: number;
    started_at: string | null;
  }>(
    `select mr.run_id, md.code, mr.status, mr.attempt, mr.started_at::text
       from research.module_runs mr
       join research.module_definitions md on md.id = mr.module_definition_id
      where mr.run_id = any($1::uuid[])
      order by mr.started_at nulls last, md.code`,
    [rows.map((row) => row.id)],
  );
  const byRun = new Map<string, RunView['modules']>();
  for (const row of moduleRows) {
    const list = byRun.get(row.run_id) ?? [];
    list.push({
      code: row.code,
      status: row.status,
      attempt: row.attempt,
      startedAt: row.started_at,
    });
    byRun.set(row.run_id, list);
  }
  return rows.map((row) => ({
    runId: row.id,
    companyId: row.subject_id,
    asOfDate: row.as_of_date,
    status: row.status,
    depthMode: row.depth_mode,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    error: row.error,
    claims: row.claims,
    modules: byRun.get(row.id) ?? [],
    thesisVersionId: row.thesis_version_id,
  }));
}

export async function recentRuns(pool: Pool, companyId: UUID, limit = 5): Promise<RunView[]> {
  const { rows } = await pool.query<RunRow>(
    `${RUN_SELECT} where r.subject_id = $1 order by r.requested_at desc limit $2`,
    [companyId, limit],
  );
  return attachModules(pool, rows);
}

export async function runStatus(pool: Pool, runId: UUID): Promise<RunView | null> {
  const { rows } = await pool.query<RunRow>(`${RUN_SELECT} where r.id = $1`, [runId]);
  const views = await attachModules(pool, rows);
  return views[0] ?? null;
}

/**
 * Everything the company page shows, in one call. Returns null only when the
 * company does not exist: a company with no thesis yet is a real page, and
 * saying so is more useful than a 404.
 */
export async function companyPage(pool: Pool, companyId: UUID): Promise<CompanyPage | null> {
  const { rows } = await pool.query<CompanyRow>(
    `select c.id, c.legal_name, c.common_name, c.country_code, c.website,
            ${LISTINGS_SELECT},
            t.version_no, t.verdict, t.confidence, t.thesis_at
       from core.companies c
       ${LATEST_THESIS_LATERAL}
      where c.id = $1`,
    [companyId],
  );
  const company = rows[0];
  if (!company) return null;

  const thesis = await loadThesis(pool, companyId);
  const [assumptions, valuation, evidence, runs] = await Promise.all([
    loadAssumptions(pool, companyId),
    loadValuation(pool, companyId),
    loadEvidenceCounts(pool, companyId, thesis?.research_run_id ?? null),
    recentRuns(pool, companyId),
  ]);

  if (!thesis) {
    return {
      company: toSummary(company),
      thesis: null,
      nodes: [],
      edges: [],
      assumptions,
      valuation,
      evidence,
      changed: null,
      runs,
    };
  }

  const [nodeRows, edges, changed] = await Promise.all([
    loadNodes(pool, thesis.id),
    loadEdges(pool, thesis.id),
    loadWhatChanged(pool, companyId, thesis),
  ]);

  return {
    company: toSummary(company),
    thesis: {
      thesisVersionId: thesis.id,
      versionNo: thesis.version_no,
      verdict: thesis.verdict,
      summary: thesis.summary,
      confidence: num(thesis.confidence),
      createdAt: thesis.created_at,
      researchRunId: thesis.research_run_id,
      asOfDate: thesis.as_of_date,
    },
    nodes: nodeRows.map(toNodeView),
    edges,
    assumptions,
    valuation,
    evidence,
    changed,
    runs,
  };
}

// --- drill-down: claim ------------------------------------------------------

export async function claimDetail(pool: Pool, claimId: UUID): Promise<ClaimDetail | null> {
  const { rows } = await pool.query<{
    id: string;
    claim_key: string;
    claim_type: string;
    statement: string;
    epistemic_status: string;
    confidence: string | null;
    created_by: string;
    created_at: string;
    run_id: string | null;
    as_of_date: string | null;
    module_code: string | null;
    subject_id: string;
    company_name: string;
  }>(
    `select c.id, c.claim_key, c.claim_type, c.statement, c.epistemic_status,
            c.confidence::text, c.created_by, c.created_at::text,
            c.run_id, r.as_of_date::text, md.code as module_code,
            c.subject_id, coalesce(co.common_name, co.legal_name) as company_name
       from research.claims c
       left join research.runs r on r.id = c.run_id
       left join research.module_runs mr on mr.id = c.module_run_id
       left join research.module_definitions md on md.id = mr.module_definition_id
       join core.companies co on co.id = c.subject_id
      where c.id = $1`,
    [claimId],
  );
  const claim = rows[0];
  if (!claim) return null;

  const evidence = await pool.query<{
    id: string;
    evidence_role: string;
    support_strength: string | null;
    quote_excerpt: string | null;
    chunk_id: string | null;
    chunk_index: number | null;
    page_no: number | null;
    section_path: string | null;
    document_version_id: string | null;
    document_id: string | null;
    title: string | null;
    document_type: string | null;
    external_id: string | null;
    canonical_url: string | null;
    published_at: string | null;
    source_name: string | null;
    source_tier: number | null;
    fact_version_id: string | null;
    fact_code: string | null;
    fact_value: number | null;
    fact_unit: string | null;
  }>(
    `select ce.id, ce.evidence_role, ce.support_strength::text, ce.quote_excerpt,
            ce.chunk_id, dc.chunk_index, dc.page_no, dc.section_path,
            ce.document_version_id, d.id as document_id, d.title, d.document_type,
            d.external_id, d.canonical_url, d.published_at::text,
            s.source_name, s.source_tier,
            ce.fact_version_id, fd.code as fact_code,
            fv.numeric_value::float8 as fact_value, fv.unit as fact_unit
       from research.claim_evidence ce
       left join evidence.document_chunks dc on dc.id = ce.chunk_id
       left join evidence.document_versions dv on dv.id = ce.document_version_id
       left join evidence.documents d on d.id = dv.document_id
       left join evidence.sources s on s.id = d.source_id
       left join evidence.fact_versions fv on fv.id = ce.fact_version_id
       left join evidence.facts f on f.id = fv.fact_id
       left join evidence.fact_definitions fd on fd.id = f.fact_definition_id
      where ce.claim_id = $1
      order by ce.evidence_role, dc.chunk_index nulls last`,
    [claimId],
  );

  const checks = await pool.query<{
    check_type: string;
    status: string;
    severity: string | null;
    message: string | null;
    checked_at: string;
  }>(
    `select vc.check_type, vc.status, vc.severity, vc.message,
            coalesce(vr.completed_at, vr.started_at)::text as checked_at
       from research.verification_checks vc
       join research.verification_runs vr on vr.id = vc.verification_run_id
      where vc.claim_id = $1
      order by coalesce(vr.completed_at, vr.started_at) desc, vc.check_type`,
    [claimId],
  );

  const others = await pool.query<{
    id: string;
    run_id: string | null;
    as_of_date: string | null;
    epistemic_status: string;
    statement: string;
  }>(
    `select c.id, c.run_id, r.as_of_date::text, c.epistemic_status, c.statement
       from research.claims c
       left join research.runs r on r.id = c.run_id
      where c.subject_id = $1 and c.claim_key = $2 and c.id <> $3
      order by r.as_of_date desc nulls last, c.created_at desc`,
    [claim.subject_id, claim.claim_key, claimId],
  );

  return {
    claimId: claim.id,
    claimKey: claim.claim_key,
    claimType: claim.claim_type,
    statement: claim.statement,
    status: claim.epistemic_status,
    confidence: num(claim.confidence),
    createdBy: claim.created_by,
    createdAt: claim.created_at,
    runId: claim.run_id,
    asOfDate: claim.as_of_date,
    moduleCode: claim.module_code,
    companyId: claim.subject_id,
    companyName: claim.company_name,
    evidence: evidence.rows.map((row) => ({
      evidenceId: row.id,
      role: row.evidence_role,
      strength: num(row.support_strength),
      quote: row.quote_excerpt,
      chunkId: row.chunk_id,
      chunkIndex: row.chunk_index,
      pageNo: row.page_no,
      sectionPath: row.section_path,
      documentVersionId: row.document_version_id,
      documentId: row.document_id,
      documentTitle: row.title,
      documentType: row.document_type,
      externalId: row.external_id,
      canonicalUrl: row.canonical_url,
      publishedAt: row.published_at,
      sourceName: row.source_name,
      sourceTier: row.source_tier,
      factVersionId: row.fact_version_id,
      factCode: row.fact_code,
      factValue: row.fact_value,
      factUnit: row.fact_unit,
    })),
    checks: checks.rows.map((row) => ({
      checkType: row.check_type,
      status: row.status,
      severity: row.severity,
      message: row.message,
      checkedAt: row.checked_at,
    })),
    otherVersions: others.rows.map((row) => ({
      claimId: row.id,
      runId: row.run_id,
      asOfDate: row.as_of_date,
      status: row.epistemic_status,
      statement: row.statement,
    })),
  };
}

// --- drill-down: document ---------------------------------------------------

/**
 * The stored filing, as chunks. The raw text is deliberately not returned: the
 * chunks are the segmentation every citation points into, so rendering them is
 * rendering the document a claim actually cited, and only its length is needed
 * to say how much of the filing is on the page.
 */
export async function documentPage(
  pool: Pool,
  documentVersionId: UUID,
): Promise<DocumentPage | null> {
  const { rows } = await pool.query<{
    id: string;
    version_no: number;
    content_hash: string;
    captured_at: string;
    storage_uri: string | null;
    byte_size: string | null;
    mime_type: string | null;
    raw_text_length: number;
    document_id: string;
    title: string;
    document_type: string;
    external_id: string | null;
    canonical_url: string | null;
    published_at: string | null;
    source_name: string;
    source_tier: number;
    publisher: string | null;
    citations: number;
  }>(
    `select dv.id, dv.version_no, dv.content_hash, dv.captured_at::text,
            dv.storage_uri, dv.byte_size::text, dv.mime_type,
            coalesce(length(dv.raw_text), 0) as raw_text_length,
            d.id as document_id, d.title, d.document_type, d.external_id,
            d.canonical_url, d.published_at::text,
            s.source_name, s.source_tier, coalesce(d.publisher, s.publisher) as publisher,
            (select count(*)::int from research.claim_evidence ce
              where ce.document_version_id = dv.id) as citations
       from evidence.document_versions dv
       join evidence.documents d on d.id = dv.document_id
       join evidence.sources s on s.id = d.source_id
      where dv.id = $1`,
    [documentVersionId],
  );
  const version = rows[0];
  if (!version) return null;

  const chunks = await pool.query<{
    id: string;
    chunk_index: number;
    page_no: number | null;
    section_path: string | null;
    text_content: string;
  }>(
    `select id, chunk_index, page_no, section_path, text_content
       from evidence.document_chunks
      where document_version_id = $1
      order by chunk_index`,
    [documentVersionId],
  );

  return {
    documentVersionId: version.id,
    versionNo: version.version_no,
    contentHash: version.content_hash,
    capturedAt: version.captured_at,
    storageUri: version.storage_uri,
    byteSize: num(version.byte_size),
    mimeType: version.mime_type,
    rawTextLength: version.raw_text_length,
    documentId: version.document_id,
    title: version.title,
    documentType: version.document_type,
    externalId: version.external_id,
    canonicalUrl: version.canonical_url,
    publishedAt: version.published_at,
    sourceName: version.source_name,
    sourceTier: version.source_tier,
    publisher: version.publisher,
    chunks: chunks.rows.map((row) => ({
      chunkId: row.id,
      chunkIndex: row.chunk_index,
      pageNo: row.page_no,
      sectionPath: row.section_path,
      text: row.text_content,
    })),
    citations: version.citations,
  };
}

/** The document version a fact revision was read off, for a number on a page
 *  that has no claim between it and its filing. */
export async function factSource(
  pool: Pool,
  factVersionId: UUID,
): Promise<{ documentVersionId: UUID | null; extractionMethod: string } | null> {
  const { rows } = await pool.query<{
    source_document_version_id: string | null;
    extraction_method: string;
  }>(
    `select source_document_version_id, extraction_method
       from evidence.fact_versions where id = $1`,
    [factVersionId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    documentVersionId: row.source_document_version_id,
    extractionMethod: row.extraction_method,
  };
}
