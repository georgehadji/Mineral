import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './json-schema.ts';

describe('zodToJsonSchema', () => {
  it('marks optional fields absent from required and forbids invented ones', () => {
    const schema = z.object({ code: z.string(), note: z.string().optional() });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { code: { type: 'string' }, note: { type: 'string' } },
      required: ['code'],
      additionalProperties: false,
    });
  });

  it('keeps descriptions, which are the only instructions a field carries', () => {
    const schema = z.object({ value: z.number().describe('reported in USD') });
    const json = zodToJsonSchema(schema) as { properties: Record<string, unknown> };
    expect(json.properties.value).toEqual({ type: 'number', description: 'reported in USD' });
  });

  it('distinguishes an integer from a number', () => {
    expect(zodToJsonSchema(z.number().int())).toEqual({ type: 'integer' });
    expect(zodToJsonSchema(z.number())).toEqual({ type: 'number' });
  });

  it('converts enums, literals and booleans', () => {
    expect(zodToJsonSchema(z.enum(['supports', 'contradicts']))).toEqual({
      type: 'string',
      enum: ['supports', 'contradicts'],
    });
    expect(zodToJsonSchema(z.literal('VERIFIED'))).toEqual({ type: 'string', const: 'VERIFIED' });
    expect(zodToJsonSchema(z.boolean())).toEqual({ type: 'boolean' });
  });

  it('converts nested arrays of objects', () => {
    const schema = z.object({
      claims: z.array(z.object({ statement: z.string(), confidence: z.number() })),
    });
    const json = zodToJsonSchema(schema) as { properties: { claims: Record<string, unknown> } };
    expect(json.properties.claims).toEqual({
      type: 'array',
      items: {
        type: 'object',
        properties: { statement: { type: 'string' }, confidence: { type: 'number' } },
        required: ['statement', 'confidence'],
        additionalProperties: false,
      },
    });
  });

  it('expresses nullable as a two-member type', () => {
    expect(zodToJsonSchema(z.string().nullable())).toEqual({ type: ['string', 'null'] });
  });

  it('treats a defaulted field as not required', () => {
    const schema = z.object({ tier: z.number().default(3) });
    const json = zodToJsonSchema(schema) as { required: string[] };
    expect(json.required).toEqual([]);
  });

  it('refuses a type it cannot express instead of emitting something close', () => {
    expect(() => zodToJsonSchema(z.date())).toThrow(/cannot convert/);
    expect(() => zodToJsonSchema(z.union([z.string(), z.number()]))).toThrow(/cannot convert/);
    expect(() => zodToJsonSchema(z.literal(7))).toThrow(/string literals/);
  });
});
