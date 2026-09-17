import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mineral/domain';
import { CalcResponseSchema } from '@mineral/schemas';
import {
  FacilityProposalSchema,
  applyFacilityPolicy,
  type FacilityDecision,
  type FacilityProposal,
} from '@mineral/research';
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

/**
 * A company standing at a stage, by way of a named site. This is the join the
 * chain was missing: `producers` says who was measured putting tonnes out,
 * which needs a promoted fact, and most of the chain has none. An operator is
 * the weaker and much more available statement -- this company has a plant
 * here, and it is running or it is not -- and it carries no quantity at all.
 */
export interface FacilityView {
  facilityId: UUID;
  companyId: UUID;
  legalName: string;
  commonName: string | null;
  name: string;
  facilityType: string | null;
  stageCode: string;
  stageName: string;
  stageSequence: number;
  /** Null where the site's output is not a material this ontology models. */
  materialCode: string | null;
  countryCode: string | null;
  status: string | null;
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
  /** Who has a plant at this point, measured or not. */
  operators: FacilityView[];
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
    operators: [],
    producers: [],
    concentration: null,
  }));
}

const FACILITY_SELECT = `
  select f.id, f.company_id, c.legal_name, c.common_name, f.name, f.facility_type,
         s.code as stage_code, s.name as stage_name, s.sequence_no as stage_sequence,
         m.code as material_code, f.country_code, f.status
    from ontology.facilities f
    join core.companies c on c.id = f.company_id
    join ontology.supply_chain_stages s on s.id = f.stage_id
    left join ontology.materials m on m.id = f.primary_material_id`;

interface FacilityRow {
  id: string;
  company_id: string;
  legal_name: string;
  common_name: string | null;
  name: string;
  facility_type: string | null;
  stage_code: string;
  stage_name: string;
  stage_sequence: number;
  material_code: string | null;
  country_code: string | null;
  status: string | null;
}

function toFacility(row: FacilityRow): FacilityView {
  return {
    facilityId: row.id,
    companyId: row.company_id,
    legalName: row.legal_name,
    commonName: row.common_name,
    name: row.name,
    facilityType: row.facility_type,
    stageCode: row.stage_code,
    stageName: row.stage_name,
    stageSequence: row.stage_sequence,
    materialCode: row.material_code,
    countryCode: row.country_code,
    status: row.status,
  };
}

// --- promotion: claim -> facility -------------------------------------------

export interface FacilityPromotion extends FacilityDecision {
  /** The row it became, or null when policy refused it. */
  facilityId: UUID | null;
  sourceClaimId: UUID | null;
}

export interface PromoteFacilitiesResult {
  runId: UUID;
  companyId: UUID;
  decisions: FacilityPromotion[];
  promoted: number;
}

interface StoredProposal {
  proposal: FacilityProposal;
  claimId: UUID | null;
  claimStatus: string | null;
}

/**
 * Proposals as the run left them. They are read back out of
 * research.module_runs.output rather than from a staging table of their own:
 * the output is already stored verbatim, and a proposal is not a row waiting to
 * be approved so much as a sentence waiting to be checked.
 */
async function loadFacilityProposals(pool: Pool, runId: UUID): Promise<StoredProposal[]> {
  const { rows } = await pool.query<{ output: unknown; claim_map: Record<string, [string, string]> }>(
    `select mr.output,
            coalesce((
              select json_object_agg(c.claim_key, json_build_array(c.id, c.epistemic_status))
                from research.claims c
               where c.module_run_id = mr.id), '{}'::json) as claim_map
       from research.module_runs mr
      where mr.run_id = $1 and mr.status = 'completed' and mr.output is not null`,
    [runId],
  );

  const out: StoredProposal[] = [];
  for (const row of rows) {
    const raw = (row.output as { facilities?: unknown } | null)?.facilities;
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      const parsed = FacilityProposalSchema.safeParse(entry);
      // A stored output that no longer parses is a contract change, not a
      // proposal. Skipping it keeps an old run promotable under a new schema
      // instead of failing the whole pass on one stale row.
      if (!parsed.success) continue;
      const found = row.claim_map?.[parsed.data.source_claim_key];
      out.push({
        proposal: parsed.data,
        claimId: found?.[0] ?? null,
        claimStatus: found?.[1] ?? null,
      });
    }
  }
  return out;
}

async function knownCodes(pool: Pool): Promise<{
  stages: Map<string, UUID>;
  materials: Map<string, UUID>;
  countries: Set<string>;
}> {
  const [stageRows, materialRows, countryRows] = await Promise.all([
    pool.query<{ code: string; id: string }>(`select code, id from ontology.supply_chain_stages`),
    pool.query<{ code: string; id: string }>(`select code, id from ontology.materials`),
    pool.query<{ iso2: string }>(`select iso2 from ontology.countries`),
  ]);
  return {
    stages: new Map(stageRows.rows.map((row) => [row.code, row.id])),
    materials: new Map(materialRows.rows.map((row) => [row.code, row.id])),
    countries: new Set(countryRows.rows.map((row) => row.iso2)),
  };
}

/**
 * Turns the sites a completed run proposed into rows in the ontology.
 *
 * The shape is the assumption path's, deliberately: a module proposed, a pure
 * rule in `applyFacilityPolicy` judged, and only then does anything persist.
 * What lands carries `source_claim_id`, so every promoted facility can be
 * walked back to the claim that produced it and from there to the quote.
 *
 * Re-running this over the same run is safe and is the normal case: the key is
 * (company, name, stage), so a second pass updates the row it wrote the first
 * time rather than adding a twin. A proposal whose claim has since been
 * demoted to CONTRADICTED or STALE stops being approvable, which is the point
 * of founding the row on the claim rather than copying its words.
 */
