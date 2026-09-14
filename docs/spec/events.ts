export interface EventEnvelope<TPayload> {
  id: string;
  type: string;
  occurredAt: string;
  actor: 'system' | 'user' | 'provider' | 'workflow';
  payload: TPayload;
}

export interface CompanyUpdatedPayload { companyId: string; }
export interface FilingIngestedPayload { documentId: string; documentVersionId: string; }
export interface EvidenceCreatedPayload { claimId: string; }
export interface ResearchRunRequestedPayload { runId: string; subjectType: string; subjectId: string; }
export interface ResearchModuleRequestedPayload { runId: string; moduleRunId: string; }
export interface ResearchModuleCompletedPayload { runId: string; moduleRunId: string; moduleCode: string; }
export interface VerificationRequestedPayload { runId: string; targetType: string; targetId: string; }
export interface ThesisUpdatedPayload { subjectType: string; subjectId: string; thesisVersionId: string; }
export interface ValuationChangedPayload { subjectType: string; subjectId: string; valuationRunId: string; }
export interface IntelligenceAlertTriggeredPayload { alertRuleId: string; eventType: string; entityId: string; }

export type TradingEvent =
  | EventEnvelope<CompanyUpdatedPayload> & { type: 'company.updated' }
  | EventEnvelope<FilingIngestedPayload> & { type: 'filing.ingested' }
  | EventEnvelope<EvidenceCreatedPayload> & { type: 'evidence.created' }
  | EventEnvelope<ResearchRunRequestedPayload> & { type: 'research.run.requested' }
  | EventEnvelope<ResearchModuleRequestedPayload> & { type: 'research.module.requested' }
  | EventEnvelope<ResearchModuleCompletedPayload> & { type: 'research.module.completed' }
  | EventEnvelope<VerificationRequestedPayload> & { type: 'research.verification.requested' }
  | EventEnvelope<ThesisUpdatedPayload> & { type: 'thesis.updated' }
  | EventEnvelope<ValuationChangedPayload> & { type: 'valuation.changed' }
  | EventEnvelope<IntelligenceAlertTriggeredPayload> & { type: 'intelligence.alert.triggered' };

export const EVENT_NAMES = {
  COMPANY_UPDATED: 'company.updated',
  FILING_INGESTED: 'filing.ingested',
  EVIDENCE_CREATED: 'evidence.created',
  RESEARCH_RUN_REQUESTED: 'research.run.requested',
  RESEARCH_MODULE_REQUESTED: 'research.module.requested',
  RESEARCH_MODULE_COMPLETED: 'research.module.completed',
  RESEARCH_VERIFICATION_REQUESTED: 'research.verification.requested',
  THESIS_UPDATED: 'thesis.updated',
  VALUATION_CHANGED: 'valuation.changed',
  INTELLIGENCE_ALERT_TRIGGERED: 'intelligence.alert.triggered',
} as const;
