-- migrate:up

-- Facilities are about to stop being hand-written.
--
-- Seed 003 put eight sites in ontology.facilities and had nowhere to record
-- where each came from, so the citation sits in a SQL comment. That was
-- tolerable while a human typed every row out of a filing. It stops being
-- tolerable the moment a module proposes one, because then the table holds
-- findings whose only provenance is that something wrote them.
--
-- source_claim_id is that provenance. It is nullable on purpose: null means
-- the row was seeded and its citation is in the seed file, not-null means a
-- claim stands behind it and the claim carries its own evidence, its own
-- epistemic status and its own verification history. A promoted facility can
-- therefore be walked back to the quote that produced it, and a facility whose
-- claim is later demoted to CONTRADICTED is findable instead of silent.
--
-- The unique key is the other half. Promotion has to be re-runnable over the
-- same run without producing a second Mountain Pass.
--
-- The key includes the stage, and that is not padding. A row here is a (site,
-- stage) pair rather than a site: Mountain Pass mines and also separates, and
-- seed 003 already writes it twice for that reason. Keying on (company, name)
-- alone would make the second of those two an overwrite of the first, which is
-- the one thing this table exists to keep apart. `nulls not distinct` because
-- company_id and stage_id are both nullable and two unowned unstaged sites
-- sharing a name are one row, not two -- the same choice
-- ontology.entity_relationships already makes for its own natural key.

alter table ontology.facilities
  add column source_claim_id uuid references research.claims(id);

alter table ontology.facilities
  add constraint facilities_company_name_stage_key
  unique nulls not distinct (company_id, name, stage_id);

-- migrate:down

alter table ontology.facilities
  drop constraint facilities_company_name_stage_key;

alter table ontology.facilities
  drop column source_claim_id;
