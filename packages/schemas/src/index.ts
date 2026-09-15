/**
 * Runtime mirrors of the domain types. Module output crosses a trust boundary
 * (an LLM produced it), so it is parsed here before anything is persisted.
 */
import { z } from 'zod';
import { EVENT_VERSIONS } from '@mineral/events';

export const EntityTypeSchema = z.enum([
  'company',
  'security',
  'listing',
  'commodity',
  'material',
  'element',
  'theme',
  'project',
  'facility',
  'country',
  'supply_chain_stage',
  'end_market',
  'portfolio',
]);

export const EpistemicStatusSchema = z.enum([
  'VERIFIED',
  'CALCULATED',
  'DERIVED',
  'INFERRED',
  'HYPOTHESIS',
  'UNKNOWN',
  'CONTRADICTED',
  'STALE',
]);

export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;

export const SourceTierSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

export const EntityRefSchema = z.object({
  type: EntityTypeSchema,
  id: z.string().uuid(),
});

export const SourceRefSchema = z.object({
  sourceId: z.string().uuid(),
  documentId: z.string().uuid().optional(),
  documentVersionId: z.string().uuid().optional(),
  chunkId: z.string().uuid().optional(),
  url: z.string().url().optional(),
  page: z.number().int().positive().optional(),
});

export const EvidenceRefSchema = z.object({
  source: SourceRefSchema,
  role: z.enum(['supports', 'contradicts', 'context']),
  strength: z.number().min(0).max(1),
  sourceTier: SourceTierSchema,
  quote: z.string().min(1).optional(),
});

export const FactViewSchema = z.object({
  factId: z.string().uuid(),
  factVersionId: z.string().uuid(),
  definitionCode: z.string().min(1),
  entity: EntityRefSchema,
  valueNumeric: z.number().optional(),
  valueText: z.string().optional(),
  valueJson: z.unknown().optional(),
  unit: z.string().optional(),
  currency: z.string().length(3).optional(),
  periodStart: IsoDateSchema.optional(),
  periodEnd: IsoDateSchema.optional(),
  asOfDate: IsoDateSchema.optional(),
  qualifiers: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  status: EpistemicStatusSchema,
  extractionMethod: z.enum(['xbrl', 'provider', 'manual', 'llm', 'calculated']),
  sourceTier: SourceTierSchema,
  source: SourceRefSchema.optional(),
});

/**
 * Proposed rule 7 extension: a claim's epistemic status cannot exceed the
 * strongest status its supporting evidence can carry. Source tier caps the
 * status, which makes the rule mechanically checkable instead of advisory.
 */
const MAX_STATUS_BY_TIER = {
  1: 'VERIFIED',
  2: 'VERIFIED',
  3: 'INFERRED',
  4: 'INFERRED',
  5: 'HYPOTHESIS',
} as const;

/** Higher wins. Statuses outside the evidential ladder are not ranked here. */
const STATUS_RANK: Record<string, number> = {
  HYPOTHESIS: 1,
  INFERRED: 2,
  DERIVED: 3,
  CALCULATED: 4,
  VERIFIED: 5,
};

/** Statuses that must be earned from evidence rather than asserted. */
const EVIDENTIAL_STATUSES = ['VERIFIED', 'INFERRED', 'HYPOTHESIS'] as const;

export type EvidenceInput = z.infer<typeof EvidenceRefSchema>;

/** Strongest status the supporting evidence permits, or null if there is none. */
export function strongestSupportedStatus(evidence: readonly EvidenceInput[]): string | null {
  const supporting = evidence.filter((e) => e.role === 'supports');
  if (supporting.length === 0) return null;
  let best: string | null = null;
  for (const e of supporting) {
    // An unquoted citation cannot carry VERIFIED: rule 14 needs a verbatim span.
    const capped = e.quote ? MAX_STATUS_BY_TIER[e.sourceTier] : 'INFERRED';
    if (best === null || STATUS_RANK[capped]! > STATUS_RANK[best]!) best = capped;
  }
  return best;
}

export type FactExtractionMethod = 'xbrl' | 'provider' | 'manual' | 'llm' | 'calculated';
export type FactRevisionStatus = 'candidate' | 'promoted' | 'rejected' | 'superseded';

export interface FactStatusInput {
  extractionMethod: FactExtractionMethod;
  /** Tier of the source the value was read from. A calculated value has no
   *  source of its own -- its inputs carry the tiers -- so it has none. */
  sourceTier?: 1 | 2 | 3 | 4 | 5;
  status: FactRevisionStatus;
  /** Verbatim span the value was read from, where the method needs one. */
  quote?: string | null;
}

/**
 * Epistemic status of one stored fact revision. Same ceiling as claims: the
 * source tier caps what a value may be called, and an LLM reading with no
 * verbatim quote cannot reach VERIFIED (rule 14). A value that has not been
 * promoted is not part of the record, whatever its source.
 */
