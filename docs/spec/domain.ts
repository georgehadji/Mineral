export type UUID = string;

export type EntityType =
  | 'company'
  | 'security'
  | 'listing'
  | 'commodity'
  | 'material'
  | 'theme'
  | 'project'
  | 'facility'
  | 'country'
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
  validFrom?: string;
  validTo?: string;
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
  strength: number; // 0..1
}

export interface Claim {
  id: UUID;
  subjectType: EntityType;
  subjectId: UUID;
  claimType: string;
  statement: string;
  epistemicStatus: EpistemicStatus;
  confidence: number; // 0..1
  validFrom?: string;
  validTo?: string;
  evidence: EvidenceRef[];
}

export interface Assumption {
  id: UUID;
  subjectType: EntityType;
  subjectId: UUID;
  code: string;
  name: string;
  value: number | string;
  unit?: string;
  sourceClaimId?: UUID;
  status: 'proposed' | 'approved' | 'rejected' | 'superseded';
}

export interface ResearchContext {
  runId: UUID;
  subject: {
    type: EntityType;
    id: UUID;
  };
  asOfDate: string;
  depth: 'quick' | 'standard' | 'deep';
  evidence: EvidenceRef[];
  facts: Record<string, unknown>;
  claims: Claim[];
  assumptions: Assumption[];
}

export interface ResearchModuleInput<T = unknown> {
  context: ResearchContext;
  input: T;
}

export interface ResearchModuleOutput<T = unknown> {
  data: T;
  claims: Claim[];
  assumptions: Assumption[];
  warnings: string[];
  requiredFollowUps: string[];
}

export interface ResearchModuleDefinition<TInput = unknown, TOutput = unknown> {
  id: string;
  version: string;
  category: string;
  requires: string[];
  inputSchema: unknown;
  outputSchema: unknown;
  run(input: ResearchModuleInput<TInput>): Promise<ResearchModuleOutput<TOutput>>;
  validate(output: ResearchModuleOutput<TOutput>): Promise<ValidationResult>;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface ValuationResult {
  method: 'dcf' | 'pe' | 'ev_ebitda' | 'ev_sales' | 'fcf_yield' | 'nav' | 'sotp';
  enterpriseValue?: number;
  equityValue?: number;
  fairValuePerShare?: number;
  currency?: string;
  assumptions: Assumption[];
  calculationVersion: string;
}

export interface ThesisNode {
  id: UUID;
  type: 'DRIVER' | 'ASSUMPTION' | 'RISK' | 'CATALYST' | 'CONCLUSION' | 'UNKNOWN';
  statement: string;
  confidence: number;
  claimId?: UUID;
  assumptionId?: UUID;
}

export interface ThesisEdge {
  from: UUID;
  to: UUID;
  type: 'SUPPORTS' | 'CONTRADICTS' | 'DEPENDS_ON' | 'CAUSES' | 'DERIVED_FROM' | 'INVALIDATES';
}

export interface Thesis {
  version: number;
  verdict: 'bullish' | 'neutral' | 'bearish' | 'insufficient_evidence';
  summary: string;
  confidence: number;
  nodes: ThesisNode[];
  edges: ThesisEdge[];
}
