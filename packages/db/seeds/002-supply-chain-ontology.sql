-- Supply-chain ontology for the first domain: rare earths into permanent
-- magnets (brief section 17, report J.11).
--
-- What this seeds is structure, not measurement. Stages, elements, materials
-- and the flow between them are definitions of the chain: they say what a
-- separation plant is and what comes out of one. Who produces how much is a
-- fact, and a fact has to be ingested from a source with a tier on it. Nothing
-- in this file invents a tonne, a share or a price.
--
-- Re-runnable: every insert either carries a conflict clause or is guarded, so
-- applying it twice changes nothing.

begin;

-- core.new_entity(entity_type) mints the shared id these tables hang off, so a
-- stage and a company are addressable by the same relationship table.
create or replace function pg_temp.seed_stage(p_code text, p_name text, p_seq integer)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from ontology.supply_chain_stages where code = p_code;
  if v_id is not null then
    update ontology.supply_chain_stages set name = p_name, sequence_no = p_seq where id = v_id;
    return v_id;
  end if;
  v_id := core.new_entity('supply_chain_stage');
  insert into ontology.supply_chain_stages (id, code, name, sequence_no)
  values (v_id, p_code, p_name, p_seq);
  return v_id;
end $$;

create or replace function pg_temp.seed_element(p_symbol text, p_name text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from ontology.elements where symbol = p_symbol;
  if v_id is not null then return v_id; end if;
  v_id := core.new_entity('element');
  insert into ontology.elements (id, symbol, name) values (v_id, p_symbol, p_name);
  return v_id;
end $$;

create or replace function pg_temp.seed_material(
  p_code text, p_name text, p_category text, p_stage_code text, p_description text)
returns uuid language plpgsql as $$
declare v_id uuid; v_stage uuid;
begin
  select id into v_stage from ontology.supply_chain_stages where code = p_stage_code;
  select id into v_id from ontology.materials where code = p_code;
  if v_id is not null then
    update ontology.materials
       set name = p_name, category = p_category, stage_id = v_stage, description = p_description
     where id = v_id;
    return v_id;
  end if;
  v_id := core.new_entity('material');
  insert into ontology.materials (id, code, name, category, stage_id, description)
  values (v_id, p_code, p_name, p_category, v_stage, p_description);
  return v_id;
end $$;

create or replace function pg_temp.seed_commodity(
  p_code text, p_name text, p_category text, p_description text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from ontology.commodities where code = p_code;
  if v_id is not null then return v_id; end if;
  v_id := core.new_entity('commodity');
  insert into ontology.commodities (id, code, name, category, description)
  values (v_id, p_code, p_name, p_category, p_description);
  return v_id;
end $$;

create or replace function pg_temp.seed_end_market(p_code text, p_name text)
returns uuid language plpgsql as $$
declare v_id uuid;
begin
  select id into v_id from ontology.end_markets where code = p_code;
  if v_id is not null then return v_id; end if;
  v_id := core.new_entity('end_market');
  insert into ontology.end_markets (id, code, name) values (v_id, p_code, p_name);
  return v_id;
end $$;

-- A relationship with no source document is structural: it is part of the
-- definition of the chain rather than a finding about the world. Relationships
-- a module asserts arrive with `source_document_version_id` set and a
-- confidence below 1.
create or replace function pg_temp.link(p_from uuid, p_type text, p_to uuid)
returns void language sql as $$
  insert into ontology.entity_relationships
    (from_entity_id, relationship_type, to_entity_id, confidence)
  values (p_from, p_type, p_to, 1.0)
  on conflict do nothing;
$$;

-- Stages, in the order the brief lists them.
select pg_temp.seed_stage('mining',        'Mining',        1);
select pg_temp.seed_stage('concentration', 'Concentration', 2);
select pg_temp.seed_stage('separation',    'Separation',    3);
select pg_temp.seed_stage('refining',      'Refining',      4);
select pg_temp.seed_stage('metal',         'Metal',         5);
select pg_temp.seed_stage('alloy',         'Alloy',         6);
select pg_temp.seed_stage('magnet',        'Magnet',        7);
select pg_temp.seed_stage('motor',         'Motor',         8);
select pg_temp.seed_stage('recycling',     'Recycling',     9);

-- The four rare earth elements a magnet chain turns on, plus the two light
-- elements that dominate what comes out of the ground with them.
select pg_temp.seed_element('Nd', 'Neodymium');
select pg_temp.seed_element('Pr', 'Praseodymium');
select pg_temp.seed_element('Dy', 'Dysprosium');
select pg_temp.seed_element('Tb', 'Terbium');
select pg_temp.seed_element('La', 'Lanthanum');
select pg_temp.seed_element('Ce', 'Cerium');
select pg_temp.seed_element('Fe', 'Iron');
select pg_temp.seed_element('B',  'Boron');

-- One material per stage: the NdPr chain as a line, which is the thing a
-- bottleneck is measured along.
select pg_temp.seed_material('rare_earth_ore', 'Rare earth ore', 'ore', 'mining',
  'Run-of-mine bastnaesite or monazite ore, before any upgrading.');
select pg_temp.seed_material('rare_earth_concentrate', 'Rare earth concentrate', 'concentrate', 'concentration',
  'Upgraded mineral concentrate, typically reported as contained rare earth oxide.');
select pg_temp.seed_material('ndpr_oxide', 'NdPr oxide', 'oxide', 'separation',
  'Separated neodymium-praseodymium oxide, the product a separation plant sells.');
select pg_temp.seed_material('dysprosium_oxide', 'Dysprosium oxide', 'oxide', 'separation',
  'Separated heavy rare earth oxide used to hold magnet coercivity at temperature.');
select pg_temp.seed_material('ndpr_metal', 'NdPr metal', 'metal', 'metal',
  'Reduced neodymium-praseodymium metal, the input to alloy making.');
select pg_temp.seed_material('ndfeb_alloy', 'NdFeB alloy', 'alloy', 'alloy',
  'Neodymium-iron-boron alloy, usually strip cast.');
select pg_temp.seed_material('ndfeb_magnet', 'NdFeB magnet', 'component', 'magnet',
  'Sintered or bonded permanent magnet.');
select pg_temp.seed_material('traction_motor', 'Traction motor', 'assembly', 'motor',
  'Permanent magnet motor, the assembly a magnet is consumed in.');
select pg_temp.seed_material('magnet_scrap', 'Magnet scrap', 'scrap', 'recycling',
  'End-of-life and swarf magnet material returning to the chain.');

-- Which elements each material carries. This is what lets a question about
-- neodymium reach every stage that handles it.
insert into ontology.material_elements (material_id, element_id)
select m.id, e.id
  from (values
    ('rare_earth_ore',         array['Nd','Pr','La','Ce']),
    ('rare_earth_concentrate', array['Nd','Pr','La','Ce']),
    ('ndpr_oxide',             array['Nd','Pr']),
    ('dysprosium_oxide',       array['Dy']),
    ('ndpr_metal',             array['Nd','Pr']),
    ('ndfeb_alloy',            array['Nd','Pr','Fe','B']),
    ('ndfeb_magnet',           array['Nd','Pr','Dy','Tb','Fe','B']),
    ('traction_motor',         array['Nd','Pr','Dy','Tb']),
    ('magnet_scrap',           array['Nd','Pr','Dy','Tb'])
  ) as v(code, symbols)
  join ontology.materials m on m.code = v.code
  join ontology.elements e on e.symbol = any (v.symbols)
on conflict do nothing;

-- The flow. SUPPLIES points downstream: ore supplies concentrate, concentrate
-- supplies oxide, and so on. Reading the chain is following these edges;
-- reading it backwards is asking what a stage depends on.
select pg_temp.link(up.id, 'SUPPLIES', down.id)
  from (values
    ('rare_earth_ore',         'rare_earth_concentrate'),
    ('rare_earth_concentrate', 'ndpr_oxide'),
    ('rare_earth_concentrate', 'dysprosium_oxide'),
    ('ndpr_oxide',             'ndpr_metal'),
    ('ndpr_metal',             'ndfeb_alloy'),
    ('dysprosium_oxide',       'ndfeb_magnet'),
    ('ndfeb_alloy',            'ndfeb_magnet'),
    ('ndfeb_magnet',           'traction_motor'),
    ('traction_motor',         'magnet_scrap'),
    ('magnet_scrap',           'ndpr_metal')
  ) as v(from_code, to_code)
  join ontology.materials up on up.code = v.from_code
  join ontology.materials down on down.code = v.to_code;

-- Traded products. A commodity is a thing with a price; a material is a
-- position in the chain, and the two are not the same object even when they
-- share a name. They are matched by code rather than by an edge: none of the
-- twelve relationship types means "is the traded form of", and inventing an
-- edge that means something else would be worse than joining on the code.
select pg_temp.seed_commodity('ndpr_oxide', 'NdPr oxide', 'rare_earth',
  'Neodymium-praseodymium oxide, priced per tonne.');
select pg_temp.seed_commodity('dysprosium_oxide', 'Dysprosium oxide', 'rare_earth',
  'Dysprosium oxide, priced per kilogram.');

-- Where the chain ends.
select pg_temp.seed_end_market('ev', 'Electric vehicles');
select pg_temp.seed_end_market('wind', 'Wind turbines');
select pg_temp.seed_end_market('robotics', 'Robotics and automation');
select pg_temp.seed_end_market('defense', 'Defense');
select pg_temp.seed_end_market('consumer_electronics', 'Consumer electronics');

select pg_temp.link(m.id, 'SUPPLIES', em.id)
  from ontology.materials m
  cross join ontology.end_markets em
 where m.code = 'traction_motor'
   and em.code in ('ev', 'wind', 'robotics', 'defense', 'consumer_electronics');

commit;
