import { describe, expect, it } from 'vitest';
import {
  ThesisOutputSchema,
  applyPolicy,
  validateThesis,
  type PolicyInput,
  type ThesisOutput,
} from './decision.ts';

const proposal = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  code: 'discount_rate',
  value: 0.11,
  minValue: 0.09,
  maxValue: 0.13,
  rationale: 'Weighted average cost of capital from the disclosed debt terms.',
  sourceClaimStatus: 'DERIVED',
  ...over,
});

const verdictFor = (input: PolicyInput) => applyPolicy([input])[0]!;

describe('assumption policy', () => {
  it('approves a banded value founded on a standing claim', () => {
    expect(verdictFor(proposal())).toMatchObject({ code: 'discount_rate', status: 'approved' });
  });

  it('refuses a code no method here consumes', () => {
    expect(verdictFor(proposal({ code: 'animal_spirits' }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('not an input'),
    });
  });

  it('refuses a value outside the band', () => {
    expect(verdictFor(proposal({ value: 0.9, minValue: null, maxValue: null }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('outside the allowed band'),
    });
  });

  it('refuses a value outside the range the proposal itself stated', () => {
    expect(verdictFor(proposal({ value: 0.2, minValue: 0.09, maxValue: 0.13 }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('its own stated range'),
    });
  });

  it('refuses a fractional year count', () => {
    expect(verdictFor(proposal({ code: 'projection_years', value: 5.5, minValue: null, maxValue: null })))
      .toMatchObject({ status: 'rejected', reason: expect.stringContaining('whole number') });
  });

  it('refuses an assumption with no rationale', () => {
    expect(verdictFor(proposal({ rationale: '   ' }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('unexplained'),
    });
  });

  it('refuses an assumption whose source claim verification threw out', () => {
    expect(verdictFor(proposal({ sourceClaimStatus: 'CONTRADICTED' }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('CONTRADICTED'),
    });
  });

  it('refuses an assumption resting on nothing', () => {
    expect(verdictFor(proposal({ sourceClaimStatus: null }))).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('no source claim'),
    });
  });

  it('refuses a terminal growth that is not below the discount rate', () => {
    const decisions = applyPolicy([
      proposal({ code: 'discount_rate', value: 0.04, minValue: null, maxValue: null }),
      proposal({ code: 'terminal_growth', value: 0.05, minValue: null, maxValue: null }),
    ]);
    expect(decisions.map((decision) => decision.status)).toEqual(['approved', 'rejected']);
    expect(decisions[1]!.reason).toContain('not below the discount rate');
  });

  it('judges each proposal on its own where no rule spans the set', () => {
    const decisions = applyPolicy([
      proposal({ code: 'growth_rate', value: 0.08, minValue: null, maxValue: null }),
      proposal({ code: 'projection_years', value: 99, minValue: null, maxValue: null }),
    ]);
    expect(decisions.map((decision) => decision.status)).toEqual(['approved', 'rejected']);
  });
});

const thesis = (over: Partial<ThesisOutput> = {}): ThesisOutput =>
  ThesisOutputSchema.parse({
    verdict: 'bullish',
    summary: 'The only operating mine in its region, priced on a growth rate it has not yet shown.',
    confidence: 0.6,
    nodes: [
      {
        key: 'n1',
        node_type: 'DRIVER',
        statement: 'It is the only operating rare earth mine in North America.',
        confidence: 0.8,
        claim_key: 'competitive_position',
      },
      { key: 'n2', node_type: 'CONCLUSION', statement: 'Worth owning at this price.', confidence: 0.6 },
    ],
    edges: [{ from: 'n1', edge_type: 'SUPPORTS', to: 'n2' }],
    ...over,
  });

const anchors = {
  claimKeys: new Set(['competitive_position']),
  assumptionCodes: new Set(['discount_rate']),
  hasValuation: false,
};

describe('thesis anchoring', () => {
  it('accepts a graph whose every assertion names a finding', () => {
    expect(validateThesis(thesis(), anchors).verdict).toBe('bullish');
  });

  it('rejects a node citing a finding the run never produced', () => {
    const invented = thesis({
      nodes: [
        { ...thesis().nodes[0]!, claim_key: 'invented_finding' },
        thesis().nodes[1]!,
      ],
    });
    expect(() => validateThesis(invented, anchors)).toThrow(/which this run did not produce/);
  });

  it('rejects a node citing an assumption policy did not approve', () => {
    const bad = thesis({
      nodes: [
        { ...thesis().nodes[0]!, node_type: 'ASSUMPTION', claim_key: null, assumption_code: 'animal_spirits' },
        thesis().nodes[1]!,
      ],
    });
    expect(() => validateThesis(bad, anchors)).toThrow(/policy did not approve/);
  });

  it('rejects a valuation node when no calculation ran', () => {
    const bad = thesis({
      nodes: [
        { ...thesis().nodes[0]!, claim_key: null, from_valuation: true },
        thesis().nodes[1]!,
      ],
    });
    expect(() => validateThesis(bad, anchors)).toThrow(/no calculation run was produced/);
    expect(validateThesis(bad, { ...anchors, hasValuation: true }).nodes).toHaveLength(2);
  });

  it('rejects an asserting node that rests on nothing at all', () => {
    const floating = thesis({
      nodes: [{ ...thesis().nodes[0]!, claim_key: null }, thesis().nodes[1]!],
    });
    expect(() => validateThesis(floating, anchors)).toThrow(/resting on nothing/);
  });

  it('rejects an edge to a node that does not exist', () => {
    const dangling = thesis({ edges: [{ from: 'n1', edge_type: 'SUPPORTS', to: 'n9' }] });
    expect(() => validateThesis(dangling, anchors)).toThrow(/enters unknown node n9/);
  });

  it('rejects a thesis with no conclusion in it', () => {
    const headless = thesis({ nodes: [thesis().nodes[0]!], edges: [] });
    expect(() => validateThesis(headless, anchors)).toThrow(/needs a CONCLUSION node/);
  });

  it('rejects two nodes sharing a key, which an edge could not tell apart', () => {
    const clashing = thesis({
      nodes: [thesis().nodes[0]!, { ...thesis().nodes[1]!, key: 'n1' }],
      edges: [],
    });
    expect(() => validateThesis(clashing, anchors)).toThrow(/appears twice/);
  });

  it('allows an UNKNOWN node to rest on nothing, because that is what it says', () => {
    const honest = thesis({
      nodes: [
        { key: 'n1', node_type: 'UNKNOWN', statement: 'Nothing states the offtake terms.', confidence: 0.2,
          claim_key: null, assumption_code: null, from_valuation: false },
        thesis().nodes[1]!,
      ],
      edges: [],
    });
    expect(validateThesis(honest, anchors).nodes).toHaveLength(2);
  });
});
