/**
 * Canonical domain types. Types only: no runtime dependencies, no persistence.
 * Mirrors packages/db/migrations/20260914000000_schema_v1_1.sql.
 */

export type UUID = string;
/** ISO-8601 date, YYYY-MM-DD. World time (period, as-of). */
export type IsoDate = string;
/** ISO-8601 timestamp with zone. System time (effective, observed). */
export type IsoTimestamp = string;

export type EntityType =
  | 'company'
  | 'security'
  | 'listing'
  | 'commodity'
  | 'material'
  | 'element'
  | 'theme'
  | 'project'
  | 'facility'
  | 'country'
  | 'supply_chain_stage'
  | 'end_market'
  | 'portfolio';

export type EpistemicStatus =
  | 'VERIFIED'
  | 'CALCULATED'
  | 'DERIVED'
  | 'INFERRED'
  | 'HYPOTHESIS'
  | 'UNKNOWN'
  | 'CONTRADICTED'
  | 'STALE';

/** 1 = primary filing or regulator, 5 = anonymous or unattributed. */
export type SourceTier = 1 | 2 | 3 | 4 | 5;

export type FactVersionStatus = 'candidate' | 'promoted' | 'rejected' | 'superseded';

export type ExtractionMethod = 'xbrl' | 'provider' | 'manual' | 'llm' | 'calculated';

export type ModuleKind = 'llm' | 'deterministic' | 'hybrid';

export interface EntityRef {
  type: EntityType;
  id: UUID;
}

export interface Company {
  id: UUID;
  legalName: string;
  commonName?: string;
  countryCode?: string;
  website?: string;
  status: 'active' | 'inactive' | 'unknown';
}

export interface Security {
  id: UUID;
  companyId: UUID;
  securityType: 'common_stock' | 'preferred_stock' | 'adr' | 'etf' | 'bond' | 'other';
  isin?: string;
  currency?: string;
  status: 'active' | 'inactive' | 'unknown';
}

export interface Listing {
  id: UUID;
  securityId: UUID;
  exchangeId?: UUID;
  ticker: string;
  currency?: string;
  /** Listing validity in world time. */
  validFrom?: IsoDate;
  validTo?: IsoDate;
}

export interface SourceRef {
  sourceId: UUID;
  documentId?: UUID;
  documentVersionId?: UUID;
  chunkId?: UUID;
  url?: string;
  page?: number;
}

export interface EvidenceRef {
  source: SourceRef;
  role: 'supports' | 'contradicts' | 'context';
  /** 0..1 */
  strength: number;
  sourceTier: SourceTier;
  /**
   * Verbatim span copied from the cited chunk. Proposed rule 14: verified by
   * containment against the chunk text before persistence.
   */
  quote?: string;
}

/**
 * Read-only projection of one promoted fact version (report I.17). Modules get
 * these instead of an untyped bag, and must cite factVersionId for any number
 * they restate.
 */
export interface FactView {
  factId: UUID;
  factVersionId: UUID;
  /** fact_definitions.code, for example revenue or ndpr_capacity. */
  definitionCode: string;
  entity: EntityRef;
  valueNumeric?: number;
  valueText?: string;
  valueJson?: unknown;
  unit?: string;
  currency?: string;
  /** World time: the period the value describes. */
  periodStart?: IsoDate;
  periodEnd?: IsoDate;
  /** World time: the vintage of the statement, the restatement axis. */
  asOfDate?: IsoDate;
  /** Basis, product, facility and other identity-bearing qualifiers. */
  qualifiers: Record<string, string | number | boolean>;
  status: EpistemicStatus;
  extractionMethod: ExtractionMethod;
  sourceTier: SourceTier;
  source?: SourceRef;
}

export interface Claim {
  id: UUID;
  runId: UUID;
  moduleRunId: UUID;
  /** Stable identity across runs: subject, claim type, qualifier (report I.5). */
  claimKey: string;
  subject: EntityRef;
  claimType: string;
  statement: string;
  epistemicStatus: EpistemicStatus;
  /** 0..1 */
  confidence: number;
  /** World time validity of the asserted statement. */
  validFrom?: IsoDate;
  validTo?: IsoDate;
  evidence: EvidenceRef[];
  /** Fact versions the statement restates or derives from. */
  factVersionIds: UUID[];
}

