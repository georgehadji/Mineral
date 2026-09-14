import { describe, expect, it } from 'vitest';
import {
  EventEnvelopeSchema,
  ProposedClaimSchema,
  ResearchModuleOutputSchema,
  strongestSupportedStatus,
} from './index.ts';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const evidence = (tier: 1 | 2 | 3 | 4 | 5, quote: string | null = 'revenue was 253.4 million') => ({
  source: { sourceId: uuid(1), documentVersionId: uuid(2), chunkId: uuid(3) },
  role: 'supports' as const,
  strength: 0.9,
  sourceTier: tier,
  ...(quote === null ? {} : { quote }),
});

const claim = (status: string, ev: ReturnType<typeof evidence>[]) => ({
  claimKey: 'company:mp:revenue_trend',
  subject: { type: 'company' as const, id: uuid(10) },
  claimType: 'revenue_trend',
  statement: 'Revenue fell year over year.',
  epistemicStatus: status,
  confidence: 0.8,
  evidence: ev,
  factVersionIds: [uuid(11)],
});

describe('claim status cannot exceed its evidence', () => {
  it('accepts VERIFIED backed by a quoted tier-1 filing', () => {
    expect(ProposedClaimSchema.parse(claim('VERIFIED', [evidence(1)])).epistemicStatus).toBe('VERIFIED');
  });

  it('rejects VERIFIED backed only by tier-5 evidence', () => {
    const result = ProposedClaimSchema.safeParse(claim('VERIFIED', [evidence(5)]));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/exceeds what its evidence supports/);
  });

  it('rejects VERIFIED when the citation carries no verbatim quote', () => {
    expect(ProposedClaimSchema.safeParse(claim('VERIFIED', [evidence(1, null)])).success).toBe(false);
  });

  it('rejects an evidential claim with no supporting evidence at all', () => {
    const result = ProposedClaimSchema.safeParse(claim('INFERRED', []));
    expect(result.error?.issues[0]?.message).toMatch(/needs supporting evidence/);
  });

  it('allows a weaker status than the evidence would permit', () => {
    expect(ProposedClaimSchema.safeParse(claim('HYPOTHESIS', [evidence(1)])).success).toBe(true);
  });

  it('takes the strongest supporting citation', () => {
    expect(strongestSupportedStatus([evidence(4), evidence(1)])).toBe('VERIFIED');
    expect(strongestSupportedStatus([])).toBeNull();
  });

  it('ignores contradicting citations when deciding the ceiling', () => {
    const contradicting = { ...evidence(1), role: 'contradicts' as const };
    expect(strongestSupportedStatus([contradicting])).toBeNull();
  });
});

describe('module output', () => {
  it('fills the optional collections', () => {
    const out = ResearchModuleOutputSchema.parse({ data: { ok: true } });
    expect(out.claims).toEqual([]);
    expect(out.warnings).toEqual([]);
  });

  it('rejects a module that smuggles in an unsupported claim', () => {
    const bad = { data: {}, claims: [claim('VERIFIED', [evidence(5)])] };
    expect(ResearchModuleOutputSchema.safeParse(bad).success).toBe(false);
  });
});

describe('event envelope', () => {
  const base = {
    id: uuid(20),
    type: 'fact.promoted',
    version: 1,
    occurredAt: '2026-09-14T10:00:00Z',
    actor: 'workflow',
    correlationId: uuid(21),
    idempotencyKey: 'fact.promoted:' + uuid(22),
    payload: { factId: uuid(23), factVersionId: uuid(22), promotedBy: 'validator' },
  };

  it('accepts a current envelope', () => {
    expect(EventEnvelopeSchema.parse(base).type).toBe('fact.promoted');
  });

  it('rejects an unknown event type', () => {
    expect(EventEnvelopeSchema.safeParse({ ...base, type: 'fact.invented' }).success).toBe(false);
  });

  it('rejects a payload version the platform does not serve', () => {
    const result = EventEnvelopeSchema.safeParse({ ...base, version: 2 });
    expect(result.error?.issues[0]?.message).toMatch(/is at version 1/);
  });

  it('requires an idempotency key', () => {
    expect(EventEnvelopeSchema.safeParse({ ...base, idempotencyKey: '' }).success).toBe(false);
  });
});
