import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import { CalcResponseSchema } from '@mineral/schemas';
import { inTransaction } from './client.ts';
import { currentFactVersion, ensureFactDefinitions, upsertFact } from './facts.ts';
import type { CalcFn } from './decision-repository.ts';

/**
 * The supply chain (report J.11, brief section 17).
 *
 * Two different kinds of thing live behind this file and they are kept apart
 * on purpose. The chain itself -- stages, materials, what flows into what -- is
 * structure: it is seeded, it has no source document, and it says what a
 * separation plant is rather than anything about a company. Who produces how
 * much is measurement: it arrives as a promoted fact with a filing under it,
 * and nothing here invents one.
 *
 * A bottleneck is the second kind. It is computed by the analytics engine from
 * measured quantities and stored as a calculation run, so the page reads an
 * index back rather than working one out (invariant C.9). Where no quantities
 * have been ingested there is no index, and the page says so instead of
 * drawing a chart of nothing.
 */

/** Fact definitions that attribute output to a point in the chain. */
export const PRODUCTION_FACT_CODES = ['production_volume', 'nameplate_capacity'] as const;
export type ProductionFactCode = (typeof PRODUCTION_FACT_CODES)[number];

/**
 * A production fact names its material in its qualifiers. That is the join
 * between measurement and structure, and it is deliberately a code rather than
 * a foreign key: `evidence.facts` is written by ingestion, which knows about
 * filings and not about the ontology, and a qualifier it cannot resolve is a
 * fact that simply does not appear on a chain page.
 */
const MATERIAL_QUALIFIER = 'material';

export class OntologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OntologyError';
  }
}

export interface StageView {
  stageId: UUID;
  code: string;
  name: string;
  sequenceNo: number;
}

export interface ProducerView {
  companyId: UUID;
  legalName: string;
  commonName: string | null;
  factVersionId: UUID;
  factCode: string;
  quantity: number;
  unit: string | null;
  periodEnd: string | null;
  /** The filing the quantity was read off, when it came from one. */
  sourceDocumentVersionId: UUID | null;
}

export interface ConcentrationView {
  calculationRunId: UUID;
  factCode: string;
  calculatedAt: string;
  engineVersion: string;
  /** Producer count the index was computed over. */
  producerCount: number;
  outputs: { code: string; name: string; value: number; unit: string }[];
  byProducer: { label: string; quantity: number; share: number }[];
}

export interface MaterialView {
  materialId: UUID;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  stage: StageView | null;
  elements: { symbol: string; name: string }[];
  /** Material codes this one supplies, downstream. */
  supplies: string[];
  producers: ProducerView[];
  concentration: ConcentrationView | null;
}

export interface SupplyChainView {
  /** The material the page was asked about. */
  focus: string;
  stages: StageView[];
  materials: MaterialView[];
  endMarkets: { code: string; name: string }[];
}

function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// --- reading ----------------------------------------------------------------

export async function stages(pool: Pool): Promise<StageView[]> {
  const { rows } = await pool.query<{
    id: string;
    code: string;
    name: string;
    sequence_no: number;
  }>(
    `select id, code, name, sequence_no
       from ontology.supply_chain_stages
      order by sequence_no`,
  );
  return rows.map((row) => ({
    stageId: row.id,
    code: row.code,
    name: row.name,
    sequenceNo: row.sequence_no,
  }));
}

/**
 * Everything reachable from one material by following SUPPLIES in both
 * directions. A chain is a walk, not a table: asking about the magnet has to
 * reach the mine, and asking about the mine has to reach the motor.
 */
async function connectedMaterials(pool: Pool, code: string): Promise<string[]> {
  const { rows } = await pool.query<{ code: string }>(
    `with recursive seed as (
       select id from ontology.materials where code = $1
     ),
     walk (id, depth) as (
       select id, 0 from seed
       union
       select case when r.from_entity_id = w.id then r.to_entity_id else r.from_entity_id end,
              w.depth + 1
         from walk w
         join ontology.entity_relationships r
           on r.relationship_type = 'SUPPLIES'
          and (r.from_entity_id = w.id or r.to_entity_id = w.id)
        where w.depth < 12
     )
     select distinct m.code
       from walk w
       join ontology.materials m on m.id = w.id`,
    [code],
  );
  return rows.map((row) => row.code);
}

