import type { UUID } from '@mineral/domain';

/**
 * Monitoring rules (report J.10). A thesis is a statement about the world made
 * at one moment from one set of documents. The world then carries on. These
 * rules are the deterministic answer to "is that statement still resting on
 * what it was resting on", and every one of them is a function of stored rows:
 * no model, no judgement, same input, same verdict.
 *
 * Nothing here decides anything. An alert says the ground under a thesis moved
 * and points at the row that moved it; whether the thesis is now wrong is a
 * question for the next run, and for a person.
 */

export type AlertRuleType = 'new_primary_source' | 'assumption_invalidated' | 'valuation_threshold';
export type AlertSeverity = 'info' | 'warning' | 'critical';

/** The subset of `monitoring.alert_events.trigger_ref_type` this phase uses. */
export type TriggerRefType = 'claim' | 'fact_version' | 'document_version' | 'calculation_run';

/** The rule types monitoring v1 implements. The schema allows ten more. */
export const MONITORED_RULE_TYPES: readonly AlertRuleType[] = [
  'new_primary_source',
  'assumption_invalidated',
  'valuation_threshold',
];

export const DEFAULT_RULE_CONFIG: Record<AlertRuleType, Record<string, unknown>> = {
  // Tier 1 is the filer or the regulator, tier 2 an exchange or an audited
  // report. Below that a "new source" is commentary, and commentary arriving
  // is not news about the company.
  new_primary_source: { maxTier: 2 },
  assumption_invalidated: {},
  // A tenth. Large enough that rounding in the engine never fires it, small
  // enough to catch a move worth reading about.
  valuation_threshold: { movePct: 0.1 },
};

export interface AlertRule {
  id: UUID;
  ruleType: string;
  config: Record<string, unknown>;
}

export interface ThesisState {
  thesisVersionId: UUID;
  versionNo: number;
  verdict: string;
  researchRunId: UUID;
  /** When the run that produced this thesis began reading. */
  runStartedAt: string;
  createdAt: string;
}

export interface NewSource {
  documentVersionId: UUID;
  documentId: UUID;
  documentType: string;
  title: string;
  versionNo: number;
  sourceTier: number | null;
  publishedAt: string | null;
  capturedAt: string;
}

/**
 * Why a thesis node is no longer resting on what it rested on. Each case
 * carries the row that displaced it, which is what the alert points at.
 */
export type StaleReason =
  | {
      kind: 'fact_moved';
      triggerRefType: 'fact_version';
      triggerRefId: UUID;
      citedFactVersionId: UUID;
      code: string | null;
      from: number | null;
      to: number | null;
    }
  | {
      kind: 'document_superseded';
      triggerRefType: 'document_version';
      triggerRefId: UUID;
      citedDocumentVersionId: UUID;
      title: string | null;
      versionNo: number;
    }
  | {
      kind: 'claim_contradicted';
      triggerRefType: 'claim';
      triggerRefId: UUID;
      status: string;
    };

export interface AffectedNode {
  nodeId: UUID;
  nodeType: string;
  statement: string;
  claimId: UUID | null;
  claimKey: string | null;
  assumptionVersionId: UUID | null;
  assumptionCode: string | null;
  reasons: StaleReason[];
}

export interface ValuationMove {
  code: string;
  name: string;
  from: number | null;
  to: number;
  /** Signed, relative to the value the thesis was written against. */
  changePct: number | null;
}

export interface ValuationDrift {
  method: string;
  thesisCalculationRunId: UUID;
  latestCalculationRunId: UUID;
  calculatedAt: string;
  moves: ValuationMove[];
}

export interface DriftReport {
  companyId: UUID;
  /** Null when no thesis exists, in which case there is nothing to drift from. */
  thesis: ThesisState | null;
  newSources: NewSource[];
  affected: AffectedNode[];
  valuation: ValuationDrift | null;
}

export interface Finding {
  ruleId: UUID;
  ruleType: AlertRuleType;
  eventType: string;
  severity: AlertSeverity;
  triggerRefType: TriggerRefType;
  triggerRefId: UUID;
  /**
   * The same cause reported twice is one alert. The key is a function of the
   * cause, so re-running monitoring is free: the unique index on
   * `alert_events.dedupe_key` drops the repeat.
   */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function stringsOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : null;
}

/**
 * A primary source the current thesis never read. Tier decides how loud it is:
 * a filing is the company speaking under law, and that outranks an exchange
 * notice, which outranks everything this rule already declines to look at.
 */
