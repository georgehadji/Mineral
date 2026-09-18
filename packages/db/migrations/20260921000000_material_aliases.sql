-- migrate:up

-- A synonym is not an unknown material.
--
-- The deep run on Ramaco proposed Brook Mine six times. Three modules named
-- what the mine produces -- "rare_earth_elements" -- and all three were
-- refused, because ontology.materials spells that code "rare_earth_ore". The
-- three modules that said nothing about the material were approved. The row
-- landed with its material column empty: the gate refused the modules that
-- knew and accepted the ones that were silent.
--
-- That is the failure facilities had under (company, name, stage), one level
-- down. Companies resolve their other names through core.company_aliases and
-- facilities through site_key; materials had nothing, so every word a filing
-- uses for a thing already in the ontology read as a thing outside it.
--
-- This table is a controlled vocabulary, not evidence. A row here says two
-- spellings mean one material, which is a fact about the ontology and not
-- about any company, so there is no source_claim_id -- unlike
-- ontology.facility_aliases, where the alias is something a filing actually
-- said about a site.

create table ontology.material_aliases (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references ontology.materials(id) on delete cascade,
  alias text not null
);

-- Unique, not merely indexed, which is where this differs from
-- core.company_aliases: two companies can share a short name and still be told
-- apart by ticker or CIK, but an alias resolving to two materials has no
-- tiebreak and would route half a supply chain to the wrong place.
create unique index idx_material_aliases_alias on ontology.material_aliases(lower(alias));

-- migrate:down
drop table if exists ontology.material_aliases;
