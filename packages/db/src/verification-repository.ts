import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import {
  verifyClaims,
  type CheckResult,
  type VerifiableClaim,
  type VerifiableEvidence,
  type VerificationVerdict,
} from '@mineral/research';
import { inTransaction } from './client.ts';

/**
 * Verification (report J.7). It reads what a run wrote, applies the
 * deterministic rules in packages/research, records every check, and demotes
 * the claims that failed.
 *
 * It runs against stored rows rather than module output on purpose. The
 * runtime already refuses a bad citation on the way in; this pass can be run
 * again next year, against a claim whose source document has since changed, and
 * give an answer that is still checkable.
 */

export interface VerificationResult {
  verificationRunId: UUID;
  runId: UUID;
  overall: 'passed' | 'warnings' | 'failed';
  claimsChecked: number;
  checks: CheckResult[];
  /** Claims demoted to CONTRADICTED by this pass. */
  contradicted: UUID[];
}

export class VerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VerificationError';
  }
}

interface ClaimRow {
  claim_id: string;
  claim_key: string;
  claim_type: string;
  statement: string;
  epistemic_status: string;
  chunk_id: string | null;
  fact_version_id: string | null;
  quote_excerpt: string | null;
  text_content: string | null;
  source_tier: number | null;
  fact_value: string | null;
  period_end: string | null;
}

/**
 * One row per claim per citation, folded into claims in memory. A claim with no
 * evidence still appears, with an empty evidence list, because "cites nothing"
 * is a verdict the rules have to be able to reach.
 */
async function loadClaims(pool: Pool, runId: UUID): Promise<VerifiableClaim[]> {
  const { rows } = await pool.query<ClaimRow>(
    `select c.id as claim_id, c.claim_key, c.claim_type, c.statement, c.epistemic_status,
            ce.chunk_id, ce.fact_version_id, ce.quote_excerpt,
            dc.text_content, s.source_tier,
            coalesce(fv.numeric_value::text, fv.text_value, fv.boolean_value::text,
                     fv.date_value::text, fv.json_value::text) as fact_value,
            -- What the cited evidence is about: the cited fact's own period
            -- first, then the publication date of the cited filing.
            coalesce(f.period_end::text, f.as_of_date::text, d.published_at::text) as period_end
       from research.claims c
       left join research.claim_evidence ce on ce.claim_id = c.id
       left join evidence.document_chunks dc on dc.id = ce.chunk_id
       left join evidence.document_versions dv on dv.id = ce.document_version_id
       left join evidence.documents d on d.id = dv.document_id
       left join evidence.sources s on s.id = d.source_id
       left join evidence.fact_versions fv on fv.id = ce.fact_version_id
       left join evidence.facts f on f.id = fv.fact_id
      where c.run_id = $1
      order by c.created_at, ce.created_at`,
    [runId],
  );

  const claims = new Map<string, VerifiableClaim>();
  for (const row of rows) {
    let claim = claims.get(row.claim_id);
    if (!claim) {
      claim = {
        claimId: row.claim_id,
        claimKey: row.claim_key,
        claimType: row.claim_type,
        statement: row.statement,
        status: row.epistemic_status,
        evidence: [],
      };
      claims.set(row.claim_id, claim);
    }
    if (row.chunk_id === null && row.fact_version_id === null) continue;
    const evidence: VerifiableEvidence = {
      chunkId: row.chunk_id,
      factVersionId: row.fact_version_id,
      quote: row.quote_excerpt,
      chunkText: row.text_content,
      sourceTier: row.source_tier,
      factValue: row.fact_value,
      periodEnd: row.period_end,
    };
    claim.evidence.push(evidence);
  }
  return [...claims.values()];
}

export async function verifyRun(pool: Pool, runId: UUID): Promise<VerificationResult> {
  const { rows: runRows } = await pool.query<{ id: string }>(
    `select id from research.runs where id = $1`,
    [runId],
  );
  if (!runRows[0]) throw new VerificationError(`no run with id ${runId}`);

  const claims = await loadClaims(pool, runId);
  const verdict = verifyClaims(claims);

  const verificationRunId = await inTransaction(pool, async (client) => {
    const id = await openVerificationRun(client, runId, verdict, claims.length);
    const checkIds = await recordChecks(client, id, verdict.checks);
    await demote(client, verdict, checkIds);
    return id;
  });

  return {
    verificationRunId,
    runId,
    overall: verdict.overall,
    claimsChecked: claims.length,
    checks: verdict.checks,
    contradicted: verdict.contradicted,
  };
}

