/**
 * Integration test. Needs a PostgreSQL database with the migrations and all
 * three seeds applied, addressed by DATABASE_URL. Skipped without one.
 *
 * This is the phase J.11 gate: the supply-chain page for NdPr. The chain has to
 * walk from the mine to the motor, a measured tonnage has to reach the stage it
 * belongs to, and the concentration index has to come back from a stored run
 * rather than from arithmetic done while rendering.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool, type Pool } from './client.ts';
import {
  OntologyError,
  facilitiesOf,
  latestConcentration,
  operatorsOf,
  producersOf,
  recordConcentration,
  recordProduction,
  stages,
  supplyChain,
} from './ontology-repository.ts';
import type { CalcFn } from './decision-repository.ts';

const url = process.env.DATABASE_URL;

describe.skipIf(!url)('the supply chain', () => {
  let pool: Pool;
  let documentVersionId: string;
  let materialId: string;
  const companyIds = new Map<string, string>();
  const run = randomUUID().slice(0, 8);
  const SOURCE_NAME = `chain-test-source-${run}`;

  /**
   * The suite measures its own material rather than `ndpr_oxide`.
   *
   * Concentration is a property of everyone who produces a material, so a
   * second source of quantities anywhere on the seeded chain changes the index
   * and the producer count. That is correct behaviour and it makes an exact
   * assertion against a shared material a promise the suite cannot keep. This
   * material sits at the same stage and supplies the same downstream material,
   * so the chain reads identically; nothing else will ever write to it.
   */
  const MATERIAL = `chain_test_${run}`;

  /**
   * Quantities chosen so the arithmetic is checkable by hand: 6000, 3000 and
   * 1000 of 10000 give shares of 0.6, 0.3 and 0.1, and an HHI of 0.46.
   *
   * The producers are created by this suite rather than taken from the seed.
   * Every seeded issuer already belongs to another database suite, and vitest
   * runs the files in parallel: promoting a fact against one of them would
   * change that suite's snapshot hash underneath it and turn a re-run into a
   * new run. A producer is only an entity, so owning three is cheaper than
   * sharing one.
   */
  const OUTPUT: [string, number][] = [
    [`Chain Alpha ${run}`, 6000],
    [`Chain Beta ${run}`, 3000],
    [`Chain Gamma ${run}`, 1000],
  ];

  /**
   * The engine, as a seam. The real one over HTTP gives the same answer and is
   * golden-tested in `services/analytics/tests/test_concentration.py`; this
   * keeps the suite off the network while still parsing the reply through
   * CalcResponseSchema on the way back in.
   */
  const calc: CalcFn = async (method, inputs, currency) => {
    expect(method).toBe('concentration');
    // ISO 4217 XXX: no currency is involved in a market share.
    expect(currency).toBe('XXX');
    const quantities = (inputs.quantities as number[]) ?? [];
    const total = quantities.reduce((sum, value) => sum + value, 0);
    const shares = quantities.map((value) => value / total).sort((a, b) => b - a);
    return {
      method,
      engine: 'concentration',
      engine_version: '0.3.0',
      currency,
      inputs,
      outputs: [
        {
          code: 'hhi',
          name: 'Herfindahl-Hirschman index',
          value: shares.reduce((sum, share) => sum + share * share, 0),
          unit: 'ratio',
          inputs: ['quantities'],
        },
        {
          code: 'top_share',
          name: 'Largest single share',
          value: shares[0]!,
          unit: 'ratio',
          inputs: ['quantities'],
        },
      ],
      detail: {
        shares,
        producer_count: quantities.length,
        by_producer: (inputs.labels as string[]).map((label, index) => ({
          label,
          quantity: quantities[index]!,
          share: quantities[index]! / total,
        })),
      },
    };
  };

  async function purge(): Promise<void> {
    const ids = [...companyIds.values()];
    if (ids.length > 0) {
      await pool.query(
        `delete from valuation.calculation_run_inputs where fact_version_id in (
           select fv.id from evidence.fact_versions fv
             join evidence.facts f on f.id = fv.fact_id
            where f.entity_id = any($1::uuid[]) and f.qualifiers ? 'material')`,
        [ids],
      );
      await pool.query(
        `update evidence.facts set current_version_id = null
          where entity_id = any($1::uuid[]) and qualifiers ? 'material'`,
        [ids],
      );
      await pool.query(
        `delete from evidence.fact_versions where fact_id in (
           select id from evidence.facts
            where entity_id = any($1::uuid[]) and qualifiers ? 'material')`,
        [ids],
      );
      await pool.query(
        `delete from evidence.facts where entity_id = any($1::uuid[]) and qualifiers ? 'material'`,
        [ids],
      );
    }
    if (materialId) {
      await pool.query(
        `delete from valuation.calculation_run_inputs where calculation_run_id in (
           select id from valuation.calculation_runs where subject_id = $1)`,
        [materialId],
      );
      await pool.query(`delete from valuation.calculation_runs where subject_id = $1`, [materialId]);
      await pool.query(
        `delete from ontology.entity_relationships where from_entity_id = $1 or to_entity_id = $1`,
        [materialId],
      );
      await pool.query(`delete from ontology.materials where id = $1`, [materialId]);
      await pool.query(`delete from core.entities where id = $1`, [materialId]);
    }
    await pool.query(
      `delete from evidence.document_chunks dc using evidence.document_versions dv,
              evidence.documents d, evidence.sources s
        where dc.document_version_id = dv.id and dv.document_id = d.id
          and d.source_id = s.id and s.source_name = $1`,
      [SOURCE_NAME],
    );
    await pool.query(
      `delete from evidence.document_versions dv using evidence.documents d, evidence.sources s
        where dv.document_id = d.id and d.source_id = s.id and s.source_name = $1`,
      [SOURCE_NAME],
    );
    await pool.query(
      `delete from evidence.documents d using evidence.sources s
        where d.source_id = s.id and s.source_name = $1`,
      [SOURCE_NAME],
    );
    await pool.query(`delete from evidence.sources where source_name = $1`, [SOURCE_NAME]);

    if (ids.length > 0) {
      await pool.query(`delete from core.companies where id = any($1::uuid[])`, [ids]);
      await pool.query(`delete from core.entities where id = any($1::uuid[])`, [ids]);
    }
  }

  beforeAll(async () => {
    pool = createPool(url);

    const seeded = await pool.query<{ id: string }>(
      `select id from ontology.materials where code = 'ndpr_oxide'`,
    );
    if (!seeded.rows[0]) throw new Error('seed 002 is not applied');

    // A material of this suite's own, at the separation stage and supplying the
    // same downstream material the seeded oxide does.
    const material = await pool.query<{ id: string }>(
      `with e as (select core.new_entity('material') as id)
       insert into ontology.materials (id, code, name, category, stage_id, description)
       select e.id, $1, $1, 'oxide',
              (select id from ontology.supply_chain_stages where code = 'separation'),
              'Created by the supply-chain integration suite.'
         from e
       returning id`,
      [MATERIAL],
    );
    materialId = material.rows[0]!.id;
    await pool.query(
      `insert into ontology.entity_relationships
         (from_entity_id, relationship_type, to_entity_id, confidence)
       select $1, 'SUPPLIES', m.id, 1.0 from ontology.materials m where m.code = 'ndpr_metal'`,
      [materialId],
    );

    for (const [name] of OUTPUT) {
      const company = await pool.query<{ id: string }>(
        `with e as (select core.new_entity('company') as id)
         insert into core.companies (id, legal_name, common_name, status)
         select e.id, $1, $1, 'active' from e
         returning id`,
        [name],
      );
      companyIds.set(name, company.rows[0]!.id);
    }

    // No purge here. Every name this suite writes carries its run id, so there
    // is nothing of its own left behind to clear, and purge now deletes the
    // producers it has just created.

    // The quantities need a filing under them, so one is planted. It cannot
    // reach the other suites: the source is named for this run, and so are the
    // three producers and the material they produce.
    const source = await pool.query<{ id: string }>(
      `insert into evidence.sources (source_name, source_type, source_tier, publisher)
       values ($1, 'filing', 1, 'Test') returning id`,
      [SOURCE_NAME],
    );
    const document = await pool.query<{ id: string }>(
      `insert into evidence.documents (source_id, external_id, document_type, title, published_at)
       values ($1, $2, '10-K', $3, now()) returning id`,
      [source.rows[0]!.id, `chain-test-${run}`, `Production disclosure (chain ${run})`],
    );
    const version = await pool.query<{ id: string }>(
      `insert into evidence.document_versions (document_id, version_no, content_hash, raw_text)
       values ($1, 1, $2, $3) returning id`,
      [
        document.rows[0]!.id,
        `chain-hash-${run}`,
        'Separated NdPr oxide production for the year is set out in the table above.',
      ],
    );
    documentVersionId = version.rows[0]!.id;
  }, 60_000);

  afterAll(async () => {
    if (!pool) return;
    await purge();
    await pool.end();
  });

  it('knows the nine stages of the chain, in order', async () => {
    const ordered = await stages(pool);
    expect(ordered.map((stage) => stage.code)).toEqual([
      'mining',
      'concentration',
      'separation',
      'refining',
      'metal',
      'alloy',
      'magnet',
      'motor',
      'recycling',
    ]);
  });

  it('walks from separated oxide to the mine and to the motor', async () => {
    const chain = await supplyChain(pool, 'ndpr_oxide');
    expect(chain).not.toBeNull();
    const codes = chain!.materials.map((material) => material.code);
    expect(codes).toContain('rare_earth_ore');
    expect(codes).toContain('ndfeb_magnet');
    expect(codes).toContain('traction_motor');

    const oxide = chain!.materials.find((material) => material.code === 'ndpr_oxide');
    expect(oxide!.stage?.code).toBe('separation');
    expect(oxide!.supplies).toEqual(['ndpr_metal']);
    expect(oxide!.elements.map((element) => element.symbol).sort()).toEqual(['Nd', 'Pr']);
  });

  it('returns nothing for a material that does not exist', async () => {
    expect(await supplyChain(pool, 'unobtainium')).toBeNull();
  });

  /**
   * Standing at a stage and being measured at one are different claims, and
   * the chain has to be able to make the first without the second. Seed 003
   * carries no quantity at all, so these read back from facilities alone.
   */
  it('names who stands at a stage', async () => {
    const separators = await operatorsOf(pool, 'separation');
    expect(separators.every((facility) => facility.stageCode === 'separation')).toBe(true);

    const plants = separators.find((facility) => facility.name === 'Mountain Pass separation plants');
    expect(plants?.commonName).toBe('MP Materials');
    expect(plants?.status).toBe('operating');
    expect(plants?.materialCode).toBe('ndpr_oxide');

    const chain = await supplyChain(pool, 'ndpr_oxide');
    const oxide = chain!.materials.find((material) => material.code === 'ndpr_oxide')!;
    expect(oxide.operators.map((facility) => facility.name)).toContain(
      'Mountain Pass separation plants',
    );
  });

  it('places a site at its stage when the filing does not name its output', async () => {
    const cheshire = (await operatorsOf(pool, 'metal')).find(
      (facility) => facility.name === 'Cheshire metal plant',
    );
    expect(cheshire?.materialCode).toBeNull();

    const chain = await supplyChain(pool, 'ndpr_metal');
    const metal = chain!.materials.find((material) => material.code === 'ndpr_metal')!;
    expect(metal.operators.map((facility) => facility.name)).toContain('Cheshire metal plant');
  });

  it('walks one company across every stage it occupies, in chain order', async () => {
    const mp = (await operatorsOf(pool, 'mining')).find(
      (facility) => facility.commonName === 'MP Materials',
    )!;
    const across = await facilitiesOf(pool, mp.companyId);
    expect(across.map((facility) => facility.stageCode)).toEqual([
      'mining',
      'concentration',
      'separation',
      'metal',
      'magnet',
    ]);
  });

  it('refuses to measure a stage nobody has reported output for', async () => {
    await expect(recordConcentration(pool, { materialCode: MATERIAL, calc })).rejects.toThrow(
      OntologyError,
    );
  });

  it('attributes a measured tonnage to the stage it belongs to', async () => {
    for (const [name, quantity] of OUTPUT) {
      await recordProduction(pool, {
        companyId: companyIds.get(name)!,
        materialCode: MATERIAL,
        quantity,
        unit: 't',
        periodStart: '2025-01-01',
        periodEnd: '2025-12-31',
        sourceDocumentVersionId: documentVersionId,
        quoteExcerpt: 'Separated NdPr oxide production for the year is set out in the table above.',
      });
    }

    const producers = await producersOf(pool, MATERIAL);
    expect(producers.map((producer) => producer.quantity)).toEqual([6000, 3000, 1000]);
    expect(
      producers.every((producer) => producer.sourceDocumentVersionId === documentVersionId),
    ).toBe(true);

    // The same quantity recorded twice is the same revision, not a restatement.
    const again = await recordProduction(pool, {
      companyId: companyIds.get(OUTPUT[0]![0])!,
      materialCode: MATERIAL,
      quantity: 6000,
      unit: 't',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      sourceDocumentVersionId: documentVersionId,
    });
    expect(again).toBe(producers[0]!.factVersionId);
  });

  it('stores the concentration index and every revision it was computed from', async () => {
    const result = await recordConcentration(pool, { materialCode: MATERIAL, calc });
    const byCode = new Map(result.outputs.map((output) => [output.code, output.value]));
    expect(byCode.get('hhi')).toBeCloseTo(0.46, 6);
    expect(byCode.get('top_share')).toBeCloseTo(0.6, 6);

    const inputs = await pool.query<{ fact_version_id: string; role: string }>(
      `select fact_version_id, role from valuation.calculation_run_inputs
        where calculation_run_id = $1 order by role`,
      [result.calculationRunId],
    );
    expect(inputs.rows).toHaveLength(3);
    expect(inputs.rows.map((row) => row.role).sort()).toEqual(
      OUTPUT.map(([name]) => `producer:${name}`).sort(),
    );

    // The drill-down: an index names a revision, and the revision names its filing.
    const traced = await pool.query<{ source_document_version_id: string }>(
      `select fv.source_document_version_id
         from valuation.calculation_run_inputs cri
         join evidence.fact_versions fv on fv.id = cri.fact_version_id
        where cri.calculation_run_id = $1`,
      [result.calculationRunId],
    );
    expect(traced.rows.every((row) => row.source_document_version_id === documentVersionId)).toBe(
      true,
    );
  });

  it('reads the index back from the stored run rather than computing it again', async () => {
    const stored = await latestConcentration(pool, materialId);
    expect(stored).not.toBeNull();
    expect(stored!.producerCount).toBe(3);
    expect(stored!.factCode).toBe('production_volume');
    expect(stored!.outputs.find((output) => output.code === 'hhi')!.value).toBeCloseTo(0.46, 6);
    expect(stored!.byProducer.map((row) => row.label)).toEqual(OUTPUT.map(([name]) => name));
  });

  it('puts the producers and the index on the chain the page renders', async () => {
    const chain = await supplyChain(pool, MATERIAL);
    const measured = chain!.materials.find((material) => material.code === MATERIAL);
    expect(measured!.producers).toHaveLength(3);
    expect(
      measured!.concentration?.outputs.find((output) => output.code === 'hhi')?.value,
    ).toBeCloseTo(0.46, 6);
    expect(measured!.producers[0]!.sourceDocumentVersionId).toBe(documentVersionId);

    // Walking downstream from a measured stage still reaches the rest of the
    // chain, and a stage nobody has measured stays empty rather than being
    // filled in.
    const magnet = chain!.materials.find((material) => material.code === 'ndfeb_magnet');
    expect(magnet).toBeDefined();
    expect(magnet!.producers).toEqual([]);
    expect(magnet!.concentration).toBeNull();
  });
});
