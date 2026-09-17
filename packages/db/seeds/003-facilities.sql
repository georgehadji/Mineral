-- Seed: the facilities that put a company at a stage.
--
-- ontology.facilities is how this schema joins a company to the chain, and it
-- is deliberately not an OPERATES edge. Seed 002 draws the line: stages,
-- materials and the flow between them are definitions and may be asserted
-- structurally; who does what is a finding and may not. A company occupying a
-- stage is a finding. A facility is that finding in its smallest honest form,
-- a named site in a country at one stage with a status, and unlike
-- ontology.entity_relationships this table carries no confidence and no
-- source document column, so the citation lives in the comment above each row.
--
-- Every row is a phrase from one annual report on file with the SEC, read
-- 2026-09-17. One row per (site, stage) the filing describes separately: a
-- site that mines and also separates is two positions in the chain, and
-- collapsing them loses the only thing the chain is for.
--
-- This is three companies, not the nineteen in seed 001. The others are
-- absent rather than guessed. Turning filing prose into a stage and a status
-- is extraction, and `supply_chain_position` in packages/research already
-- does extraction with a citation behind every claim; typing the answers in
-- here by hand would be asserting findings this file cannot source. A company
-- with no facility below is a gap, and a gap is rendered as a gap.
--
-- Runs after 001 (companies, and the GB country row Cheshire needs) and 002
-- (stages and materials). Idempotent: keyed on (company, facility name).

\set ON_ERROR_STOP on

begin;

-- Resolves the company by legal name and the stage, material and country by
-- their natural keys, so a row reads the way the filing reads rather than as
-- a list of uuids. A null material is not a hole in the record: it is a site
-- whose output this ontology does not model, and Elk Creek's niobium is that.
create function pg_temp.seed_facility(
  p_company_legal_name text,
  p_name text,
  p_type text,
  p_stage_code text,
  p_material_code text,
  p_country char(2),
  p_status text
) returns uuid language plpgsql as $$
declare
  v_company uuid;
  v_stage uuid;
  v_material uuid;
  v_id uuid;
begin
  select id into v_company from core.companies where legal_name = p_company_legal_name;
  if v_company is null then
    raise exception 'no company with legal_name %; seed 001 has to run first', p_company_legal_name;
  end if;

  select id into v_stage from ontology.supply_chain_stages where code = p_stage_code;
  if v_stage is null then
    raise exception 'no stage with code %; seed 002 has to run first', p_stage_code;
  end if;

  if p_material_code is not null then
    select id into v_material from ontology.materials where code = p_material_code;
    if v_material is null then
      raise exception 'no material with code %', p_material_code;
    end if;
  end if;

  select id into v_id from ontology.facilities
   where company_id = v_company and name = p_name;

  if v_id is null then
    v_id := core.new_entity('facility');
    insert into ontology.facilities
      (id, company_id, name, facility_type, stage_id, primary_material_id, country_code, status)
    values
      (v_id, v_company, p_name, p_type, v_stage, v_material, p_country, p_status);
  else
    update ontology.facilities
       set facility_type = p_type, stage_id = v_stage, primary_material_id = v_material,
           country_code = p_country, status = p_status
     where id = v_id;
  end if;

  return v_id;
end $$;

-- MP Materials, Form 10-K filed 2026-02-26, Item 2 Properties. One site in
-- San Bernardino County, California that the filing itemises as "an open-pit
-- mine in the production stage", "a crusher, a mill/flotation plant", and
-- "hydrometallurgy facilities, separation plants" which "separate rare earth
-- concentrate into other products, including NdPr oxide". Three stages named,
-- so three rows.
select pg_temp.seed_facility(
  'MP Materials Corp. / DE', 'Mountain Pass open-pit mine',
  'open-pit mine', 'mining', 'rare_earth_ore', 'US', 'operating');

select pg_temp.seed_facility(
  'MP Materials Corp. / DE', 'Mountain Pass mill and flotation plant',
  'mill and flotation plant', 'concentration', 'rare_earth_concentrate', 'US', 'operating');

select pg_temp.seed_facility(
  'MP Materials Corp. / DE', 'Mountain Pass separation plants',
  'separation plant', 'separation', 'ndpr_oxide', 'US', 'operating');

-- Same filing: the Independence Facility at Fort Worth, Texas "converts NdPr
-- oxide produced at Mountain Pass into permanent magnets", and "production
-- begins with the reduction of NdPr oxide through electrowinning, producing
-- NdPr metal for downstream alloying". Two stages in two sentences about one
-- building, which is why the chain needs the pair and not the address.
select pg_temp.seed_facility(
  'MP Materials Corp. / DE', 'Independence Facility metal plant',
  'electrowinning and metal plant', 'metal', 'ndpr_metal', 'US', 'operating');

select pg_temp.seed_facility(
  'MP Materials Corp. / DE', 'Independence Facility magnet plant',
  'permanent magnet plant', 'magnet', 'ndfeb_magnet', 'US', 'operating');

-- USA Rare Earth, Form 10-K filed 2026-03-30, Item 2 Properties, a table of
-- five sites. Two name a stage outright. That table has no status column, so
-- the status here is unknown rather than inferred from acreage or ownership.
-- Stillwater appears in it as "Headquarters, testing labs and manufacturing"
-- and is deliberately absent below: manufacturing of what is not on that
-- line, and the obvious guess is still a guess.
select pg_temp.seed_facility(
  'USA Rare Earth, Inc.', 'Round Top mine',
  'mine', 'mining', 'rare_earth_ore', 'US', 'unknown');

select pg_temp.seed_facility(
  'USA Rare Earth, Inc.', 'Cheshire metal plant',
  'metal manufacturing', 'metal', null, 'GB', 'unknown');

-- NioCorp, Form 10-K filed 2025-09-11, Item 2 Properties: "Our principal
-- mineral property is the Elk Creek Property, a niobium, scandium and titanium
-- development stage property", feasibility study complete, and "The Company
-- does not have any other material properties". Niobium is not a material in
-- seed 002, so the material is null and the stage still holds.
select pg_temp.seed_facility(
  'NIOCORP DEVELOPMENTS LTD', 'Elk Creek Project',
  'niobium, scandium and titanium mine', 'mining', null, 'US', 'planned');

commit;
