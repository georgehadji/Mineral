/**
 * Cost tracking. The table is configuration, not knowledge: prices change and
 * a guessed one would turn into a wrong number in a cost report, so an unpriced
 * model reports null rather than an estimate. Tokens are always recorded, so a
 * cost can be computed later once the real prices are supplied.
 *
 *   MODEL_PRICING='{"claude-haiku-4-5-20251001":{"input_per_million":0.8,"output_per_million":4}}'
 */

export interface ModelPrice {
  input_per_million: number;
  output_per_million: number;
}

export type Pricing = Readonly<Record<string, ModelPrice>>;

export function parsePricing(json: string): Pricing {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('MODEL_PRICING must be an object keyed by model id');
  }
  const pricing: Record<string, ModelPrice> = {};
  for (const [model, price] of Object.entries(parsed as Record<string, unknown>)) {
    const entry = price as Partial<ModelPrice>;
    if (typeof entry?.input_per_million !== 'number' || typeof entry?.output_per_million !== 'number') {
      throw new Error(`price for ${model} needs input_per_million and output_per_million`);
    }
    if (entry.input_per_million < 0 || entry.output_per_million < 0) {
      throw new Error(`price for ${model} cannot be negative`);
    }
    pricing[model] = { input_per_million: entry.input_per_million, output_per_million: entry.output_per_million };
  }
  return pricing;
}

/** Empty when unset: no prices configured means no costs claimed. */
export function pricingFromEnv(env: NodeJS.ProcessEnv = process.env): Pricing {
  const json = env.MODEL_PRICING;
  return json ? parsePricing(json) : {};
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Cost in USD, or null when the model has no configured price. */
export function costUsd(model: string, usage: TokenUsage, pricing: Pricing): number | null {
  const price = pricing[model];
  if (!price) return null;
  const million = 1_000_000;
  return (
    (usage.inputTokens * price.input_per_million) / million +
    (usage.outputTokens * price.output_per_million) / million
  );
}
