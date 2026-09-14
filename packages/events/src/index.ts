/**
 * Platform event contracts (report I.21).
 *
 * Every envelope carries a schema version, a correlation id (the research run
 * or ingestion job the event belongs to), a causation id (the event that caused
 * it) and an idempotency key so a redelivered event is a no-op.
 */
import type { EntityType, EpistemicStatus, UUID } from '@mineral/domain';

export type EventActor = 'system' | 'user' | 'provider' | 'workflow';

export interface EventEnvelope<TType extends string, TPayload> {
  id: UUID;
  type: TType;
  /** Payload schema version for `type`. Bump on any breaking payload change. */
  version: number;
  occurredAt: string;
  actor: EventActor;
  /** Run, job or request this event belongs to. */
  correlationId: UUID;
  /** Event that caused this one, if any. */
  causationId?: UUID;
  /** Stable key for exactly-once handling. */
  idempotencyKey: string;
  payload: TPayload;
}

export interface EntityScope {
  subjectType: EntityType;
  subjectId: UUID;
}

export interface CompanyUpdatedPayload {
  companyId: UUID;
}
export interface FilingIngestedPayload {
  documentId: UUID;
  documentVersionId: UUID;
  contentHash: string;
}
export interface FactCandidateProposedPayload {
  factId: UUID;
  factVersionId: UUID;
  proposedByModelRunId?: UUID;
}
export interface FactPromotedPayload {
  factId: UUID;
  factVersionId: UUID;
  supersedesVersionId?: UUID;
  promotedBy: string;
}
export interface ClaimStatusChangedPayload {
  claimId: UUID;
  claimKey: string;
  fromStatus?: EpistemicStatus;
  toStatus: EpistemicStatus;
}
export interface AssumptionApprovedPayload {
  assumptionId: UUID;
  assumptionVersionId: UUID;
  approvedBy: string;
}
export interface ResearchRunRequestedPayload extends EntityScope {
  runId: UUID;
  recipeId: string;
  asOfDate: string;
}
export interface ResearchRunCompletedPayload {
  runId: UUID;
  snapshotId: UUID;
  moduleCount: number;
}
export interface ResearchRunFailedPayload {
  runId: UUID;
  failedModuleCode?: string;
  error: string;
}
export interface ResearchModuleRequestedPayload {
  runId: UUID;
  moduleRunId: UUID;
  moduleCode: string;
}
export interface ResearchModuleCompletedPayload {
  runId: UUID;
  moduleRunId: UUID;
  moduleCode: string;
}
export interface VerificationRequestedPayload {
  runId: UUID;
  targetType: 'claim' | 'fact_version' | 'calculation_run' | 'thesis_version';
  targetId: UUID;
}
export interface VerificationCompletedPayload {
  runId: UUID;
  checkType: string;
  passed: boolean;
  failureCount: number;
}
export interface MarketObservationIngestedPayload {
  seriesId: UUID;
  observedAt: string;
}
export interface ThesisUpdatedPayload extends EntityScope {
  thesisVersionId: UUID;
  versionNo: number;
}
export interface ThesisDriftDetectedPayload extends EntityScope {
  fromThesisVersionId: UUID;
  toThesisVersionId: UUID;
  changedClaimKeys: string[];
}
export interface ValuationChangedPayload extends EntityScope {
  calculationRunId: UUID;
  method: string;
}
export interface IntelligenceAlertTriggeredPayload {
  alertRuleId: UUID;
  alertEventId: UUID;
  ruleType: string;
  triggerRefType: string;
  triggerRefId: UUID;
}

/** Event name constants. Data uses these strings; TypeScript uses PlatformEvent. */
export const EVENT_NAMES = {
  COMPANY_UPDATED: 'company.updated',
  FILING_INGESTED: 'filing.ingested',
  FACT_CANDIDATE_PROPOSED: 'fact.candidate.proposed',
  FACT_PROMOTED: 'fact.promoted',
  CLAIM_STATUS_CHANGED: 'claim.status.changed',
  ASSUMPTION_APPROVED: 'assumption.approved',
  RESEARCH_RUN_REQUESTED: 'research.run.requested',
  RESEARCH_RUN_COMPLETED: 'research.run.completed',
  RESEARCH_RUN_FAILED: 'research.run.failed',
  RESEARCH_MODULE_REQUESTED: 'research.module.requested',
  RESEARCH_MODULE_COMPLETED: 'research.module.completed',
  RESEARCH_VERIFICATION_REQUESTED: 'research.verification.requested',
  RESEARCH_VERIFICATION_COMPLETED: 'research.verification.completed',
  MARKET_OBSERVATION_INGESTED: 'market.observation.ingested',
  THESIS_UPDATED: 'thesis.updated',
  THESIS_DRIFT_DETECTED: 'thesis.drift.detected',
  VALUATION_CHANGED: 'valuation.changed',
  INTELLIGENCE_ALERT_TRIGGERED: 'intelligence.alert.triggered',
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

/** Current payload schema version per event name. */
export const EVENT_VERSIONS: Record<EventName, number> = {
  'company.updated': 1,
  'filing.ingested': 1,
  'fact.candidate.proposed': 1,
  'fact.promoted': 1,
  'claim.status.changed': 1,
  'assumption.approved': 1,
  'research.run.requested': 1,
  'research.run.completed': 1,
  'research.run.failed': 1,
  'research.module.requested': 1,
  'research.module.completed': 1,
  'research.verification.requested': 1,
  'research.verification.completed': 1,
  'market.observation.ingested': 1,
  'thesis.updated': 1,
  'thesis.drift.detected': 1,
  'valuation.changed': 1,
  'intelligence.alert.triggered': 1,
};

export type PlatformEvent =
  | EventEnvelope<'company.updated', CompanyUpdatedPayload>
  | EventEnvelope<'filing.ingested', FilingIngestedPayload>
  | EventEnvelope<'fact.candidate.proposed', FactCandidateProposedPayload>
  | EventEnvelope<'fact.promoted', FactPromotedPayload>
  | EventEnvelope<'claim.status.changed', ClaimStatusChangedPayload>
  | EventEnvelope<'assumption.approved', AssumptionApprovedPayload>
  | EventEnvelope<'research.run.requested', ResearchRunRequestedPayload>
  | EventEnvelope<'research.run.completed', ResearchRunCompletedPayload>
  | EventEnvelope<'research.run.failed', ResearchRunFailedPayload>
  | EventEnvelope<'research.module.requested', ResearchModuleRequestedPayload>
  | EventEnvelope<'research.module.completed', ResearchModuleCompletedPayload>
  | EventEnvelope<'research.verification.requested', VerificationRequestedPayload>
  | EventEnvelope<'research.verification.completed', VerificationCompletedPayload>
  | EventEnvelope<'market.observation.ingested', MarketObservationIngestedPayload>
  | EventEnvelope<'thesis.updated', ThesisUpdatedPayload>
  | EventEnvelope<'thesis.drift.detected', ThesisDriftDetectedPayload>
  | EventEnvelope<'valuation.changed', ValuationChangedPayload>
  | EventEnvelope<'intelligence.alert.triggered', IntelligenceAlertTriggeredPayload>;

export type PayloadOf<T extends EventName> = Extract<PlatformEvent, { type: T }>['payload'];
