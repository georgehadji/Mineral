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
  type RunResearchInput,
  type RunResearchResult,
  type Step,
} from './research-repository.ts';
export {
  latestRunFor,
  verifyRun,
  VerificationError,
  type VerificationResult,
} from './verification-repository.ts';
