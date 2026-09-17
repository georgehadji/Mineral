import { describe, expect, it } from 'vitest';
import { buildRequestBody, parseResponseBody, requestHeaders } from './openrouter.ts';

const call = {
  model: 'anthropic/claude-haiku-4.5',
  system: 'You read filings.',
  user: 'What was revenue?',
  toolName: 'record_result',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  maxTokens: 1024,
  temperature: 0,
};

const toolReply = JSON.stringify({
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        tool_calls: [
          { type: 'function', function: { name: 'record_result', arguments: '{"revenue":253400000}' } },
        ],
      },
    },
  ],
  usage: { prompt_tokens: 120, completion_tokens: 34, cost: 0.00029 },
});

describe('the openrouter adapter', () => {
  it('forces the tool call rather than hoping for structured prose', () => {
    const body = JSON.parse(buildRequestBody(call));
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'record_result' } });
    expect(body.tools[0].function.parameters).toEqual(call.schema);
    expect(body.temperature).toBe(0);
    expect(JSON.parse(buildRequestBody({ ...call, temperature: null }))).not.toHaveProperty(
      'temperature',
    );
  });

  it('refuses an upstream endpoint that would drop the tool definition', () => {
    expect(JSON.parse(buildRequestBody(call)).provider).toEqual({ require_parameters: true });
  });

  it('serialises the same call to the same bytes every time', () => {
    expect(buildRequestBody(call)).toBe(buildRequestBody({ ...call }));
  });

  it('sends the api key as a bearer token and nowhere else', () => {
    const headers = requestHeaders('secret-key', undefined);
    expect(headers.authorization).toBe('Bearer secret-key');
    expect(buildRequestBody(call)).not.toContain('secret-key');
  });

  it('attributes the call only when a site url was configured', () => {
    expect(requestHeaders('k', undefined)['http-referer']).toBeUndefined();
    expect(requestHeaders('k', 'https://example.invalid')['http-referer']).toBe('https://example.invalid');
  });

  it('reads the tool arguments, the token usage and the charged cost', () => {
    const result = parseResponseBody(toolReply, 'record_result');
    expect(result.value).toEqual({ revenue: 253400000 });
    expect(result.inputTokens).toBe(120);
    expect(result.outputTokens).toBe(34);
    expect(result.costUsd).toBe(0.00029);
  });

  it('reports no cost when the provider reported none', () => {
    const body = JSON.stringify({
      choices: [
        { message: { tool_calls: [{ function: { name: 'record_result', arguments: '{}' } }] } },
      ],
    });
    expect(parseResponseBody(body, 'record_result').costUsd).toBeNull();
  });

  it('refuses a reply that answered in prose instead of calling the tool', () => {
    const body = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'about 253 million' } }] });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/did not call record_result/);
  });

  it('says so when the answer was truncated', () => {
    const body = JSON.stringify({ choices: [{ finish_reason: 'length', message: {} }] });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/token limit/);
  });

  it('refuses tool arguments that are not valid JSON', () => {
    const body = JSON.stringify({
      choices: [{ message: { tool_calls: [{ function: { name: 'record_result', arguments: '{oops' } }] } }],
    });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/not valid JSON/);
  });

  it('surfaces a provider error instead of parsing past it', () => {
    const body = JSON.stringify({ error: { code: 429, message: 'rate limited' } });
    expect(() => parseResponseBody(body, 'record_result')).toThrow(/429/);
  });
});
