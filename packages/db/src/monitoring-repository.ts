import type { Pool } from 'pg';
import type { UUID } from '@mineral/domain';
import {
  DEFAULT_RULE_CONFIG,
  MONITORED_RULE_TYPES,
  evaluate,
  type AffectedNode,
  type AlertRule,
  type DriftReport,
  type Finding,
  type NewSource,
  type StaleReason,
  type ThesisState,
  type ValuationDrift,
  type ValuationMove,
} from '@mineral/monitoring';

/**
 * Monitoring (report J.10). It reads the latest thesis, works out what has
 * arrived or moved underneath it, and records an alert for each enabled rule
 * that has something to say.
 *
 * Every question here is asked of stored rows, which is the same discipline the
 * read models keep: monitoring never recomputes a valuation, never re-reads a
 * document, and never asks a model anything. Its job is to notice, not to
 * decide, and a notice that recalculated its own evidence would be a second
 * opinion rather than a watch.
 *
 * Re-running is free. Every alert carries a dedupe key that is a function of
 * its cause, and the unique index on that column drops the repeat, so a cron
 * every five minutes writes the same rows as a cron every day.
 */

export interface MonitorResult {
  report: DriftReport;
  findings: Finding[];
  /** Alerts written by this pass. Repeats of an earlier cause write nothing. */
  created: { alertEventId: UUID; finding: Finding }[];
}

export class MonitoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitoringError';
  }
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- rules ------------------------------------------------------------------

/**
 * Creates the rule rows monitoring v1 knows how to evaluate, once per user per
 * entity. There is no unique constraint behind this: a user may legitimately
 * want two price thresholds at different levels, so the schema does not forbid
 * duplicates and this checks instead of relying on a conflict clause.
 */
export async function ensureAlertRules(
  pool: Pool,
  input: { userId: UUID; companyId: UUID },
): Promise<AlertRule[]> {
  for (const ruleType of MONITORED_RULE_TYPES) {
    await pool.query(
      `insert into monitoring.alert_rules (user_id, entity_id, rule_type, rule_config)
       select $1, $2, $3, $4::jsonb
        where not exists (
          select 1 from monitoring.alert_rules
           where user_id = $1 and entity_id = $2 and rule_type = $3
        )`,
      [input.userId, input.companyId, ruleType, JSON.stringify(DEFAULT_RULE_CONFIG[ruleType])],
    );
  }
  return alertRules(pool, input.companyId);
}

/** Every enabled rule watching this entity, whoever owns it. */
export async function alertRules(pool: Pool, companyId: UUID): Promise<AlertRule[]> {
  const { rows } = await pool.query<{
    id: string;
    rule_type: string;
    rule_config: Record<string, unknown>;
  }>(
    `select id, rule_type, rule_config
       from monitoring.alert_rules
      where entity_id = $1 and enabled
      order by rule_type, created_at`,
    [companyId],
  );
  return rows.map((row) => ({ id: row.id, ruleType: row.rule_type, config: row.rule_config ?? {} }));
}

// --- drift ------------------------------------------------------------------

