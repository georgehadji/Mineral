/**
 * Integration test. Needs a PostgreSQL database with the migrations applied,
 * addressed by DATABASE_URL. Skipped without one, so the default `pnpm test`
 * stays hermetic.
 *
 * This is the phase gate: a replay from cache has to reproduce the output.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Transport } from '@mineral/ai';
import { createPool, type Pool } from './client.ts';
import { callModel } from './model-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the model gateway', () => {
  let pool: Pool;
  const run = randomUUID().slice(0, 8);
  /** Pinned so cleanup is exact and no real model id is touched. */
  const model = `test-model-${run}`;
  const schema = z.object({ revenue: z.number(), unit: z.string() });

  let calls = 0;
  const transport: Transport = async () => {
    calls += 1;
    return {
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              tool_calls: [
                {
                  type: 'function',
                  function: {
                    name: 'record_result',
                    arguments: JSON.stringify({ revenue: 253_400_000, unit: 'USD' }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.000105 },
      }),
    };
  };

  const ask = (overrides: Record<string, unknown> = {}) =>
    callModel(pool, {
      task: 'extraction' as const,
      model,
      system: `You read filings. Run ${run}.`,
      user: 'What was revenue in the last fiscal year?',
      schema,
      transport,
      apiKey: 'test-key',
      ...overrides,
    });

  beforeAll(() => {
    pool = createPool(url);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query(`delete from research.model_runs where model = $1`, [model]);
    await pool.query(`delete from research.model_cache where model = $1`, [model]);
    await pool.end();
  });

  it('calls the provider once, stores the response and logs the cost', async () => {
    const before = calls;
    const result = await ask();
    expect(calls).toBe(before + 1);
    expect(result.cached).toBe(false);
    expect(result.value).toEqual({ revenue: 253_400_000, unit: 'USD' });
    // What the provider said it charged, not a number computed here.
    expect(result.costUsd).toBe(0.000105);

    const { rows } = await pool.query(
      `select status, provider, temperature::text, input_tokens, output_tokens,
              cost_usd::text as cost, request_hash, response_hash, error
         from research.model_runs where id = $1`,
      [result.modelRunId],
    );
    expect(rows[0]).toMatchObject({
      status: 'completed',
      provider: 'openrouter',
      temperature: '0.000',
      input_tokens: 10,
      output_tokens: 5,
      cost: '0.00010500',
      request_hash: result.requestHash,
      response_hash: result.responseHash,
      error: null,
    });

    const cache = await pool.query<{ response_body: string; response_hash: string }>(
      `select response_body, response_hash from research.model_cache where request_hash = $1`,
      [result.requestHash],
    );
    expect(cache.rows).toHaveLength(1);
    expect(cache.rows[0]?.response_hash).toBe(result.responseHash);
  });

  it('replays the same request from cache without touching the provider', async () => {
    const first = await ask();
    const before = calls;
    const replay = await ask();

    expect(calls).toBe(before);
    expect(replay.cached).toBe(true);
    expect(replay.value).toEqual(first.value);
    expect(replay.responseHash).toBe(first.responseHash);
    expect(replay.requestHash).toBe(first.requestHash);
    // The call itself cost nothing; its tokens stay recorded so the saving is
    // computable from the log rather than guessed.
    expect(replay.costUsd).toBe(0);
    expect(replay.inputTokens).toBe(first.inputTokens);

    const { rows } = await pool.query<{ status: string; cost: string | null }>(
      `select status, cost_usd::text as cost from research.model_runs where id = $1`,
      [replay.modelRunId],
    );
    expect(rows[0]).toMatchObject({ status: 'cached', cost: '0.00000000' });
  });

  it('replays on a machine with no credentials at all', async () => {
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    const refuse: Transport = async () => {
      throw new Error('the provider must not be reached on a replay');
    };
    try {
      const replay = await callModel(pool, {
        task: 'extraction',
        model,
        system: `You read filings. Run ${run}.`,
        user: 'What was revenue in the last fiscal year?',
        schema,
        transport: refuse,
        cacheOnly: true,
      });
      expect(replay.cached).toBe(true);
      expect(replay.value).toEqual({ revenue: 253_400_000, unit: 'USD' });
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });

  it('treats a changed request as a different question', async () => {
    const before = calls;
    const other = await ask({ user: 'What was net income in the last fiscal year?' });
    expect(calls).toBe(before + 1);
    expect(other.cached).toBe(false);
    expect(other.requestHash).not.toBe((await ask()).requestHash);
  });

  it('records no cost when the provider reported none', async () => {
    const silent: Transport = async () => ({
      status: 200,
      body: JSON.stringify({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  function: {
                    name: 'record_result',
                    arguments: JSON.stringify({ revenue: 1, unit: 'USD' }),
                  },
                },
              ],
            },
          },
        ],
      }),
    });
    const result = await ask({ user: `Uncosted question ${run}.`, transport: silent });
    expect(result.costUsd).toBeNull();
    const { rows } = await pool.query<{ cost: string | null }>(
      `select cost_usd::text as cost from research.model_runs where id = $1`,
      [result.modelRunId],
    );
    expect(rows[0]?.cost).toBeNull();
  });

  it('logs a failed call instead of losing it', async () => {
    const failing: Transport = async () => ({ status: 529, body: 'overloaded' });
    await expect(ask({ user: `Doomed question ${run}.`, transport: failing })).rejects.toThrow(/529/);

    const { rows } = await pool.query<{ status: string; error: { message: string } }>(
      `select status, error from research.model_runs
        where model = $1 and status = 'failed' order by created_at desc limit 1`,
      [model],
    );
    expect(rows[0]?.status).toBe('failed');
    expect(rows[0]?.error.message).toMatch(/529/);
  });

  it('refuses to make a live call when only a cached answer is acceptable', async () => {
    await expect(ask({ user: `Never asked before ${run}.`, cacheOnly: true })).rejects.toThrow(/no cached response/);
  });
});