export function factEpistemicStatus(input: FactStatusInput): EpistemicStatus {
  switch (input.status) {
    case 'candidate':
      return 'HYPOTHESIS';
    case 'rejected':
      return 'UNKNOWN';
    case 'superseded':
      return 'STALE';
    default:
      break;
  }
  if (input.extractionMethod === 'calculated') return 'CALCULATED';
  if (input.extractionMethod === 'llm' && !input.quote) return 'INFERRED';
  if (!input.sourceTier) {
    throw new Error(`a ${input.extractionMethod} fact needs the tier of the source it was read from`);
  }
  return MAX_STATUS_BY_TIER[input.sourceTier];
}

export const ProposedClaimSchema = z
  .object({
    claimKey: z.string().min(1),
    subject: EntityRefSchema,
    claimType: z.string().min(1),
    statement: z.string().min(1),
    epistemicStatus: EpistemicStatusSchema,
    confidence: z.number().min(0).max(1),
    validFrom: IsoDateSchema.optional(),
    validTo: IsoDateSchema.optional(),
    evidence: z.array(EvidenceRefSchema).default([]),
    factVersionIds: z.array(z.string().uuid()).default([]),
  })
  .superRefine((claim, ctx) => {
    const status = claim.epistemicStatus;
    if (!(EVIDENTIAL_STATUSES as readonly string[]).includes(status)) return;

    const supported = strongestSupportedStatus(claim.evidence);
    if (supported === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evidence'],
        message: `claim status ${status} needs supporting evidence`,
      });
      return;
    }
    if (STATUS_RANK[status]! > STATUS_RANK[supported]!) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['epistemicStatus'],
        message: `claim status ${status} exceeds what its evidence supports (${supported})`,
      });
    }
  });

export const ProposedAssumptionSchema = z.object({
  subject: EntityRefSchema,
  code: z.string().min(1),
  name: z.string().min(1),
  value: z.union([z.number(), z.string()]),
  unit: z.string().optional(),
  rationale: z.string().optional(),
  sourceClaimKey: z.string().optional(),
});

export const ResearchModuleOutputSchema = z.object({
  data: z.unknown(),
  claims: z.array(ProposedClaimSchema).default([]),
  assumptions: z.array(ProposedAssumptionSchema).default([]),
  warnings: z.array(z.string()).default([]),
  requiredFollowUps: z.array(z.string()).default([]),
});

const EVENT_NAME_VALUES = Object.keys(EVENT_VERSIONS) as [string, ...string[]];

/** Envelope contract from packages/events, enforced at the transport boundary. */
export const EventEnvelopeSchema = z
  .object({
    id: z.string().uuid(),
    type: z.enum(EVENT_NAME_VALUES),
    version: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    actor: z.enum(['system', 'user', 'provider', 'workflow']),
    correlationId: z.string().uuid(),
    causationId: z.string().uuid().optional(),
    idempotencyKey: z.string().min(1),
    payload: z.record(z.unknown()),
  })
  .superRefine((event, ctx) => {
    const expected = EVENT_VERSIONS[event.type as keyof typeof EVENT_VERSIONS];
    if (event.version !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: `event ${event.type} is at version ${expected}, got ${event.version}`,
      });
    }
  });

/** Methods valuation.calculation_runs accepts; the engine implements a subset. */
export const CALC_METHOD_VALUES = [
  'ratios',
  'dcf',
  'reverse_dcf',
  'pe',
  'ev_ebitda',
  'ev_sales',
  'fcf_yield',
  'nav',
  'sotp',
  'scenario',
] as const;

const CalcInputValueSchema = z.union([z.number().finite(), z.array(z.number().finite()).min(1)]);

export const CalcOutputSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  /** Input codes the number was computed from. A derivation names its inputs
   *  or it is not a derivation, so an empty list is rejected here. */
  inputs: z.array(z.string().min(1)).min(1),
});

/**
 * Response of POST /calc/{method}. Parsed, not trusted: the analytics service
 * is ours, but a value on its way to evidence.facts as CALCULATED has to
 * arrive with a unit and named inputs, and nothing downstream re-checks that.
 */
export const CalcResponseSchema = z.object({
  method: z.enum(CALC_METHOD_VALUES),
  engine: z.string().min(1),
  engine_version: z.string().min(1),
  currency: z.string().length(3),
  inputs: z.record(CalcInputValueSchema),
  outputs: z.array(CalcOutputSchema).min(1),
  detail: z.record(z.unknown()),
});

export type CalcMethod = (typeof CALC_METHOD_VALUES)[number];
export type CalcOutput = z.infer<typeof CalcOutputSchema>;
export type CalcResponse = z.infer<typeof CalcResponseSchema>;
