import type { PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';

/**
 * Writes shared by every path that produces facts. Ingestion and calculation
 * disagree about where a number comes from and agree about everything after:
 * one fact per observable, a new revision when the value changes, nothing at
 * all when it does not.
 */

export interface FactDefinitionInput {
  code: string;
  name: string;
  valueType: 'numeric' | 'text' | 'boolean' | 'date' | 'json';
  canonicalUnit?: string | null;
  description?: string | null;
}

/** Which slice of time an observable belongs to. Durations carry a period,
 *  instants an as-of date, and a ratio over both carries all three. */
export interface FactPeriod {
  periodStart?: string | null;
  periodEnd?: string | null;
  asOfDate?: string | null;
}

export async function ensureFactDefinitions(
  client: PoolClient,
  definitions: readonly FactDefinitionInput[],
): Promise<Map<string, UUID>> {
  for (const definition of definitions) {
    await client.query(
      `insert into evidence.fact_definitions (code, name, value_type, canonical_unit, description)
       values ($1, $2, $3, $4, $5) on conflict (code) do nothing`,
      [
        definition.code,
        definition.name,
        definition.valueType,
        definition.canonicalUnit ?? null,
        definition.description ?? null,
      ],
    );
  }
  const { rows } = await client.query<{ id: string; code: string }>(
    `select id, code from evidence.fact_definitions where code = any($1::text[])`,
    [definitions.map((d) => d.code)],
  );
  return new Map(rows.map((r) => [r.code, r.id]));
}

/**
 * The fact this observable belongs to, created once. Qualifiers stay empty so
 * the same period reported twice becomes two revisions of one fact rather than
 * two facts that quietly disagree. Selected before inserting because the
 * uniqueness index covers a generated column, which `on conflict` cannot infer.
 */
export async function upsertFact(
  client: PoolClient,
  entityId: UUID,
  definitionId: UUID,
  period: FactPeriod,
): Promise<UUID> {
  const params = [
    entityId,
    definitionId,
    period.periodStart ?? null,
    period.periodEnd ?? null,
    period.asOfDate ?? null,
  ];
  const found = await client.query<{ id: string }>(
    `select id from evidence.facts
      where entity_id = $1 and fact_definition_id = $2
        and period_start is not distinct from $3::date
        and period_end is not distinct from $4::date
        and as_of_date is not distinct from $5::date
        and qualifiers = '{}'::jsonb`,
    params,
  );
  const existing = found.rows[0]?.id;
  if (existing) return existing;

  const { rows } = await client.query<{ id: string }>(
    `insert into evidence.facts
       (entity_type, entity_id, fact_definition_id, period_start, period_end, as_of_date, qualifiers)
     values ('company', $1, $2, $3::date, $4::date, $5::date, '{}'::jsonb)
     returning id`,
    params,
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('could not create the fact');
  return id;
}

/**
 * Current promoted revision, and whether it already carries this value.
 *
 * The comparison happens in SQL, against the column type rather than bare
 * numeric: the column holds twelve decimals, so a ratio is rounded on the way
 * in, and comparing the unrounded value would call every re-run a restatement.
 * Doing it in JavaScript instead would be worse still -- float equality on a
 * 38-digit decimal is not equality.
 */
export async function currentFactVersion(
  client: PoolClient,
  factId: UUID,
  value: number,
): Promise<{ id: UUID; same: boolean } | null> {
  const { rows } = await client.query<{ id: string; same: boolean }>(
    `select fv.id, (fv.numeric_value = $2::numeric(38,12)) as same
       from evidence.facts f
       join evidence.fact_versions fv on fv.id = f.current_version_id
      where f.id = $1`,
    [factId, String(value)],
  );
  const row = rows[0];
  return row ? { id: row.id, same: row.same } : null;
}
