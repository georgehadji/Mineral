import type { ZodTypeAny } from 'zod';

/**
 * Zod to JSON Schema, for the subset a model tool call can actually express.
 *
 * Deliberately narrow rather than general. A general converter emits refs and
 * unions that providers quietly mishandle, and a schema the provider misreads
 * produces output that looks structured and is not. This one refuses what it
 * cannot express, which fails at build time instead of in a stored claim.
 */

export type JsonSchema = Record<string, unknown>;

interface ZodDef {
  typeName: string;
  description?: string;
  innerType?: ZodTypeAny;
  type?: ZodTypeAny;
  values?: readonly string[];
  value?: unknown;
  shape?: () => Record<string, ZodTypeAny>;
  checks?: readonly { kind: string }[];
}

const defOf = (schema: ZodTypeAny): ZodDef => (schema as unknown as { _def: ZodDef })._def;

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  const def = defOf(schema);
  const described = (body: JsonSchema): JsonSchema =>
    def.description ? { ...body, description: def.description } : body;

  switch (def.typeName) {
    case 'ZodString':
      return described({ type: 'string' });
    case 'ZodNumber':
      return described({ type: def.checks?.some((c) => c.kind === 'int') ? 'integer' : 'number' });
    case 'ZodBoolean':
      return described({ type: 'boolean' });
    case 'ZodEnum':
      return described({ type: 'string', enum: [...(def.values ?? [])] });
    case 'ZodLiteral': {
      if (typeof def.value !== 'string') throw unsupported('only string literals are supported');
      return described({ type: 'string', const: def.value });
    }
    case 'ZodArray': {
      if (!def.type) throw unsupported('array without an element type');
      return described({ type: 'array', items: zodToJsonSchema(def.type) });
    }
    case 'ZodObject':
      return described(objectSchema(def));
    case 'ZodOptional':
    case 'ZodDefault': {
      if (!def.innerType) throw unsupported(`${def.typeName} without an inner type`);
      const inner = zodToJsonSchema(def.innerType);
      return def.description ? { ...inner, description: def.description } : inner;
    }
    case 'ZodNullable': {
      if (!def.innerType) throw unsupported('nullable without an inner type');
      return described(nullable(zodToJsonSchema(def.innerType)));
    }
    default:
      throw unsupported(`${def.typeName} has no JSON Schema form here`);
  }
}

function objectSchema(def: ZodDef): JsonSchema {
  const shape = def.shape?.() ?? {};
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(value);
    if (!isOptional(value)) required.push(key);
  }
  // additionalProperties false: a model that invents a field should fail the
  // schema rather than have the extra quietly dropped on parse.
  return { type: 'object', properties, required, additionalProperties: false };
}

function isOptional(schema: ZodTypeAny): boolean {
  const name = defOf(schema).typeName;
  return name === 'ZodOptional' || name === 'ZodDefault';
}

function nullable(inner: JsonSchema): JsonSchema {
  const type = inner.type;
  if (typeof type !== 'string') throw unsupported('nullable needs a single-typed inner schema');
  return { ...inner, type: [type, 'null'] };
}

function unsupported(message: string): Error {
  return new Error(`cannot convert to JSON Schema: ${message}`);
}
