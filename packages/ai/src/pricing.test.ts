import { describe, expect, it } from 'vitest';
import { costUsd, parsePricing, pricingFromEnv } from './pricing.ts';

const pricing = parsePricing('{"m":{"input_per_million":3,"output_per_million":15}}');

describe('cost tracking', () => {
  it('prices a call from its tokens', () => {
    expect(costUsd('m', { inputTokens: 1_000_000, outputTokens: 0 }, pricing)).toBe(3);
    expect(costUsd('m', { inputTokens: 2000, outputTokens: 1000 }, pricing)).toBeCloseTo(0.021, 10);
  });

  it('reports no cost rather than an estimate for an unpriced model', () => {
    expect(costUsd('unknown', { inputTokens: 1000, outputTokens: 1000 }, pricing)).toBeNull();
  });

  it('claims no prices when none are configured', () => {
    expect(pricingFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });

  it('reads the table from the environment', () => {
    const env = { MODEL_PRICING: '{"m":{"input_per_million":1,"output_per_million":2}}' } as NodeJS.ProcessEnv;
    expect(costUsd('m', { inputTokens: 1_000_000, outputTokens: 1_000_000 }, pricingFromEnv(env))).toBe(3);
  });

  it('rejects a malformed table rather than pricing at zero', () => {
    expect(() => parsePricing('{"m":{"input_per_million":1}}')).toThrow(/output_per_million/);
    expect(() => parsePricing('{"m":{"input_per_million":-1,"output_per_million":1}}')).toThrow(/negative/);
    expect(() => parsePricing('[]')).toThrow(/keyed by model id/);
  });
});
