/** Small shared pieces. No data access, no state -- labels and colours only. */

const VERDICT_TONE: Record<string, string> = {
  bullish: 'good',
  bearish: 'bad',
  neutral: '',
  insufficient_evidence: 'warn',
};

export function Verdict({ verdict }: { verdict: string }) {
  return (
    <span className={`tag ${VERDICT_TONE[verdict] ?? ''}`}>{verdict.replace(/_/g, ' ')}</span>
  );
}

const STATUS_TONE: Record<string, string> = {
  VERIFIED: 'good',
  CALCULATED: 'good',
  DERIVED: '',
  INFERRED: 'warn',
  HYPOTHESIS: 'warn',
  UNKNOWN: 'warn',
  CONTRADICTED: 'bad',
  STALE: 'bad',
  completed: 'good',
  passed: 'good',
  approved: 'good',
  running: 'warn',
  queued: 'warn',
  proposed: 'warn',
  warnings: 'warn',
  failed: 'bad',
  rejected: 'bad',
  cancelled: 'bad',
};

export function Status({ status }: { status: string }) {
  return <span className={`tag ${STATUS_TONE[status] ?? ''}`}>{status}</span>;
}

/** Tier 1 and 2 may back a financial fact; 4 and 5 are leads only (C.12). */
export function Tier({ tier }: { tier: number | null }) {
  if (tier === null) return <span className="tag">tier ?</span>;
  return <span className={`tag ${tier <= 2 ? 'good' : tier >= 4 ? 'warn' : ''}`}>tier {tier}</span>;
}