export async function promoteFacilities(
  pool: Pool,
  runId: UUID,
): Promise<PromoteFacilitiesResult> {
  const { rows } = await pool.query<{ subject_id: string; status: string }>(
    `select subject_id, status from research.runs where id = $1`,
    [runId],
  );
  const run = rows[0];
  if (!run) throw new OntologyError(`no research run ${runId}`);
  if (run.status !== 'completed') {
    throw new OntologyError(`run ${runId} is ${run.status}; promotion needs a completed run`);
  }

  const [stored, codes] = await Promise.all([loadFacilityProposals(pool, runId), knownCodes(pool)]);

  const verdicts = applyFacilityPolicy(
    stored.map((item) => ({
      name: item.proposal.name,
      stageCode: item.proposal.stage_code,
      materialCode: item.proposal.material_code,
      countryCode: item.proposal.country_code,
      status: item.proposal.status,
      sourceClaimStatus: item.claimStatus,
      stageKnown: codes.stages.has(item.proposal.stage_code),
      materialKnown:
        item.proposal.material_code === null || codes.materials.has(item.proposal.material_code),
      countryKnown:
        item.proposal.country_code === null || codes.countries.has(item.proposal.country_code),
    })),
  );

  const decisions: FacilityPromotion[] = [];
  for (const [index, verdict] of verdicts.entries()) {
    const item = stored[index]!;
    if (verdict.status !== 'approved') {
      decisions.push({ ...verdict, facilityId: null, sourceClaimId: item.claimId });
      continue;
    }
    const facilityId = await upsertFacility(pool, run.subject_id, item, codes);
    decisions.push({ ...verdict, facilityId, sourceClaimId: item.claimId });
  }

  return {
    runId,
    companyId: run.subject_id,
    decisions,
    promoted: decisions.filter((decision) => decision.facilityId !== null).length,
  };
}

async function upsertFacility(
  pool: Pool,
  companyId: UUID,
  item: StoredProposal,
  codes: { stages: Map<string, UUID>; materials: Map<string, UUID> },
): Promise<UUID> {
  const stageId = codes.stages.get(item.proposal.stage_code)!;
  const materialId = item.proposal.material_code
    ? (codes.materials.get(item.proposal.material_code) ?? null)
    : null;

  // Looked up before inserting rather than `on conflict`, because minting the
  // entity id has to happen in the insert's own statement and would leave an
  // orphan in core.entities every time the conflict path won.
  return inTransaction(pool, async (client) => {
    const existing = await client.query<{ id: string }>(
      `select id from ontology.facilities
        where company_id = $1 and name = $2 and stage_id is not distinct from $3`,
      [companyId, item.proposal.name, stageId],
    );

    const values = [
      materialId,
      item.proposal.country_code,
      item.proposal.status,
      item.claimId,
    ] as const;

    const found = existing.rows[0];
    if (found) {
      await client.query(
        `update ontology.facilities
            set primary_material_id = $2, country_code = $3, status = $4, source_claim_id = $5
          where id = $1`,
        [found.id, ...values],
      );
      return found.id;
    }

    const { rows } = await client.query<{ id: string }>(
      `insert into ontology.facilities
         (id, company_id, name, stage_id, primary_material_id, country_code, status,
          source_claim_id)
       values (core.new_entity('facility'), $1, $2, $3, $4, $5, $6, $7)
       returning id`,
      [companyId, item.proposal.name, stageId, ...values],
    );
    return rows[0]!.id;
  });
}

/** Who has a plant at one stage. The direct form of "who does separation". */
export async function operatorsOf(pool: Pool, stageCode: string): Promise<FacilityView[]> {
  const { rows } = await pool.query<FacilityRow>(
    `${FACILITY_SELECT} where s.code = $1 order by c.legal_name, f.name`,
    [stageCode],
  );
  return rows.map(toFacility);
}

/** Where one company stands in the chain, earliest stage first. */
export async function facilitiesOf(pool: Pool, companyId: UUID): Promise<FacilityView[]> {
  const { rows } = await pool.query<FacilityRow>(
    `${FACILITY_SELECT} where f.company_id = $1 order by s.sequence_no, f.name`,
    [companyId],
  );
  return rows.map(toFacility);
}

/**
 * Operators for a set of materials. A site is attached to the material it
 * names, and failing that to every material of its stage: Cheshire is a metal
 * plant whose output this ontology does not name, and dropping it from the
 * chain entirely would be a worse answer than placing it at its stage.
 */
async function operatorsForMaterials(pool: Pool, codes: string[]): Promise<Map<string, FacilityView[]>> {
  const { rows } = await pool.query<FacilityRow & { for_material: string }>(
    `select target.code as for_material,
            f.id, f.company_id, c.legal_name, c.common_name, f.name, f.facility_type,
            s.code as stage_code, s.name as stage_name, s.sequence_no as stage_sequence,
            m.code as material_code, f.country_code, f.status
       from ontology.facilities f
       join core.companies c on c.id = f.company_id
       join ontology.supply_chain_stages s on s.id = f.stage_id
       left join ontology.materials m on m.id = f.primary_material_id
       join ontology.materials target
         on target.id = f.primary_material_id
         or (f.primary_material_id is null and target.stage_id = f.stage_id)
      where target.code = any($1::text[])
      order by c.legal_name, f.name`,
    [codes],
  );
  const byMaterial = new Map<string, FacilityView[]>();
  for (const row of rows) {
    const list = byMaterial.get(row.for_material) ?? [];
    list.push(toFacility(row));
    byMaterial.set(row.for_material, list);
  }
  return byMaterial;
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

  const operators = await operatorsForMaterials(pool, codes);
  for (const material of materials) {
    material.operators = operators.get(material.code) ?? [];
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