interface MaterialRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  stage_id: string | null;
  stage_code: string | null;
  stage_name: string | null;
  stage_sequence: number | null;
  elements: { symbol: string; name: string }[] | null;
  supplies: string[] | null;
}

async function loadMaterials(pool: Pool, codes: string[]): Promise<MaterialView[]> {
  const { rows } = await pool.query<MaterialRow>(
    `select m.id, m.code, m.name, m.category, m.description,
            s.id as stage_id, s.code as stage_code, s.name as stage_name,
            s.sequence_no as stage_sequence,
            coalesce((
              select json_agg(json_build_object('symbol', e.symbol, 'name', e.name) order by e.symbol)
                from ontology.material_elements me
                join ontology.elements e on e.id = me.element_id
               where me.material_id = m.id), '[]'::json) as elements,
            coalesce((
              select json_agg(down.code order by down.code)
                from ontology.entity_relationships r
                join ontology.materials down on down.id = r.to_entity_id
               where r.from_entity_id = m.id and r.relationship_type = 'SUPPLIES'), '[]'::json) as supplies
       from ontology.materials m
       left join ontology.supply_chain_stages s on s.id = m.stage_id
      where m.code = any($1::text[])
      order by s.sequence_no nulls last, m.code`,
    [codes],
  );

  return rows.map((row) => ({
    materialId: row.id,
    code: row.code,
    name: row.name,
    category: row.category,
    description: row.description,
    stage:
      row.stage_id && row.stage_code && row.stage_name && row.stage_sequence !== null
        ? {
            stageId: row.stage_id,
            code: row.stage_code,
            name: row.stage_name,
            sequenceNo: row.stage_sequence,
          }
        : null,
    elements: row.elements ?? [],
    supplies: row.supplies ?? [],
    producers: [],
    concentration: null,
  }));
}

/**
 * Companies with a promoted quantity attributed to this material. One revision
 * per company: the current one, which is the only one that describes now.
 */
export async function producersOf(
  pool: Pool,
  materialCode: string,
  options: { factCode?: ProductionFactCode } = {},
): Promise<ProducerView[]> {
  const factCode = options.factCode ?? 'production_volume';
  const { rows } = await pool.query<{
    company_id: string;
    legal_name: string;
    common_name: string | null;
    fact_version_id: string;
    fact_code: string;
    quantity: string;
    unit: string | null;
    period_end: string | null;
    source_document_version_id: string | null;
  }>(
    `select distinct on (c.id)
            c.id as company_id, c.legal_name, c.common_name,
            fv.id as fact_version_id, fd.code as fact_code,
            fv.numeric_value::text as quantity, fv.unit,
            f.period_end::text, fv.source_document_version_id
       from evidence.facts f
       join evidence.fact_definitions fd on fd.id = f.fact_definition_id
       join evidence.fact_versions fv on fv.id = f.current_version_id
       join core.companies c on c.id = f.entity_id
      where fd.code = $1
        and f.qualifiers->>'${MATERIAL_QUALIFIER}' = $2
        and fv.numeric_value is not null
      order by c.id, f.period_end desc nulls last`,
    [factCode, materialCode],
  );

  return rows
    .map((row) => ({
      companyId: row.company_id,
      legalName: row.legal_name,
      commonName: row.common_name,
      factVersionId: row.fact_version_id,
      factCode: row.fact_code,
      quantity: num(row.quantity) ?? 0,
      unit: row.unit,
      periodEnd: row.period_end,
      sourceDocumentVersionId: row.source_document_version_id,
    }))
    .sort((left, right) => right.quantity - left.quantity);
}

