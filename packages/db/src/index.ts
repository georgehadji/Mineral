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