async function openVerificationRun(
  client: PoolClient,
  runId: UUID,
  verdict: VerificationVerdict,
  claimsChecked: number,
): Promise<UUID> {
  const summary = {
    claimsChecked,
    passed: verdict.checks.filter((check) => check.status === 'passed').length,
    failed: verdict.checks.filter((check) => check.status === 'failed').length,
    skipped: verdict.checks.filter((check) => check.status === 'skipped').length,
    contradicted: verdict.contradicted.length,
  };
  const { rows } = await client.query<{ id: string }>(
    `insert into research.verification_runs
       (research_run_id, target_type, target_id, overall_status, completed_at, summary)
     values ($1, 'research_run', $1, $2, now(), $3::jsonb)
     returning id`,
    [runId, verdict.overall, JSON.stringify(summary)],
  );
  const id = rows[0]?.id;
  if (!id) throw new VerificationError('could not open the verification run');
  return id;
}

/** Returns the first failing check per claim, which is what a status event cites. */
async function recordChecks(
  client: PoolClient,
  verificationRunId: UUID,
  checks: CheckResult[],
): Promise<Map<string, { id: UUID; message: string }>> {
  const firstFailure = new Map<string, { id: UUID; message: string }>();
  for (const check of checks) {
    const { rows } = await client.query<{ id: string }>(
      `insert into research.verification_checks
         (verification_run_id, check_type, status, severity, claim_id, message, evidence)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       returning id`,
      [
        verificationRunId,
        check.type,
        check.status,
        check.severity,
        check.claimId,
        check.message,
        JSON.stringify(check.evidence),
      ],
    );
    const id = rows[0]?.id;
    if (!id) throw new VerificationError(`could not record a ${check.type} check`);
    const serious = check.status === 'failed' && (check.severity === 'error' || check.severity === 'critical');
    if (serious && !firstFailure.has(check.claimId)) {
      firstFailure.set(check.claimId, { id, message: check.message });
    }
  }
  return firstFailure;
}

/**
 * A claim that failed a serious check becomes CONTRADICTED. The status history
 * is written by a trigger on the claims table, so the event already exists by
 * the time this returns; what it does not know is who changed the status and
 * why, and that is filled in here against the newest event for the claim.
 *
 * Promotion is deliberately absent. Report G gives the validator the authority
 * to assign VERIFIED, but invariant C.7 forbids any claim authored by a model
 * from holding that status, so promoting one in place is not possible: it would
 * have to be a new system-authored claim superseding the model's. Nothing reads
 * VERIFIED yet, so that waits for the phase that does.
 */
async function demote(
  client: PoolClient,
  verdict: VerificationVerdict,
  checkIds: Map<string, { id: UUID; message: string }>,
): Promise<void> {
  for (const claimId of verdict.contradicted) {
    const failure = checkIds.get(claimId);
    const { rowCount } = await client.query(
      `update research.claims
          set epistemic_status = 'CONTRADICTED'
        where id = $1 and epistemic_status <> 'CONTRADICTED'`,
      [claimId],
    );
    if (!rowCount) continue;
    await client.query(
      `update research.claim_status_events
          set changed_by = 'verification', verification_check_id = $2, reason = $3
        where id = (
          select id from research.claim_status_events
           where claim_id = $1 order by seq desc limit 1
        )`,
      [claimId, failure?.id ?? null, failure?.message ?? 'failed verification'],
    );
  }
}

/** The most recent completed run for a subject, which is what a CLI wants. */
export async function latestRunFor(pool: Pool, companyId: UUID): Promise<UUID | null> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from research.runs
      where subject_id = $1 and status = 'completed'
      order by requested_at desc limit 1`,
    [companyId],
  );
  return rows[0]?.id ?? null;
}
