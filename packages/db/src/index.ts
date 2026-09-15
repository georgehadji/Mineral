export { createPool, type Pool } from './client.ts';
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
  inTransaction,
  type FactDefinitionInput,
  type FactPeriod,
} from './facts.ts';