/** The newest stored concentration run for a material, read back as stored. */
export async function latestConcentration(
  pool: Pool,
  materialId: UUID,
): Promise<ConcentrationView | null> {
  const { rows } = await pool.query<{
    id: string;
    engine_version: string;
    calculated_at: string;
    fact_code: string | null;
    outputs: { code: string; name: string; value: number; unit: string }[] | null;
    by_producer: { label: string; quantity: number; share: number }[] | null;
    producer_count: number | null;
  }>(
    `select cr.id, cr.engine_version, cr.calculated_at::text,
            cr.input_snapshot->'inputs'->>'fact_code' as fact_code,
            cr.output->'outputs' as outputs,
            cr.output->'detail'->'by_producer' as by_producer,
            (cr.output->'detail'->>'producer_count')::int as producer_count
       from valuation.calculation_runs cr
      where cr.subject_id = $1 and cr.method = 'concentration' and cr.status = 'completed'
      order by cr.calculated_at desc
      limit 1`,
    [materialId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    calculationRunId: row.id,
    factCode: row.fact_code ?? 'production_volume',
    calculatedAt: row.calculated_at,
    engineVersion: row.engine_version,
    producerCount: row.producer_count ?? 0,
    outputs: row.outputs ?? [],
    byProducer: row.by_producer ?? [],
  };
}

export async function supplyChain(pool: Pool, materialCode: string): Promise<SupplyChainView | null> {
  const codes = await connectedMaterials(pool, materialCode);
  if (codes.length === 0) return null;

  const [stageRows, materials, endMarkets] = await Promise.all([
    stages(pool),
    loadMaterials(pool, codes),
    pool.query<{ code: string; name: string }>(
      `select code, name from ontology.end_markets order by code`,
    ),
  ]);

  for (const material of materials) {
    material.producers = await producersOf(pool, material.code);
    material.concentration = await latestConcentration(pool, material.materialId);
  }

  return {
    focus: materialCode,
    stages: stageRows,
    materials,
    endMarkets: endMarkets.rows,
  };
}

// --- writing ----------------------------------------------------------------

export async function ensureProductionFactDefinitions(client: PoolClient): Promise<Map<string, UUID>> {
  return ensureFactDefinitions(client, [
    {
      code: 'production_volume',
      name: 'Production volume',
      valueType: 'numeric',
      canonicalUnit: 't',
      description: 'Quantity of a material produced over a period, as reported.',
    },
    {
      code: 'nameplate_capacity',
      name: 'Nameplate capacity',
      valueType: 'numeric',
      canonicalUnit: 't',
      description: 'Designed annual output of a facility for a material, as reported.',
    },
  ]);
}

export interface RecordProductionInput {
  companyId: UUID;
  materialCode: string;
  factCode?: ProductionFactCode;
  quantity: number;
  unit: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  /** The filing the quantity was read off. Required: see below. */
  sourceDocumentVersionId: UUID;
  quoteExcerpt?: string | null;
}

/**
 * Records a measured quantity at a point in the chain.
 *
 * `extraction_method` is 'manual' and the source document version is required
 * rather than optional, because this is the one path into the fact tables that
 * no automated extractor stands behind. XBRL carries financial statements and
 * says nothing about tonnes of oxide, and the model extraction that would read
 * a production table out of prose is report D.2b, which is not built. Until it
 * is, a tonnage enters the record the way a person would enter it: with the
 * document it came from attached, so invariant C.1 holds and the page can
 * still reach the filing.
 */
export async function recordProduction(pool: Pool, input: RecordProductionInput): Promise<UUID> {
  if (!Number.isFinite(input.quantity) || input.quantity < 0) {
    throw new OntologyError('a production quantity must be a finite, non-negative number');
  }
  return inTransaction(pool, async (client) => {
    const { rows: materials } = await client.query<{ id: string }>(
      `select id from ontology.materials where code = $1`,
      [input.materialCode],
    );
    if (!materials[0]) throw new OntologyError(`no material with code ${input.materialCode}`);

    const definitions = await ensureProductionFactDefinitions(client);
    const code = input.factCode ?? 'production_volume';
    const definitionId = definitions.get(code);
    if (!definitionId) throw new OntologyError(`no fact definition for ${code}`);

    const factId = await upsertFact(client, input.companyId, definitionId, {
      periodStart: input.periodStart ?? null,
      periodEnd: input.periodEnd ?? null,
      qualifiers: { [MATERIAL_QUALIFIER]: input.materialCode },
    });

    const current = await currentFactVersion(client, factId, input.quantity);
    if (current?.same) return current.id;

    const { rows } = await client.query<{ id: string }>(
      `insert into evidence.fact_versions
         (fact_id, numeric_value, unit, observed_at, extraction_method,
          source_document_version_id, quote_excerpt, supersedes_version_id)
       values ($1, $2::numeric, $3, now(), 'manual', $4, $5, $6)
       returning id`,
      [
        factId,
        String(input.quantity),
        input.unit,
        input.sourceDocumentVersionId,
        input.quoteExcerpt ?? null,
        current?.id ?? null,
      ],
    );
    const versionId = rows[0]?.id;
    if (!versionId) throw new OntologyError(`could not record ${code} for ${input.materialCode}`);
    await client.query(`select evidence.promote_fact_version($1, 'user')`, [versionId]);
    return versionId;
  });
}

export interface RecordConcentrationResult {
  calculationRunId: UUID;
  materialId: UUID;
  producers: ProducerView[];
  outputs: { code: string; name: string; value: number; unit: string }[];
}

/**
 * Measures how concentrated one point in the chain is, and stores the answer.
 *
 * The result is a calculation run rather than a promoted fact. A run already
 * carries everything the provenance needs -- the engine and its version, the
 * inputs it was handed, and a row per input revision in
 * `calculation_run_inputs` -- so an index on a page reaches each producer's
 * filing the same way a valuation input does. Promoting it as a fact as well
 * would say the same thing twice, and a concentration index is a statement
 * about a market rather than about the material, which is what a fact on this
 * entity would claim it was.
 */
export async function recordConcentration(
  pool: Pool,
  input: {
    materialCode: string;
    calc: CalcFn;
    factCode?: ProductionFactCode;
    topN?: number;
  },
): Promise<RecordConcentrationResult> {
  const factCode = input.factCode ?? 'production_volume';
  const { rows } = await pool.query<{ id: string }>(
    `select id from ontology.materials where code = $1`,
    [input.materialCode],
  );
  const materialId = rows[0]?.id;
  if (!materialId) throw new OntologyError(`no material with code ${input.materialCode}`);

  const producers = await producersOf(pool, input.materialCode, { factCode });
  if (producers.length === 0) {
    throw new OntologyError(
      `no promoted ${factCode} attributed to ${input.materialCode}; ingest production data first`,
    );
  }

  const inputs = {
    quantities: producers.map((producer) => producer.quantity),
    labels: producers.map((producer) => producer.commonName ?? producer.legalName),
    ...(input.topN ? { top_n: input.topN } : {}),
  };
  const unit = producers[0]!.unit ?? 't';
  // The engine is currency-blind and substitutes the caller's currency wherever
  // an output is money. A share of a market is not money, so the honest value
  // to send is ISO 4217's XXX: the code that means no currency is involved.
  const response = CalcResponseSchema.parse(await input.calc('concentration', inputs, 'XXX'));

  const calculationRunId = await inTransaction(pool, async (client) => {
    const run = await client.query<{ id: string }>(
      `insert into valuation.calculation_runs
         (subject_type, subject_id, method, engine, engine_version, status,
          input_snapshot, output)
       values ('material', $1, 'concentration', $2, $3, 'completed', $4::jsonb, $5::jsonb)
       returning id`,
      [
        materialId,
        response.engine,
        response.engine_version,
        // `currency` is the key every other calculation run uses for the unit
        // its inputs were measured in. Here that is tonnes, not money.
        JSON.stringify({ currency: unit, inputs: { ...inputs, fact_code: factCode } }),
        JSON.stringify({ outputs: response.outputs, detail: response.detail }),
      ],
    );
    const runId = run.rows[0]?.id;
    if (!runId) throw new OntologyError('could not store the concentration run');

    // One row per producer revision. This is the drill-down: an index names the
    // revisions it was computed from, and each of those names its filing.
    for (const producer of producers) {
      await client.query(
        `insert into valuation.calculation_run_inputs
           (calculation_run_id, fact_version_id, role)
         values ($1, $2, $3)`,
        [runId, producer.factVersionId, `producer:${producer.commonName ?? producer.legalName}`],
      );
    }
    return runId;
  });

  return {
    calculationRunId,
    materialId,
    producers,
    outputs: response.outputs.map((output) => ({
      code: output.code,
      name: output.name,
      value: output.value,
      unit: output.unit,
    })),
  };
}
