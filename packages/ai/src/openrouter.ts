import type { JsonSchema } from './json-schema.ts';

/**
 * The one provider adapter. Everything provider-shaped lives here: the URL,
 * the headers, the tool-call convention used to get structured output, and the
 * usage fields. Swapping providers should mean writing a second file like this
 * one, not touching the gateway.
 *
 * OpenRouter reports what each call actually cost, so cost is a recorded fact
 * rather than a number computed from a price table that has to be kept current.
 */

export const OPENROUTER_PROVIDER = 'openrouter';
export const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Structured output comes from a forced tool call, not from parsing prose. */
const TOOL_DESCRIPTION = 'Record the answer in exactly this structure.';

export interface OpenRouterCall {
  model: string;
  system: string;
  user: string;
  toolName: string;
  schema: JsonSchema;
  maxTokens: number;
  temperature: number;
}

/**
 * The exact bytes sent, and the exact bytes the request hash covers. Key order
 * is fixed by this literal, so the same call always hashes the same way.
 *
 * require_parameters keeps the request away from any upstream endpoint that
 * would silently drop the tool definition and answer in prose instead.
 */
export function buildRequestBody(call: OpenRouterCall): string {
  return JSON.stringify({
    model: call.model,
    max_tokens: call.maxTokens,
    temperature: call.temperature,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    tools: [
      {
        type: 'function',
        function: { name: call.toolName, description: TOOL_DESCRIPTION, parameters: call.schema },
      },
    ],
    tool_choice: { type: 'function', function: { name: call.toolName } },
    provider: { require_parameters: true },
  });
}

export function requestHeaders(apiKey: string, siteUrl = process.env.OPENROUTER_SITE_URL): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
    'x-title': 'Mineral',
  };
  // Optional attribution, and only what the operator chose to publish.
  if (siteUrl) headers['http-referer'] = siteUrl;
  return headers;
}

export interface ProviderResult {
  /** The tool arguments, still unvalidated: the schema parse happens above. */
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  /** What the call actually cost, as reported by the provider. */
  costUsd: number | null;
  finishReason: string | null;
}

interface ToolCall {
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenRouterResponse {
  error?: { code?: number | string; message?: string };
  choices?: { finish_reason?: string | null; message?: { tool_calls?: ToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export function parseResponseBody(body: string, toolName: string): ProviderResult {
  const response = JSON.parse(body) as OpenRouterResponse;
  if (response.error) {
    const { code, message } = response.error;
    throw new Error(`openrouter returned an error: ${code ?? 'unknown'} ${message ?? ''}`.trim());
  }
  const choice = response.choices?.[0];
  const finishReason = choice?.finish_reason ?? null;
  const call = choice?.message?.tool_calls?.find((c) => c.function?.name === toolName);
  if (!call?.function?.arguments) {
    const truncated = finishReason === 'length' ? ', stopped at the token limit so the answer was cut off' : '';
    throw new Error(`the model did not call ${toolName}${truncated}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(call.function.arguments);
  } catch {
    throw new Error(`${toolName} was called with arguments that are not valid JSON`);
  }

  return {
    value,
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
    costUsd: typeof response.usage?.cost === 'number' ? response.usage.cost : null,
    finishReason,
  };
}
