import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  modelFor,
  parseCall,
  prepareCall,
  sendCall,
  ROUTING,
  TASK_TIERS,
  type Transport,
} from './gateway.ts';

const schema = z.object({ revenue: z.number(), unit: z.string() });

const request = {
  task: 'extraction' as const,
  system: 'You read filings.',
  user: 'What was revenue?',
  schema,
};

const reply = (value: unknown) =>
  JSON.stringify({
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          tool_calls: [
            { type: 'function', function: { name: 'record_result', arguments: JSON.stringify(value) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000105 },
  });

describe('routing', () => {
  it('sends mechanical reading to the cheap tier and judgement to the strong one', () => {
    expect(TASK_TIERS.extraction).toBe('cheap');
    expect(TASK_TIERS.classification).toBe('cheap');
    expect(TASK_TIERS.synthesis).toBe('strong');
    expect(TASK_TIERS.verification).toBe('strong');
    expect(modelFor('extraction')).toBe(ROUTING.cheap);
    expect(modelFor('verification')).toBe(ROUTING.strong);
    // OpenRouter slugs, namespaced by upstream provider.
    expect(ROUTING.cheap).toBe('anthropic/claude-haiku-4.5');
    expect(ROUTING.strong).toBe('anthropic/claude-opus-5');
  });

  it('lets a re-run pin the model the original used', () => {
    expect(prepareCall({ ...request, model: 'some-older-model' }).model).toBe('some-older-model');
  });
});

describe('the request hash', () => {
  it('is stable for the same call', () => {
    expect(prepareCall(request).requestHash).toBe(prepareCall(request).requestHash);
  });

  it('changes when anything that can change the answer changes', () => {
    const base = prepareCall(request).requestHash;
    expect(prepareCall({ ...request, user: 'What was net income?' }).requestHash).not.toBe(base);
    expect(prepareCall({ ...request, system: 'You read transcripts.' }).requestHash).not.toBe(base);
    expect(prepareCall({ ...request, task: 'synthesis' }).requestHash).not.toBe(base);
    expect(prepareCall({ ...request, maxTokens: 99 }).requestHash).not.toBe(base);
    expect(prepareCall({ ...request, schema: z.object({ revenue: z.number() }) }).requestHash).not.toBe(base);
  });

  it('does not send temperature, because the routed models reject it', () => {
    // It was 0 for determinism. The models deprecated the parameter and answer
    // a request carrying it with a 400, so the knob is gone rather than moved.
    expect(prepareCall(request).temperature).toBeNull();
    expect(JSON.parse(prepareCall(request).body)).not.toHaveProperty('temperature');
  });
});

describe('parsing', () => {
  it('returns the validated object and the hash of the exact bytes', () => {
    const call = prepareCall(request);
    const body = reply({ revenue: 253400000, unit: 'USD' });
    const outcome = parseCall(call, body);
    expect(outcome.value).toEqual({ revenue: 253400000, unit: 'USD' });
    expect(outcome.responseHash).toHaveLength(64);
    // Cost is what the provider charged, not what a price table estimated.
    expect(outcome.costUsd).toBe(0.000105);
    expect(parseCall(call, body).responseHash).toBe(outcome.responseHash);
  });

  it('refuses an answer that does not match the schema it asked for', () => {
    expect(() => parseCall(prepareCall(request), reply({ revenue: 'a lot' }))).toThrow();
  });
});

describe('sending', () => {
  it('posts the prepared bytes through the transport', async () => {
    const seen: { url: string; body: string }[] = [];
    const transport: Transport = async (url, init) => {
      seen.push({ url, body: init.body });
      return { status: 200, body: reply({ revenue: 1, unit: 'USD' }) };
    };
    const call = prepareCall(request);
    const sent = await sendCall(call, { transport, apiKey: 'test-key' });
    expect(seen[0]?.body).toBe(call.body);
    expect(sent.body).toContain('tool_calls');
  });

  it('refuses a live call with no api key', async () => {
    const transport: Transport = async () => {
      throw new Error('the transport should never have been reached');
    };
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      await expect(sendCall(prepareCall(request), { transport })).rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('reports a provider failure rather than parsing the error page', async () => {
    const transport: Transport = async () => ({ status: 529, body: 'overloaded' });
    await expect(sendCall(prepareCall(request), { transport, apiKey: 'k' })).rejects.toThrow(/529/);
  });
});
