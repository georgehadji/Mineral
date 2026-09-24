import { describe, expect, it } from 'vitest';
import { ModuleOutputSchema, citationFault, validateOutput } from './runtime.ts';
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

describe('citation handles', () => {
  const chunkId = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;

  const context = {
    subject: {
      companyId: 'aaaaaaaa-0000-4000-8000-000000000001',
      legalName: 'Test Co',
      commonName: null,
      cik: null,
    },
    asOfDate: '2026-06-30',
    chunks: [1, 2, 3].map((n) => ({
      chunkId: chunkId(n),
      documentVersionId: 'bbbbbbbb-0000-4000-8000-000000000001',
      documentTitle: 'Annual report',
      publishedAt: null,
      sourceTier: 1,
      text: `Sentence number ${n} of the filing, long enough to quote.`,
    })),
    facts: [],
    upstream: {},
  };

  const cited = async (chunk: string, quote: string) => {
    const answering = async () =>
      ModuleOutputSchema.parse({
        claims: [
          {
            claim_key: 'k',
            claim_type: 'business_fact',
            statement: 'A statement.',
            status: 'DERIVED',
            confidence: 0.9,
            evidence: [{ chunk_id: chunk, quote }],
          },
        ],
      });
    const output = await IMPLEMENTATIONS_BY_CODE.get('company_profile')!.run(context, answering);
    return output.claims[0]!.evidence[0]!.chunk_id;
  };

  const inChunk = (n: number) => `Sentence number ${n} of the filing`;

  it('turns the handle the prompt showed into the real chunk id', async () => {
    expect(await cited('2', inChunk(2))).toBe(chunkId(2));
  });

  it('leaves a real id alone, so an older stored answer still resolves', async () => {
    expect(await cited(chunkId(3), inChunk(3))).toBe(chunkId(3));
  });

  it('points a citation at the chunk its quote is really in', async () => {
    // Quote is sentence 2; the module said chunk 1, one off. Also covers a
    // handle that resolves to the wrong chunk rather than to nothing.
    expect(await cited('1', inChunk(2))).toBe(chunkId(2));
  });

  it('leaves a quote that is in no chunk alone, so it still fails', async () => {
    const unusable = 'A sentence that is in no chunk at all.';
    expect(await cited('1', unusable)).toBe(chunkId(1));
    // An out-of-range handle is not rewritten into something plausible either.
    expect(await cited('99', unusable)).toBe('99');
  });

  it('leaves an ambiguous quote where the module put it', async () => {
    // This tail is in all three chunks, so there is nothing to choose between.
    expect(await cited('1', 'of the filing, long enough to quote.')).toBe(chunkId(1));
  });
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

  // A claim's own citations are a fault of that claim, found by citationFault
  // and dropped by the caller; they no longer throw for the whole module.
  const fault = (over: Record<string, unknown>) => citationFault(claim(over).claims[0]!);

  it('faults an asserted claim with no evidence, without failing the module', () => {
    expect(fault({ evidence: [] })).toMatch(/with no evidence/);
    expect(() => validateOutput('m', claim({ evidence: [] }))).not.toThrow();
  });

  it('allows UNKNOWN with no evidence, which is the honest non-answer', () => {
    expect(fault({ status: 'UNKNOWN', evidence: [] })).toBeNull();
  });

  it('faults a chunk citation with no usable quote', () => {
    expect(fault({ evidence: [{ chunk_id: 'c1', quote: 'too short' }] })).toMatch(/no usable quote/);
  });

  it('faults a citation that names both a chunk and a fact', () => {
    expect(
      fault({ evidence: [{ chunk_id: 'c1', fact_version_id: 'f1', quote: 'produced 45,455 metric tons' }] }),
    ).toMatch(/exactly one of/);
  });

  it('accepts a fact citation with no quote, since a fact is already verified', () => {
    expect(fault({ evidence: [{ fact_version_id: 'f1' }] })).toBeNull();
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
