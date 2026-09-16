import { z } from 'zod';

/**
 * The decision layer, pure half (report J.8).
 *
 * Two deterministic gates live here. The first decides which proposed
 * assumptions a valuation is allowed to rest on; the second decides whether a
 * proposed thesis is anchored to anything real. Both are the same idea applied
 * twice: a model may propose, and only a rule may accept.
 *
 * Report I.22 splits what the recipe used to call one `valuation` module into
 * `valuation_assumptions` (a model proposes) -> `assumption_policy` (this file
 * decides) -> `valuation_calc` (the Python engine computes). Nothing here does
 * arithmetic that lands in state, and nothing here reaches a database.
 */

// --- assumption policy ------------------------------------------------------

export interface AssumptionBand {
  unit: string;
  min: number;
  max: number;
  integer?: boolean;
}

/**
 * The inputs a valuation here may be driven by, and the range each is allowed
 * to take. A band is not a forecast: it is the range outside which a number is
 * a typo or a hallucination rather than a view. Anything not listed is refused,
 * because an assumption no method consumes cannot be checked by any of them.
 */
export const ASSUMPTION_BANDS: Readonly<Record<string, AssumptionBand>> = {
  discount_rate: { unit: 'ratio', min: 0.03, max: 0.3 },
  terminal_growth: { unit: 'ratio', min: -0.02, max: 0.05 },
  growth_rate: { unit: 'ratio', min: -0.5, max: 1 },
  projection_years: { unit: 'years', min: 1, max: 10, integer: true },
};

/** Every code above has to be approved before a DCF can run. */
export const DCF_ASSUMPTION_CODES: readonly string[] = Object.keys(ASSUMPTION_BANDS);

export interface PolicyInput {
  code: string;
  value: number;
  minValue: number | null;
  maxValue: number | null;
  rationale: string | null;
  /** Epistemic status of the claim it rests on; null when it rests on none. */
  sourceClaimStatus: string | null;
}

export interface PolicyDecision {
  code: string;
  status: 'approved' | 'rejected';
  reason: string;
}

/**
 * Statuses an assumption may be founded on. CONTRADICTED and STALE are the
 * point of the list: verification demotes a claim in place, and an assumption
 * that outlives the claim under it is how a stale number keeps its authority.
 *
 * VERIFIED is listed but unreachable today. Invariant C.7 forbids a claim
 * authored by a model from holding it, so promotion, when it lands, has to
 * write a new system-authored claim rather than change one in place. Naming it
 * here costs nothing and stops the set from having to change then.
 */
const FOUNDABLE_STATUSES = new Set(['VERIFIED', 'CALCULATED', 'DERIVED', 'INFERRED']);

/**
 * Deterministic approval. Takes the whole proposed set because one rule is
 * about the set: a terminal growth at or above the discount rate makes the
 * Gordon terminal value infinite or negative. The engine would refuse it
 * anyway; saying why here beats reading it out of a stack trace later.
 */
export function applyPolicy(proposals: readonly PolicyInput[]): PolicyDecision[] {
  const byCode = new Map(proposals.map((proposal) => [proposal.code, proposal]));
  return proposals.map((proposal) => ({ code: proposal.code, ...judge(proposal, byCode) }));
}

function judge(
  proposal: PolicyInput,
  byCode: ReadonlyMap<string, PolicyInput>,
): { status: 'approved' | 'rejected'; reason: string } {
  const reject = (reason: string) => ({ status: 'rejected' as const, reason });

  const band = ASSUMPTION_BANDS[proposal.code];
  if (!band) return reject(`${proposal.code} is not an input to any method here`);

  if (!Number.isFinite(proposal.value)) return reject('value is not a finite number');
  if (band.integer && !Number.isInteger(proposal.value)) {
    return reject(`${proposal.code} must be a whole number of ${band.unit}`);
  }
  if (proposal.value < band.min || proposal.value > band.max) {
    return reject(`${proposal.value} is outside the allowed band ${band.min} to ${band.max}`);
  }
  if (
    proposal.minValue !== null &&
    proposal.maxValue !== null &&
    (proposal.value < proposal.minValue || proposal.value > proposal.maxValue)
  ) {
    return reject(`value ${proposal.value} falls outside its own stated range`);
  }
  if (!proposal.rationale || proposal.rationale.trim().length === 0) {
    return reject('no rationale; an unexplained assumption cannot be reviewed');
  }
  if (proposal.sourceClaimStatus === null) {
    return reject('no source claim; an assumption with no finding under it is a guess');
  }
  if (!FOUNDABLE_STATUSES.has(proposal.sourceClaimStatus)) {
    return reject(`its source claim is ${proposal.sourceClaimStatus}`);
  }

  if (proposal.code === 'terminal_growth') {
    const discount = byCode.get('discount_rate');
    if (discount && proposal.value >= discount.value) {
      return reject(
        `terminal growth ${proposal.value} is not below the discount rate ${discount.value}`,
      );
    }
  }
  return { status: 'approved', reason: 'within band, founded on a standing claim' };
}