export interface Assumption {
  id: UUID;
  subject: EntityRef;
  code: string;
  name: string;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  currentVersionId?: UUID;
}

export interface AssumptionVersion {
  id: UUID;
  assumptionId: UUID;
  versionNo: number;
  value: number | string;
  unit?: string;
  rationale?: string;
  sourceClaimId?: UUID;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
  approvedBy?: string;
  approvedAt?: IsoTimestamp;
}

export interface ResearchContext {
  runId: UUID;
  subject: EntityRef;
  /** Analytical today for the run. */
  asOfDate: IsoDate;
  depth: 'quick' | 'standard' | 'deep';
  /** Immutable evidence snapshot the run is pinned to. */
  snapshotId: UUID;
  evidence: EvidenceRef[];
  facts: FactView[];
  claims: Claim[];
  assumptions: AssumptionVersion[];
}

/** Claim a module proposes. Identity and run linkage are assigned on persist. */
export type ProposedClaim = Omit<Claim, 'id' | 'runId' | 'moduleRunId'>;

/** Assumption a module proposes. Always enters as proposed (rule 6). */
export interface ProposedAssumption {
  subject: EntityRef;
  code: string;
  name: string;
  value: number | string;
  unit?: string;
  rationale?: string;
  sourceClaimKey?: string;
}

export interface ResearchModuleInput<T = unknown> {
  context: ResearchContext;
  input: T;
}

export interface ResearchModuleOutput<T = unknown> {
  data: T;
  claims: ProposedClaim[];
  assumptions: ProposedAssumption[];
  warnings: string[];
  requiredFollowUps: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Minimal shape a schema library must satisfy. Keeps domain runtime-free. */
export interface SchemaLike<T> {
  parse(value: unknown): T;
}

/**
 * kind tells the orchestrator which modules need the LLM gateway and which must
 * reproduce bit for bit (report I.20). run receives only the context: no
 * repository, no client, no write path.
 */
export interface ResearchModuleDefinition<TInput = unknown, TOutput = unknown> {
  code: string;
  version: string;
  category: string;
  kind: ModuleKind;
  /** Single source of truth for dependencies (report I.18). Recipes do not restate it. */
  requires: string[];
  inputSchema: SchemaLike<TInput>;
  outputSchema: SchemaLike<TOutput>;
  run(input: ResearchModuleInput<TInput>): Promise<ResearchModuleOutput<TOutput>>;
  validate(output: ResearchModuleOutput<TOutput>): Promise<ValidationResult>;
}

export type CalculationMethod =
  | 'ratios'
  | 'dcf'
  | 'reverse_dcf'
  | 'pe'
  | 'ev_ebitda'
  | 'ev_sales'
  | 'fcf_yield'
  | 'nav'
  | 'sotp'
  | 'scenario';

export interface ValuationResult {
  calculationRunId: UUID;
  method: CalculationMethod;
  enterpriseValue?: number;
  equityValue?: number;
  fairValuePerShare?: number;
  currency?: string;
  assumptionVersionIds: UUID[];
  inputFactVersionIds: UUID[];
  engine: string;
  engineVersion: string;
}

export interface ThesisNode {
  id: UUID;
  type: 'DRIVER' | 'ASSUMPTION' | 'RISK' | 'CATALYST' | 'CONCLUSION' | 'UNKNOWN';
  statement: string;
  confidence: number;
  claimId?: UUID;
  assumptionVersionId?: UUID;
  calculationRunId?: UUID;
}

export interface ThesisEdge {
  from: UUID;
  to: UUID;
  type: 'SUPPORTS' | 'CONTRADICTS' | 'DEPENDS_ON' | 'CAUSES' | 'DERIVED_FROM' | 'INVALIDATES';
}

export interface Thesis {
  id: UUID;
  subject: EntityRef;
  /** Rule 9: a thesis version always names the run that produced it. */
  researchRunId: UUID;
  versionNo: number;
  verdict: 'bullish' | 'neutral' | 'bearish' | 'insufficient_evidence';
  summary: string;
  confidence: number;
  nodes: ThesisNode[];
  edges: ThesisEdge[];
}
