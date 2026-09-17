import { describe, expect, it } from 'vitest';
import { ModuleOutputSchema, validateOutput } from './runtime.ts';
import { CORE_RECIPE, DEEP_RECIPE, IMPLEMENTATIONS_BY_CODE } from './implementations.ts';
import { buildDag } from './dag.ts';

const claim = (over: Record<string, unknown> = {}) =>
  ModuleOutputSchema.parse({
    claims: [
      {
        claim_key: 'production_volume',
        claim_type: 'business_fact',
        statement: 'The company produced 45,455 tons.',
        status: 'DERIVED',
        confidence: 0.9,
        evidence: [{ chunk_id: 'c1', quote: 'produced 45,455 metric tons' }],
        ...over,
      },
    ],
  });

describe('module output validation', () => {
  it('accepts a cited claim', () => {
    expect(() => validateOutput('m', claim())).not.toThrow();
  });

  it('fills the evidence defaults the prompt does not force', () => {
    const output = claim();
    expect(output.claims[0]!.evidence[0]).toMatchObject({
      role: 'supports',
      strength: 0.8,
      fact_version_id: null,
    });
  });

  it('rejects an asserted claim with no evidence', () => {
    expect(() => validateOutput('m', claim({ evidence: [] }))).toThrow(/with no evidence/);
  });

  it('allows UNKNOWN with no evidence, which is the honest non-answer', () => {
    expect(() => validateOutput('m', claim({ status: 'UNKNOWN', evidence: [] }))).not.toThrow();
  });

  it('rejects a chunk citation with no usable quote', () => {
    expect(() => validateOutput('m', claim({ evidence: [{ chunk_id: 'c1', quote: 'too short' }] }))).toThrow(
      /no usable quote/,
    );
  });

  it('rejects a citation that names both a chunk and a fact', () => {
    expect(() =>
      validateOutput(
        'm',
        claim({ evidence: [{ chunk_id: 'c1', fact_version_id: 'f1', quote: 'produced 45,455 metric tons' }] }),
      ),
    ).toThrow(/exactly one of/);
  });

  it('accepts a fact citation with no quote, since a fact is already verified', () => {
    expect(() => validateOutput('m', claim({ evidence: [{ fact_version_id: 'f1' }] }))).not.toThrow();
  });

  it('rejects the same claim_key twice in one output', () => {
    const output = ModuleOutputSchema.parse({ claims: [...claim().claims, ...claim().claims] });
    expect(() => validateOutput('m', output)).toThrow(/appears twice/);
  });

  it('refuses VERIFIED, which only the validator may assign', () => {
    expect(() => ModuleOutputSchema.parse({ claims: [{ ...claim().claims[0], status: 'VERIFIED' }] })).toThrow();
  });
});

describe('the core recipe', () => {
  it('has an implementation for every module it lists', () => {
    for (const ref of CORE_RECIPE.modules) {
      expect(IMPLEMENTATIONS_BY_CODE.has(ref.code)).toBe(true);
    }
  });

  it('builds a DAG whose dependencies are all satisfied', () => {
    const dag = buildDag(CORE_RECIPE);
    expect(dag.levels[0]).toEqual(['entity_resolution']);
    expect(dag.order).toHaveLength(CORE_RECIPE.modules.length);
  });
});

describe('the deep recipe', () => {
  it('has an implementation for every module it lists', () => {
    for (const ref of DEEP_RECIPE.modules) {
      expect(IMPLEMENTATIONS_BY_CODE.has(ref.code)).toBe(true);
    }
  });

  it('carries every module the spec recipe names that asks a model a question', () => {
    const codes = new Set(DEEP_RECIPE.modules.map((ref) => ref.code));
    for (const code of [
      'industry_position',
      'supply_chain_position',
      'project_pipeline',
      'management',
      'competitive_landscape',
      'risks',
      'catalysts',
    ]) {
      expect(codes.has(code), `${code} is missing from the deep recipe`).toBe(true);
    }
  });

  it('builds a DAG that starts at resolution and ends after the landscape it depends on', () => {
    const dag = buildDag(DEEP_RECIPE);
    expect(dag.levels[0]).toEqual(['entity_resolution']);
    expect(dag.order).toHaveLength(DEEP_RECIPE.modules.length);
    expect(dag.order.indexOf('risks')).toBeGreaterThan(dag.order.indexOf('competitive_landscape'));
    expect(dag.order.indexOf('catalysts')).toBeGreaterThan(dag.order.indexOf('project_pipeline'));
  });

  it('argues the bear case last, after the inputs it attacks exist', () => {
    const dag = buildDag(DEEP_RECIPE);
    expect(dag.order.at(-1)).toBe('bear_case');
    expect(dag.order.indexOf('bear_case')).toBeGreaterThan(
      dag.order.indexOf('valuation_assumptions'),
    );
  });

  it('leaves the core recipe cheap', () => {
    expect(CORE_RECIPE.modules.length).toBeLessThan(DEEP_RECIPE.modules.length);
    expect(CORE_RECIPE.modules.map((ref) => ref.code)).not.toContain('risks');
  });
});
