import { describe, expect, it } from 'vitest';
import { buildRequestBody, parseResponseBody, requestHeaders } from './anthropic.ts';

const call = {
  model: 'claude-haiku-4-5-20251001',
  system: 'You read filings.',
  user: 'What was revenue?',
  toolName: 'record_result',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  maxTokens: 1024,
  temperature: 0,
};

const toolResponse = JSON.stringify({
  stop_reason: 'tool_use',
  content: [{ type: 'tool_use', name: 'record_result', input: { revenue: 253400000 } }],
  usage: { input_tokens: 120, output_tokens: 34 },
});

describe('the anthropic adapter', () => {
  it('forces the tool call rather than hoping for structured prose', () => {
    const body = JSON.parse(buildRequestBody(call));
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_result' });
    expect(body.tools[0].input_schema).toEqual(call.schema);
    expect(body.temperature).toBe(0);
  });

  it('serialises the same call to the same bytes every time', () => {
    expect(buildRequestBody(call)).toBe(buildRequestBody({ ...call }));
  });

  it('sends the api key in the header and nowhere else', () => {
    const headers = requestHeaders('secret-key');
    expect(headers['x-api-key']).toBe('secret-key');
    expect(buildRequestBody(call)).not.toContain('secret-key');
  });

  it('reads the tool input and the token usage', () => {
    const result = parseResponseBody(toolResponse, 'record_result');
    expect(result.value).toEqual({ revenue: 253400000 });
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(34);
  });

  it('refuses a reply that answered in prose instead of calling the tool', () => {
    const body = JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'about 253 million' }] });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/did not call record_result/);
  });

  it('says so when the answer was truncated', () => {
    const body = JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'part' }] });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/max_tokens/);
  });

  it('surfaces a provider error instead of parsing past it', () => {
    const body = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'try later' } });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/overloaded_error/);
  });
});
