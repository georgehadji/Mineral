export { createPool, inTransaction, type Pool } from './client.ts';
export {
  resolveCompany,
  type ResolvedCompany,
  type ResolutionOutcome,
} from './identity-repository.ts';
export {
  ingestDocument,
  ingestXbrlFacts,
  ensureEdgarSource,
  type IngestDocumentInput,
  type IngestDocumentResult,
  type IngestXbrlFactsInput,
  type IngestXbrlFactsResult,
} from './ingest-repository.ts';
export {
  recordCalculation,
  type RecordCalculationInput,
  type RecordCalculationResult,
} from './calc-repository.ts';
export {
  ensureFactDefinitions,
  upsertFact,
  currentFactVersion,
  type FactDefinitionInput,
  type FactPeriod,
} from './facts.ts';
export {
  callModel,
  type CallModelInput,
  type CallModelResult,
} from './model-repository.ts';
export {
  ensureModuleDefinitions,
  freezeSnapshot,
  runResearch,
  ResearchRunError,
  type FrozenSnapshot,
  type ModuleOutcome,
  type RejectedClaim,
  type RunResearchInput,
  type RunResearchResult,
  type Step,
} from './research-repository.ts';
export {
  decide,
  DecisionError,
  type CalcFn,
  type DecideInput,
  type DecideResult,
} from './decision-repository.ts';
export {
  ensureProductionFactDefinitions,
  facilitiesOf,
  latestConcentration,
  operatorsOf,
  producersOf,
  promoteFacilities,
  recordConcentration,
  recordProduction,
  stages,
  supplyChain,
  OntologyError,
  PRODUCTION_FACT_CODES,
  type ConcentrationView,
  type FacilityPromotion,
  type FacilityView,
  type MaterialView,
  type PromoteFacilitiesResult,
  type ProducerView,
  type ProductionFactCode,
  type RecordConcentrationResult,
  type RecordProductionInput,
  type StageView,
  type SupplyChainView,
} from './ontology-repository.ts';
export {
  alertRules,
  driftReport,
  ensureAlertRules,
  monitor,
  MonitoringError,
  type MonitorResult,
} from './monitoring-repository.ts';
export {
  latestRunFor,
  verifyRun,
  VerificationError,
  type VerificationResult,
} from './verification-repository.ts';
export {
  claimDetail,
  companyList,
  companyPage,
  documentPage,
  factSource,
  recentRuns,
  runStatus,
  type AssumptionChange,
  type AssumptionView,
  type ClaimDetail,
  type CompanyPage,
  type CompanySummary,
  type DocumentChunkView,
  type DocumentPage,
  type EvidenceCounts,
  type EvidenceView,
  type Listing,
  type NodeChange,
  type RunView,
  type ThesisAnchor,
  type ThesisEdgeView,
  type ThesisNodeView,
  type ThesisView,
  type ValuationInputView,
  type ValuationOutputView,
  type ValuationView,
  type WhatChanged,
} from './read-repository.ts';
