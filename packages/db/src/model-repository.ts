import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import {
  parseCall,
  prepareCall,
  sendCall,
  type ModelRequest,
  type PreparedCall,
  type Transport,
} from '@mineral/ai';
import { inTransaction } from './client.ts';

/**
 * The only place a model call meets SQL. Every call is logged to
 * research.model_runs whether it hit the provider, hit the cache or failed,
 * and every live response is stored in research.model_cache under its request
 * hash.
 *
 * Replay is the point. The cache holds the exact bytes the provider returned,
 * and a hit is parsed through the same schema the live path uses, so a second
 * call with the same request produces the same object without a network round
 * trip -- and without an API key, which is what makes a recorded run
 * reproducible on a machine that has no credentials at all.
 */

export interface CallModelInput<T> extends ModelRequest<T> {
  researchRunId?: UUID | null;
  moduleRunId?: UUID | null;
  promptVersionId?: UUID | null;
  transport?: Transport;
  apiKey?: string;
  /** Refuse a live call. A replay that misses is a failure, not a fresh call. */
  cacheOnly?: boolean;
}

export interface CallModelResult<T> {
  modelRunId: UUID;
  value: T;
  /** True when the provider was never contacted. */
  cached: boolean;
  requestHash: string;
  responseHash: string;
  inputTokens: number;
  outputTokens: number;
  /** What the provider charged. Zero for a cache hit, null if unreported. */
  costUsd: number | null;
  latencyMs: number | null;
}

interface CacheRow {
  response_body: string;
}

export async function callModel<T>(pool: Pool, input: CallModelInput<T>): Promise<CallModelResult<T>> {
  // Outside the try: a schema that cannot be expressed is a programming error,
  // not a failed call, and logging it as one would be misleading.
  const call = prepareCall(input);

  try {
    const cached = await readCache(pool, call.requestHash);
    let responseBody: string;
    let latencyMs: number | null = null;

    if (cached) {
      responseBody = cached.response_body;
    } else {
      if (input.cacheOnly) {
        throw new Error(`no cached response for request ${call.requestHash}`);
      }
      const sent = await sendCall(call, { transport: input.transport, apiKey: input.apiKey });
      responseBody = sent.body;
      latencyMs = sent.latencyMs;
    }

    const outcome = parseCall(call, responseBody);
    // The provider reports what it charged, so cost is recorded rather than
    // estimated from a price table that would have to be kept current.
    // A cache hit cost nothing; its tokens stay recorded, so the saving is
    // computable from the log rather than guessed.
    const recordedCost = cached ? 0 : outcome.costUsd;

    const modelRunId = await inTransaction(pool, async (client) => {
      if (!cached) await writeCache(client, call, responseBody, outcome, outcome.costUsd);
      return logModelRun(client, {
        input,
        call,
        status: cached ? 'cached' : 'completed',
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        responseHash: outcome.responseHash,
        costUsd: recordedCost,
        latencyMs,
        error: null,
      });
    });

    return {
      modelRunId,
      value: outcome.value,
      cached: Boolean(cached),
      requestHash: call.requestHash,
      responseHash: outcome.responseHash,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      costUsd: recordedCost,
      latencyMs,
    };
  } catch (error) {
    await logModelRun(pool, {
      input,
      call,
      status: 'failed',
      inputTokens: null,
      outputTokens: null,
      responseHash: null,
      costUsd: null,
      latencyMs: null,
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    throw error;
  }
}

async function readCache(pool: Pool, requestHash: string): Promise<CacheRow | null> {
  const { rows } = await pool.query<CacheRow>(
    `select response_body from research.model_cache where request_hash = $1`,
    [requestHash],
  );
  return rows[0] ?? null;
}

async function writeCache<T>(
  client: PoolClient,
  call: PreparedCall<T>,
  responseBody: string,
  outcome: { responseHash: string; inputTokens: number; outputTokens: number },
  cost: number | null,
): Promise<void> {
  await client.query(
    `insert into research.model_cache
       (request_hash, provider, model, request_body, response_body, response_hash,
        input_tokens, output_tokens, cost_usd)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (request_hash) do nothing`,
    [
      call.requestHash,
      call.provider,
      call.model,
      call.body,
      responseBody,
      outcome.responseHash,
      outcome.inputTokens,
      outcome.outputTokens,
      cost,
    ],
  );
}

interface LogInput<T> {
  input: CallModelInput<T>;
  call: PreparedCall<T>;
  status: 'completed' | 'cached' | 'failed';
  inputTokens: number | null;
  outputTokens: number | null;
  responseHash: string | null;
  costUsd: number | null;
  latencyMs: number | null;
  error: { message: string } | null;
}

/** The audit row. Bodies live in the cache, so only the hashes go here. */
async function logModelRun<T>(client: PoolClient | Pool, log: LogInput<T>): Promise<UUID> {
  const { rows } = await client.query<{ id: string }>(
    `insert into research.model_runs
       (research_run_id, module_run_id, provider, model, prompt_version_id, temperature,
        input_tokens, output_tokens, latency_ms, cost_usd, request_hash, response_hash, status, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
     returning id`,
    [
      log.input.researchRunId ?? null,
      log.input.moduleRunId ?? null,
      log.call.provider,
      log.call.model,
      log.input.promptVersionId ?? null,
      log.call.temperature,
      log.inputTokens,
      log.outputTokens,
      log.latencyMs,
      log.costUsd,
      log.call.requestHash,
      log.responseHash,
      log.status,
      log.error ? JSON.stringify(log.error) : null,
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('could not log the model run');
  return id;
}
