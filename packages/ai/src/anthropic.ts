import type { JsonSchema } from './json-schema.ts';

/**
 * The one provider adapter. Everything provider-shaped lives here: the URL,
 * the headers, the tool-call convention used to get structured output, and the
 * usage fields. Swapping providers should mean writing a second file like this
 * one, not touching the gateway.
 */

export const ANTHROPIC_PROVIDER = 'anthropic';
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

/** Structured output comes from a forced tool call, not from parsing prose. */
const TOOL_DESCRIPTION = 'Record the answer in exactly this structure.';

export interface AnthropicCall {
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
 */
export function buildRequestBody(call: AnthropicCall): string {
  return JSON.stringify({
    model: call.model,
    max_tokens: call.maxTokens,
    temperature: call.temperature,
    system: call.system,
    messages: [{ role: 'user', content: call.user }],
    tools: [{ name: call.toolName, description: TOOL_DESCRIPTION, input_schema: call.schema }],
    tool_choice: { type: 'tool', name: call.toolName },
  });
}

export function requestHeaders(apiKey: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'x-api-key': apiKey,
  };
}

export interface ProviderResult {
  /** The tool input, still unvalidated: the schema parse happens above. */
  value: unknown;
  inputTokens: number;
  outputTokens: number;
  stopReason: string | null;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  type?: string;
  error?: { type?: string; message?: string };
  stop_reason?: string | null;
  content?: ContentBlock[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function parseResponseBody(body: string, toolName: string): ProviderResult {
  const response = JSON.parse(body) as AnthropicResponse;
  if (response.type === 'error' || response.error) {
    const error = response.error;
    throw new Error(`anthropic returned an error: ${error?.type ?? 'unknown'} ${error?.message ?? ''}`.trim());
  }
  const stopReason = response.stop_reason ?? null;
  const block = response.content?.find((b) => b.type === 'tool_use' && b.name === toolName);
  if (!block || block.input === undefined) {
    const truncated = stopReason === 'max_tokens' ? ', stopped at max_tokens so the answer was cut off' : '';
    throw new Error(`the model did not call ${toolName}${truncated}`);
  }
  return {
    value: block.input,
    inputTokens: response.usage?.input_tokens ?? 0,
    outputTokens: response.usage?.output_tokens ?? 0,
    stopReason,
  };
}