// --- thesis synthesis -------------------------------------------------------

export const THESIS_NODE_TYPES = [
  'DRIVER',
  'ASSUMPTION',
  'RISK',
  'CATALYST',
  'CONCLUSION',
  'UNKNOWN',
] as const;

export const THESIS_EDGE_TYPES = [
  'SUPPORTS',
  'CONTRADICTS',
  'DEPENDS_ON',
  'CAUSES',
  'DERIVED_FROM',
  'INVALIDATES',
] as const;

export const ThesisNodeSchema = z.object({
  key: z.string().min(1).describe('short local id for this node, referenced by edges'),
  node_type: z.enum(THESIS_NODE_TYPES),
  statement: z.string().min(1).describe('one sentence'),
  confidence: z.number().min(0).max(1),
  claim_key: z
    .string()
    .nullable()
    .default(null)
    .describe('claim_key of the finding this rests on, copied exactly from the findings list'),
  assumption_code: z
    .string()
    .nullable()
    .default(null)
    .describe('code of the approved assumption this rests on'),
  from_valuation: z
    .boolean()
    .default(false)
    .describe('true when this node reports the calculated valuation'),
});

export const ThesisEdgeSchema = z.object({
  from: z.string().min(1).describe('key of the node the edge leaves'),
  edge_type: z.enum(THESIS_EDGE_TYPES),
  to: z.string().min(1).describe('key of the node the edge enters'),
});

export const ThesisOutputSchema = z.object({
  verdict: z.enum(['bullish', 'neutral', 'bearish', 'insufficient_evidence']),
  summary: z.string().min(1).describe('a few sentences, specific, no hedging'),
  confidence: z.number().min(0).max(1),
  nodes: z.array(ThesisNodeSchema).min(1),
  edges: z.array(ThesisEdgeSchema).default([]),
});

export type ThesisNodeOutput = z.infer<typeof ThesisNodeSchema>;
export type ThesisEdgeOutput = z.infer<typeof ThesisEdgeSchema>;
export type ThesisOutput = z.infer<typeof ThesisOutputSchema>;

export class ThesisError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThesisError';
  }
}

export interface ThesisAnchors {
  claimKeys: ReadonlySet<string>;
  assumptionCodes: ReadonlySet<string>;
  hasValuation: boolean;
}

/** A node that asserts something must point at a row, not at prose. */
const ANCHORED_TYPES = new Set(['DRIVER', 'ASSUMPTION', 'RISK', 'CATALYST']);

/**
 * The gate the phase check names. Every node that asserts something has to name
 * the claim, the approved assumption or the calculation it rests on, and every
 * name has to resolve. A thesis whose nodes point nowhere is prose with a
 * version number on it.
 */
export function validateThesis(output: ThesisOutput, anchors: ThesisAnchors): ThesisOutput {
  const fail = (message: string): never => {
    throw new ThesisError(message);
  };

  const keys = new Set<string>();
  for (const node of output.nodes) {
    if (keys.has(node.key)) fail(`node key ${node.key} appears twice`);
    keys.add(node.key);

    if (node.claim_key && !anchors.claimKeys.has(node.claim_key)) {
      fail(`node ${node.key} cites finding ${node.claim_key}, which this run did not produce`);
    }
    if (node.assumption_code && !anchors.assumptionCodes.has(node.assumption_code)) {
      fail(`node ${node.key} cites assumption ${node.assumption_code}, which policy did not approve`);
    }
    if (node.from_valuation && !anchors.hasValuation) {
      fail(`node ${node.key} reports a valuation, but no calculation run was produced`);
    }
    if (node.node_type === 'ASSUMPTION' && !node.assumption_code) {
      fail(`node ${node.key} is an ASSUMPTION naming no approved assumption`);
    }
    if (
      ANCHORED_TYPES.has(node.node_type) &&
      !node.claim_key &&
      !node.assumption_code &&
      !node.from_valuation
    ) {
      fail(`node ${node.key} is a ${node.node_type} resting on nothing`);
    }
  }

  for (const edge of output.edges) {
    if (!keys.has(edge.from)) fail(`an edge leaves unknown node ${edge.from}`);
    if (!keys.has(edge.to)) fail(`an edge enters unknown node ${edge.to}`);
    if (edge.from === edge.to) fail(`node ${edge.from} has an edge to itself`);
  }

  if (!output.nodes.some((node) => node.node_type === 'CONCLUSION')) {
    fail('a thesis needs a CONCLUSION node: the verdict is part of the graph, not a label on it');
  }
  return output;
}
