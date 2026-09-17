-- migrate:up

-- One mine, named three ways.
--
-- The promotion path works, and the first real run showed what it produces:
-- fifteen modules read the same 10-K and wrote "Berwind Complex", "Berwind
-- mining complex", "Elk Creek Complex" and "Elk Creek mining complex". The key
-- was (company, name, stage), so those are four rows for two mines. Every one
-- of those names is a phrase from the filing -- none is wrong -- but a table
-- that answers "who mines here" cannot count one site twice because two
-- modules quoted two sentences.
--
-- Companies solved this long ago: core.company_aliases holds the other names
-- and resolution folds them onto one id. Facilities get the same shape, with
-- the fold made a stored column so it can carry the unique constraint.
--
-- What site_key folds away is the descriptor tail: the run of generic words a
-- filing puts after the place. "Elk Creek mining complex" and "Elk Creek
-- Complex" are both "elk creek". Only the tail is folded, so "Mountain Pass
-- mill and flotation plant" keeps its middle and stays apart from "Mountain
-- Pass open-pit mine". Case and punctuation go too, and the stage stays in the
-- key, which is what keeps a mine and the prep plant beside it two rows.
--
-- The tail list is deliberately short and drawn from how filings actually
-- write: extending it merges more, and merging two real sites into one is a
-- worse failure than leaving a duplicate visible.

create function ontology.facility_site_key(site_name text) returns text
  language sql immutable strict parallel safe
as $$
  -- Non-alphanumerics become spaces (not nothing), so "open-pit" stays two
  -- words. [:alnum:] rather than [a-z0-9] because a site can be named in a
  -- script this repo already has issuers in.
  select coalesce(
    nullif(
      regexp_replace(
        trim(regexp_replace(lower(site_name), '[^[:alnum:]]+', ' ', 'g')),
        '( (complex|complexes|mine|mines|mining|project|projects|plant|plants|'
        || 'facility|facilities|operation|operations|site|sites|asset|assets|'
        || 'preparation|prep|processing|refinery|property|properties))+$',
        ''),
      ''),
    -- A name that is nothing but descriptors folds to empty. It keeps itself:
    -- an unusable key is worse than an unfolded one.
    lower(trim(site_name)));
$$;

alter table ontology.facilities
  add column site_key text generated always as (ontology.facility_site_key(name)) stored;

-- The names the fold drops. A filing said each of them, and the run that
-- proposed one can be walked back through source_claim_id exactly as the
-- surviving row can, so the merge costs a row and no evidence.
create table ontology.facility_aliases (
  id uuid primary key default gen_random_uuid(),
  facility_id uuid not null references ontology.facilities(id) on delete cascade,
  alias text not null,
  source_claim_id uuid references research.claims(id),
  unique (facility_id, alias)
);
create index idx_facility_aliases_alias on ontology.facility_aliases(lower(alias));

-- Fold what is already here, or the constraint below cannot be added.
-- Shortest name wins, which is the least decorated one: of "Berwind Complex"
-- and "Berwind mining complex" the table keeps the first. Ties break on the
-- name and then the id, so the choice is the same on every database.
create temporary table facility_merge as
  select id, name, source_claim_id, keep_id
    from (
      select f.id, f.name, f.source_claim_id,
             first_value(f.id) over (
               partition by f.company_id, f.site_key, f.stage_id
               order by length(f.name), f.name, f.id) as keep_id
        from ontology.facilities f
    ) ranked
   where id <> keep_id;

insert into ontology.facility_aliases (facility_id, alias, source_claim_id)
  select keep_id, name, source_claim_id from facility_merge
  on conflict (facility_id, alias) do nothing;

delete from ontology.facilities f using facility_merge m where f.id = m.id;
-- The entity id goes too. If something else points at it this fails, which is
-- the right outcome: a merge that silently drops a relationship is data loss.
delete from core.entities e using facility_merge m where e.id = m.id;

drop table facility_merge;

alter table ontology.facilities
  drop constraint facilities_company_name_stage_key;

alter table ontology.facilities
  add constraint facilities_company_site_stage_key
  unique nulls not distinct (company_id, site_key, stage_id);

-- migrate:down

-- Down restores the shape, not the rows: the duplicates this merged are gone
-- and their names are in facility_aliases, which goes with it.
alter table ontology.facilities
  drop constraint facilities_company_site_stage_key;

drop table ontology.facility_aliases;

alter table ontology.facilities
  drop column site_key;

drop function ontology.facility_site_key(text);

alter table ontology.facilities
  add constraint facilities_company_name_stage_key
  unique nulls not distinct (company_id, name, stage_id);