async function loadThesis(pool: Pool, companyId: UUID): Promise<ThesisState | null> {
  const { rows } = await pool.query<{
    id: string;
    version_no: number;
    verdict: string;
    research_run_id: string;
    run_started_at: string;
    created_at: string;
  }>(
    `select tv.id, tv.version_no, tv.verdict, tv.research_run_id,
            coalesce(r.started_at, r.requested_at)::text as run_started_at,
            tv.created_at::text
       from research.thesis_versions tv
       join research.runs r on r.id = tv.research_run_id
      where tv.subject_id = $1
      order by tv.version_no desc
      limit 1`,
    [companyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    thesisVersionId: row.id,
    versionNo: row.version_no,
    verdict: row.verdict,
    researchRunId: row.research_run_id,
    runStartedAt: row.run_started_at,
    createdAt: row.created_at,
  };
}

/**
 * Document versions about this company that were captured after the run behind
 * the current thesis began reading.
 *
 * The run's snapshot manifest would be the exact list of what it did read, and
 * it was tempting to diff against that. It answers a different question: a
 * document version with no chunks -- an XBRL payload, say -- can never enter a
 * snapshot, so it would show as new forever. Capture time answers the question
 * actually being asked, which is what arrived after the thesis was formed.
 */
async function loadNewSources(pool: Pool, companyId: UUID, thesis: ThesisState): Promise<NewSource[]> {
  const { rows } = await pool.query<{
    document_version_id: string;
    document_id: string;
    document_type: string;
    title: string;
    version_no: number;
    source_tier: number | null;
    published_at: string | null;
    captured_at: string;
  }>(
    `select dv.id as document_version_id, d.id as document_id, d.document_type, d.title,
            dv.version_no, s.source_tier,
            d.published_at::text, dv.captured_at::text
       from evidence.document_versions dv
       join evidence.documents d on d.id = dv.document_id
       join evidence.document_subjects ds on ds.document_id = d.id and ds.entity_id = $1
       join evidence.sources s on s.id = d.source_id
      where dv.captured_at > $2::timestamptz
      order by dv.captured_at`,
    [companyId, thesis.runStartedAt],
  );
  return rows.map((row) => ({
    documentVersionId: row.document_version_id,
    documentId: row.document_id,
    documentType: row.document_type,
    title: row.title,
    versionNo: row.version_no,
    sourceTier: row.source_tier,
    publishedAt: row.published_at,
    capturedAt: row.captured_at,
  }));
}

interface NodeEvidenceRow {
  node_id: string;
  node_type: string;
  statement: string;
  assumption_version_id: string | null;
  assumption_code: string | null;
  claim_id: string | null;
  claim_key: string | null;
  epistemic_status: string | null;
  cited_fact_version_id: string | null;
  current_fact_version_id: string | null;
  fact_code: string | null;
  cited_value: string | null;
  current_value: string | null;
  cited_document_version_id: string | null;
  document_title: string | null;
  newer_document_version_id: string | null;
  newer_version_no: number | null;
}

/**
 * Thesis nodes whose evidence has moved under them. The path is the one the
 * report names: node to claim, claim to `claim_evidence`, evidence to the fact
 * revision or document version it cites, and then the question of whether that
 * row is still the current one.
 *
 * An assumption node carries no claim of its own; the claim that founded it is
 * on the assumption revision, so both are folded into one column.
 */
async function loadAffected(pool: Pool, thesis: ThesisState): Promise<AffectedNode[]> {
  const { rows } = await pool.query<NodeEvidenceRow>(
    `with node_claims as (
       select n.id as node_id, n.node_type, n.statement,
              n.assumption_version_id, a.code as assumption_code,
              coalesce(n.claim_id, av.source_claim_id) as claim_id
         from research.thesis_nodes n
         left join valuation.assumption_versions av on av.id = n.assumption_version_id
         left join valuation.assumptions a on a.id = av.assumption_id
        where n.thesis_version_id = $1
     )
     select nc.node_id, nc.node_type, nc.statement,
            nc.assumption_version_id, nc.assumption_code,
            c.id as claim_id, c.claim_key, c.epistemic_status,
            ce.fact_version_id as cited_fact_version_id,
            f.current_version_id as current_fact_version_id,
            fd.code as fact_code,
            fv.numeric_value::text as cited_value,
            cur.numeric_value::text as current_value,
            ce.document_version_id as cited_document_version_id,
            d.title as document_title,
            newer.id as newer_document_version_id,
            newer.version_no as newer_version_no
       from node_claims nc
       join research.claims c on c.id = nc.claim_id
       left join research.claim_evidence ce on ce.claim_id = c.id
       left join evidence.fact_versions fv on fv.id = ce.fact_version_id
       left join evidence.facts f on f.id = fv.fact_id
       left join evidence.fact_definitions fd on fd.id = f.fact_definition_id
       left join evidence.fact_versions cur on cur.id = f.current_version_id
       left join evidence.document_versions dv on dv.id = ce.document_version_id
       left join evidence.documents d on d.id = dv.document_id
       left join lateral (
         select dv2.id, dv2.version_no
           from evidence.document_versions dv2
          where dv2.document_id = dv.document_id and dv2.version_no > dv.version_no
          order by dv2.version_no desc
          limit 1
       ) newer on true
      order by nc.node_id, ce.created_at`,
    [thesis.thesisVersionId],
  );

  const nodes = new Map<string, AffectedNode>();
  const seen = new Set<string>();

  for (const row of rows) {
    let existing = nodes.get(row.node_id);
    if (!existing) {
      existing = {
        nodeId: row.node_id,
        nodeType: row.node_type,
        statement: row.statement,
        claimId: row.claim_id,
        claimKey: row.claim_key,
        assumptionVersionId: row.assumption_version_id,
        assumptionCode: row.assumption_code,
        reasons: [],
      };
      nodes.set(row.node_id, existing);
    }
    const node = existing;

    const add = (reason: StaleReason): void => {
      const key = `${node.nodeId}:${reason.kind}:${reason.triggerRefId}`;
      if (seen.has(key)) return;
      seen.add(key);
      node.reasons.push(reason);
    };

    // Verification demotes a claim it caught out; a thesis still standing on
    // one is standing on a statement the system has already disowned.
    if (
      row.claim_id &&
      (row.epistemic_status === 'CONTRADICTED' || row.epistemic_status === 'STALE')
    ) {
      add({
        kind: 'claim_contradicted',
        triggerRefType: 'claim',
        triggerRefId: row.claim_id,
        status: row.epistemic_status,
      });
    }

    if (
      row.cited_fact_version_id &&
      row.current_fact_version_id &&
      row.current_fact_version_id !== row.cited_fact_version_id
    ) {
      add({
        kind: 'fact_moved',
        triggerRefType: 'fact_version',
        triggerRefId: row.current_fact_version_id,
        citedFactVersionId: row.cited_fact_version_id,
        code: row.fact_code,
        from: num(row.cited_value),
        to: num(row.current_value),
      });
    }

    if (row.cited_document_version_id && row.newer_document_version_id) {
      add({
        kind: 'document_superseded',
        triggerRefType: 'document_version',
        triggerRefId: row.newer_document_version_id,
        citedDocumentVersionId: row.cited_document_version_id,
        title: row.document_title,
        versionNo: row.newer_version_no ?? 0,
      });
    }
  }

  return [...nodes.values()].filter((node) => node.reasons.length > 0);
}

interface RunOutputRow {
  id: string;
  method: string;
  calculated_at: string;
  outputs: { code: string; name: string; value: number }[] | null;
}

/**
 * The valuation the thesis was written against, and the newest one since. Both
 * are stored runs; the only arithmetic is the comparison, which lands in an
 * alert rather than in the record.
 */
async function loadValuationDrift(pool: Pool, companyId: UUID, thesis: ThesisState): Promise<ValuationDrift | null> {
  const anchored = await pool.query<RunOutputRow>(
    `select cr.id, cr.method, cr.calculated_at::text, cr.output->'outputs' as outputs
       from research.thesis_nodes n
       join valuation.calculation_runs cr on cr.id = n.calculation_run_id
      where n.thesis_version_id = $1
      order by cr.calculated_at desc
      limit 1`,
    [thesis.thesisVersionId],
  );
  const before = anchored.rows[0];
  if (!before) return null;

  const newest = await pool.query<RunOutputRow>(
    `select cr.id, cr.method, cr.calculated_at::text, cr.output->'outputs' as outputs
       from valuation.calculation_runs cr
      where cr.subject_id = $1 and cr.status = 'completed' and cr.method = $2
      order by cr.calculated_at desc, cr.id
      limit 1`,
    [companyId, before.method],
  );
  const after = newest.rows[0];
  if (!after || after.id === before.id) return null;

  const wasByCode = new Map((before.outputs ?? []).map((output) => [output.code, output]));
  const moves: ValuationMove[] = (after.outputs ?? []).map((output) => {
    const was = wasByCode.get(output.code);
    const from = was ? was.value : null;
    return {
      code: output.code,
      name: output.name,
      from,
      to: output.value,
      changePct: from === null || from === 0 ? null : (output.value - from) / Math.abs(from),
    };
  });

  return {
    method: before.method,
    thesisCalculationRunId: before.id,
    latestCalculationRunId: after.id,
    calculatedAt: after.calculated_at,
    moves,
  };
}

/**
 * What has changed under the current thesis. Read-only: the report is the same
 * whether it is asked for once or a hundred times, and asking does not write.
 */
export async function driftReport(pool: Pool, companyId: UUID): Promise<DriftReport> {
  const thesis = await loadThesis(pool, companyId);
  if (!thesis) {
    return { companyId, thesis: null, newSources: [], affected: [], valuation: null };
  }

  const [newSources, affected, valuation] = await Promise.all([
    loadNewSources(pool, companyId, thesis),
    loadAffected(pool, thesis),
    loadValuationDrift(pool, companyId, thesis),
  ]);

  return { companyId, thesis, newSources, affected, valuation };
}

// --- alerts -----------------------------------------------------------------

export async function monitor(pool: Pool, companyId: UUID): Promise<MonitorResult> {
  const [rules, report] = await Promise.all([alertRules(pool, companyId), driftReport(pool, companyId)]);
  const findings = evaluate(rules, report);

  const created: MonitorResult['created'] = [];
  for (const finding of findings) {
    const { rows } = await pool.query<{ id: string }>(
      `insert into monitoring.alert_events
         (alert_rule_id, event_type, severity, trigger_ref_type, trigger_ref_id, dedupe_key, payload)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (dedupe_key) do nothing
       returning id`,
      [
        finding.ruleId,
        finding.eventType,
        finding.severity,
        finding.triggerRefType,
        finding.triggerRefId,
        finding.dedupeKey,
        JSON.stringify(finding.payload),
      ],
    );
    const id = rows[0]?.id;
    if (id) created.push({ alertEventId: id, finding });
  }

  return { report, findings, created };
}