function newPrimarySource(rule: AlertRule, report: DriftReport): Finding[] {
  const maxTier = numberOr(rule.config.maxTier, 2);
  const types = stringsOrNull(rule.config.documentTypes);

  return report.newSources
    .filter((source) => source.sourceTier !== null && source.sourceTier <= maxTier)
    .filter((source) => types === null || types.includes(source.documentType))
    .map((source) => ({
      ruleId: rule.id,
      ruleType: 'new_primary_source' as const,
      eventType: 'new_primary_source',
      severity: source.sourceTier === 1 ? ('warning' as const) : ('info' as const),
      triggerRefType: 'document_version' as const,
      triggerRefId: source.documentVersionId,
      dedupeKey: `${rule.id}:new_primary_source:${source.documentVersionId}`,
      payload: {
        documentId: source.documentId,
        documentType: source.documentType,
        title: source.title,
        versionNo: source.versionNo,
        sourceTier: source.sourceTier,
        publishedAt: source.publishedAt,
        capturedAt: source.capturedAt,
        thesisVersionId: report.thesis?.thesisVersionId ?? null,
        message:
          `${source.documentType} "${source.title}" arrived after thesis ` +
          `v${report.thesis?.versionNo ?? 0}`,
      },
    }));
}

function describe(node: AffectedNode, reason: StaleReason): string {
  const subject = node.assumptionCode ?? node.nodeType.toLowerCase();
  switch (reason.kind) {
    case 'fact_moved':
      return `${subject} rests on ${reason.code ?? 'a fact'}, which moved from ${reason.from} to ${reason.to}`;
    case 'document_superseded':
      return `${subject} cites a document version superseded by v${reason.versionNo}`;
    case 'claim_contradicted':
      return `${subject} rests on a claim now marked ${reason.status}`;
  }
}

/**
 * An approved assumption whose founding claim no longer stands. Scoped to
 * assumption nodes because that is the rule the report names; the drift report
 * carries every affected node, assumption or not.
 */
function assumptionInvalidated(rule: AlertRule, report: DriftReport): Finding[] {
  const thesis = report.thesis;
  if (!thesis) return [];

  const findings: Finding[] = [];
  for (const node of report.affected) {
    if (!node.assumptionVersionId) continue;
    for (const reason of node.reasons) {
      findings.push({
        ruleId: rule.id,
        ruleType: 'assumption_invalidated',
        eventType: 'assumption_invalidated',
        // A contradicted claim is a verdict already reached; a moved number is
        // a question still open.
        severity: reason.kind === 'claim_contradicted' ? 'critical' : 'warning',
        triggerRefType: reason.triggerRefType,
        triggerRefId: reason.triggerRefId,
        dedupeKey:
          `${rule.id}:assumption_invalidated:${thesis.thesisVersionId}:` +
          `${node.nodeId}:${reason.kind}:${reason.triggerRefId}`,
        payload: {
          thesisVersionId: thesis.thesisVersionId,
          nodeId: node.nodeId,
          assumptionVersionId: node.assumptionVersionId,
          assumptionCode: node.assumptionCode,
          claimId: node.claimId,
          claimKey: node.claimKey,
          reason,
          message: describe(node, reason),
        },
      });
    }
  }
  return findings;
}

/**
 * The valuation has moved since the thesis was written against it. The
 * comparison is between two stored runs; nothing is recomputed here, because a
 * monitor that recalculates is a second opinion rather than a watch.
 */
function valuationThreshold(rule: AlertRule, report: DriftReport): Finding[] {
  const thesis = report.thesis;
  const drift = report.valuation;
  if (!thesis || !drift) return [];
  const movePct = numberOr(rule.config.movePct, 0.1);

  const findings: Finding[] = [];
  for (const move of drift.moves) {
    if (move.changePct === null || Math.abs(move.changePct) < movePct) continue;
    findings.push({
      ruleId: rule.id,
      ruleType: 'valuation_threshold',
      eventType: 'valuation_threshold',
      severity: Math.abs(move.changePct) >= movePct * 2 ? 'critical' : 'warning',
      triggerRefType: 'calculation_run',
      triggerRefId: drift.latestCalculationRunId,
      dedupeKey:
        `${rule.id}:valuation_threshold:${thesis.thesisVersionId}:` +
        `${drift.latestCalculationRunId}:${move.code}`,
      payload: {
        thesisVersionId: thesis.thesisVersionId,
        method: drift.method,
        thesisCalculationRunId: drift.thesisCalculationRunId,
        latestCalculationRunId: drift.latestCalculationRunId,
        calculatedAt: drift.calculatedAt,
        code: move.code,
        from: move.from,
        to: move.to,
        changePct: move.changePct,
        message: `${move.name} moved ${(move.changePct * 100).toFixed(1)}% since thesis v${thesis.versionNo}`,
      },
    });
  }
  return findings;
}

/**
 * Rule types this phase does not implement are skipped rather than rejected:
 * the schema allows thirteen, the report asks for three, and a rule row for one
 * of the other ten is a plan, not an error.
 */
export function evaluate(rules: AlertRule[], report: DriftReport): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    switch (rule.ruleType) {
      case 'new_primary_source':
        findings.push(...newPrimarySource(rule, report));
        break;
      case 'assumption_invalidated':
        findings.push(...assumptionInvalidated(rule, report));
        break;
      case 'valuation_threshold':
        findings.push(...valuationThreshold(rule, report));
        break;
      default:
        break;
    }
  }
  return findings;
}
