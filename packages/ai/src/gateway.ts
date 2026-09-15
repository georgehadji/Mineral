import { createHash } from 'node:crypto';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  OPENROUTER_ENDPOINT,
  OPENROUTER_PROVIDER,
  buildRequestBody,
  parseResponseBody,
  requestHeaders,
} from './openrouter.ts';
import { zodToJsonSchema } from './json-schema.ts';

/**
 * The gateway. It prepares a call, sends it, and parses what comes back; it
 * never decides whether to send. That split is what makes the cache possible:
 * a hit and a miss go through the same parse, so a replayed answer is the same
 * answer, not a similar one.
 */

export type ModelTier = 'cheap' | 'strong';

/** OpenRouter slugs, checked against its published model list. */
export const ROUTING: Record<ModelTier, string> = {
  cheap: 'anthropic/claude-haiku-4.5',
  strong: 'anthropic/claude-opus-5',
};

export type ModelTask = 'extraction' | 'classification' | 'synthesis' | 'verification';

/**
 * Reading a number out of a filing is mechanical and goes to the cheap tier.
 * Synthesis and verification go to the strong one: they are where a wrong
 * answer is both most expensive and hardest to notice.
 */
export const TASK_TIERS: Record<ModelTask, ModelTier> = {
  extraction: 'cheap',
  classification: 'cheap',
  synthesis: 'strong',
  verification: 'strong',
};

export function modelFor(task: ModelTask): string {
  const tier = TASK_TIERS[task];
  if (!tier) throw new Error(`no tier configured for task ${task}`);
  return ROUTING[tier];
}

/** A thesis that changes because a sampler rolled differently is not a thesis. */
export const TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_TOOL_NAME = 'record_result';

export interface ModelRequest<T> {
  task: ModelTask;
  system: string;
  user: string;
  /**
   * Only the parsed type matters here. A schema with defaults has an input
   * type that differs from its output; the gateway cares about what comes
   * back, so the input side stays open.
   */
  schema: ZodType<T, ZodTypeDef, unknown>;
  toolName?: string;
  maxTokens?: number;
  /** Pins the model instead of routing, so a re-run can use the original. */
  model?: string;
}

export interface PreparedRequest {
  provider: string;
  model: string;
  toolName: string;
  temperature: number;
  /** Exact bytes to send. */
  body: string;
  /** Cache key. Covers everything that can change the answer. */
  requestHash: string;
}

export interface PreparedCall<T> extends PreparedRequest {
  schema: ZodType<T, ZodTypeDef, unknown>;
}

export function prepareCall<T>(request: ModelRequest<T>): PreparedCall<T> {
  const model = request.model ?? modelFor(request.task);
  const toolName = request.toolName ?? DEFAULT_TOOL_NAME;
  const body = buildRequestBody({
    model,
    system: request.system,
    user: request.user,
    toolName,
    schema: zodToJsonSchema(request.schema),
    maxTokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
    temperature: TEMPERATURE,
  });
  return {
    provider: OPENROUTER_PROVIDER,
    model,
    toolName,
    temperature: TEMPERATURE,
    body,
    requestHash: sha256(`${OPENROUTER_PROVIDER}\n${body}`),
    schema: request.schema,
  };
}

export interface TransportResponse {
  status: number;
  body: string;
}

export type Transport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<TransportResponse>;

const fetchTransport: Transport = async (url, init) => {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.text() };
};

export interface SendOptions {
  transport?: Transport;
  apiKey?: string;
}

export async function sendCall(
  call: PreparedRequest,
  options: SendOptions = {},
): Promise<{ body: string; latencyMs: number }> {
  const apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set; a live call needs one, a cached call does not');
  }
  const transport = options.transport ?? fetchTransport;
  const started = Date.now();
  const response = await transport(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: requestHeaders(apiKey),
    body: call.body,
  });
  const latencyMs = Date.now() - started;
  if (response.status !== 200) {
    throw new Error(`openrouter returned ${response.status}: ${response.body.slice(0, 300)}`);
  }
  return { body: response.body, latencyMs };
}

export interface ModelOutcome<T> {
  value: T;
  responseHash: string;
  inputTokens: number;
  outputTokens: number;
  /** What the provider says the call cost. Null when it did not say. */
  costUsd: number | null;
  finishReason: string | null;
}

/** Zod parse of every gateway response, cached or live, without exception. */
export function parseCall<T>(call: PreparedCall<T>, responseBody: string): ModelOutcome<T> {
  const result = parseResponseBody(responseBody, call.toolName);
  return {
    value: call.schema.parse(result.value),
    responseHash: sha256(responseBody),
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    costUsd: result.costUsd,
    finishReason: result.finishReason,
  };
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
