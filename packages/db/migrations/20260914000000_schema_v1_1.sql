-- migrate:up
-- Mineral — PostgreSQL schema v1.1
--
-- Supersedes docs/spec/V1_SCHEMA.sql. Applies the fixes listed in
-- docs/architecture/00-architecture-understanding.md §I (numbers referenced
-- inline as I.n). Naming changes vs V1_SCHEMA.sql:
--   research.{sources,documents,document_versions,document_chunks,
--             fact_definitions,facts,fact_versions}      -> evidence.*   (I.15)
--   ontology.company_relationships                       -> ontology.entity_relationships
--   valuation.valuation_runs                             -> valuation.calculation_runs
--     (one table for every deterministic-engine invocation: ratios AND
--      valuations; lineage via valuation.calculation_run_inputs)      (I.4)
--   fact_versions.valid_from/valid_to                    -> effective_from/effective_to (I.7)
--
-- Time axes (see docs/domain/time.md):
--   documents.published_at          when the world was told
--   document_versions.captured_at   when we fetched this bytes-version
--   fact_versions.period_start/end  interval the value describes
--   fact_versions.as_of_date        point-in-time snapshot date
--   fact_versions.observed_at       when the value was extracted
--   fact_versions.effective_*       window in which this revision is the accepted one
--
-- pgvector deliberately absent (I.13): V1 retrieval uses tsvector.

create extension if not exists btree_gist;

create schema core;
create schema evidence;
create schema research;
create schema ontology;
create schema valuation;
create schema market;
create schema portfolio;
create schema monitoring;

-- ============================================================
-- SHARED HELPERS
-- ============================================================

-- Assigns version_no = max+1 for the parent, under a row lock on the parent
-- (I.8). Trigger args: (parent_column, parent_table).
create function core.assign_version_no() returns trigger
language plpgsql as $$
declare
  parent_col text := tg_argv[0];
  parent_tbl text := tg_argv[1];
  parent_id  uuid;
  next_no    integer;
begin
  parent_id := (to_jsonb(new) ->> parent_col)::uuid;
  execute format('select 1 from %s where id = $1 for update', parent_tbl) using parent_id;
  execute format(
    'select coalesce(max(version_no), 0) + 1 from %I.%I where %I = $1',
    tg_table_schema, tg_table_name, parent_col
  ) into next_no using parent_id;
  new.version_no := next_no;
  return new;
end $$;

-- ============================================================
-- CORE: ENTITY REGISTRY (I.3)
-- ============================================================
-- Every research subject / evidence target is an entity. Concrete tables
-- take their id from here and carry a (id, entity_type) composite FK so a
-- company id can never be mistaken for a project id.

create table core.entities (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in (
    'company','security','listing','commodity','material','element','theme',
    'project','facility','country','supply_chain_stage','end_market','portfolio'
  )),
  created_at timestamptz not null default now(),
  unique (id, entity_type)
);
create index idx_entities_type on core.entities(entity_type);

create function core.new_entity(p_type text) returns uuid
language sql as $$
  insert into core.entities(entity_type) values (p_type) returning id;
$$;

create table core.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- ONTOLOGY: reference entities needed before companies (I.16)
-- ============================================================

create table ontology.countries (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'country' check (entity_type = 'country'),
  iso2 char(2) not null unique,
  name text not null,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.supply_chain_stages (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'supply_chain_stage' check (entity_type = 'supply_chain_stage'),
  code text not null unique,
  name text not null,
  sequence_no integer not null,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.elements (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'element' check (entity_type = 'element'),
  symbol text not null unique,
  name text not null,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.commodities (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'commodity' check (entity_type = 'commodity'),
  code text not null unique,
  name text not null,
  category text,
  description text,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.materials (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'material' check (entity_type = 'material'),
  code text not null unique,
  name text not null,
  category text,
  stage_id uuid references ontology.supply_chain_stages(id),
  description text,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.material_elements (
  material_id uuid not null references ontology.materials(id),
  element_id uuid not null references ontology.elements(id),
  primary key (material_id, element_id)
);

create table ontology.themes (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'theme' check (entity_type = 'theme'),
  code text not null unique,
  name text not null,
  description text,
  parent_theme_id uuid references ontology.themes(id),
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table ontology.end_markets (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'end_market' check (entity_type = 'end_market'),
  code text not null unique,
  name text not null,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

-- ============================================================
-- CORE: ISSUERS / SECURITIES / LISTINGS
-- ============================================================

create table core.companies (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'company' check (entity_type = 'company'),
  legal_name text not null,
  common_name text,
  country_code char(2) references ontology.countries(iso2),
  description text,
  website text,
  status text not null default 'active' check (status in ('active','inactive','unknown')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

-- Deterministic entity resolution keys (H.3). Provider-neutral registries only.
create table core.company_identifiers (
  company_id uuid not null references core.companies(id),
  id_type text not null check (id_type in ('cik','lei','abn','acn','duns','tax_id')),
  value text not null,
  primary key (company_id, id_type),
  unique (id_type, value)
);

create table core.company_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  alias text not null,
  alias_type text not null check (alias_type in ('former_name','short_name','local_name','ticker_alias','other')),
  unique (company_id, alias)
);
create index idx_company_aliases_alias on core.company_aliases(lower(alias));

create table core.exchanges (
  id uuid primary key default gen_random_uuid(),
  mic text unique,
  name text not null,
  country_code char(2) references ontology.countries(iso2)
);

create table core.securities (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'security' check (entity_type = 'security'),
  company_id uuid not null references core.companies(id),
  security_type text not null check (security_type in ('common_stock','preferred_stock','adr','etf','bond','other')),
  isin text unique,
  cusip text,
  sedol text,
  currency char(3),
  status text not null default 'active' check (status in ('active','inactive','unknown')),
  created_at timestamptz not null default now(),
  foreign key (id, entity_type) references core.entities(id, entity_type)
);
create index idx_securities_company on core.securities(company_id);

create table core.listings (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'listing' check (entity_type = 'listing'),
  security_id uuid not null references core.securities(id),
  exchange_id uuid references core.exchanges(id),
  ticker text not null,
  currency char(3),
  valid_from date,
  valid_to date,
  check (valid_to is null or valid_from is null or valid_to > valid_from),
  foreign key (id, entity_type) references core.entities(id, entity_type),
  -- no two overlapping listings of the same ticker on one exchange (I.7)
  exclude using gist (
    exchange_id with =,
    ticker with =,
    daterange(valid_from, valid_to, '[)') with &&
  )
);
create index idx_listings_ticker on core.listings(ticker);
create index idx_listings_security on core.listings(security_id);

-- ============================================================
-- ONTOLOGY: company-owned entities
-- ============================================================

create table ontology.facilities (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'facility' check (entity_type = 'facility'),
  company_id uuid references core.companies(id),
  name text not null,
  facility_type text,
  stage_id uuid references ontology.supply_chain_stages(id),
  primary_material_id uuid references ontology.materials(id),
  country_code char(2) references ontology.countries(iso2),
  latitude numeric(9,6),
  longitude numeric(9,6),
  status text check (status in ('planned','construction','commissioning','operating','care_and_maintenance','closed','unknown')),
  foreign key (id, entity_type) references core.entities(id, entity_type)
);
create index idx_facilities_company on ontology.facilities(company_id);

create table ontology.projects (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'project' check (entity_type = 'project'),
  company_id uuid references core.companies(id),
  name text not null,
  project_type text,
  stage_id uuid references ontology.supply_chain_stages(id),
  country_code char(2) references ontology.countries(iso2),
  status text check (status in ('exploration','feasibility','permitting','financing','construction','production','suspended','cancelled','unknown')),
  expected_start date,
  expected_production_date date,
  foreign key (id, entity_type) references core.entities(id, entity_type)
);
create index idx_projects_company on ontology.projects(company_id);

-- ============================================================
-- EVIDENCE: SOURCES / DOCUMENTS / VERSIONS / CHUNKS
-- ============================================================

create table evidence.sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_type text not null,
  source_tier smallint not null check (source_tier between 1 and 5),
  publisher text,
  base_url text,
  created_at timestamptz not null default now()
);

create table evidence.documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references evidence.sources(id),
  canonical_url text,
  external_id text,
  document_type text not null,
  title text not null,
  publisher text,
  published_at timestamptz,
  language_code text,
  created_at timestamptz not null default now(),
  check (external_id is not null or canonical_url is not null),
  unique nulls not distinct (source_id, external_id)                           -- I.6
);
create unique index uq_documents_url_when_no_external
  on evidence.documents(source_id, canonical_url) where external_id is null;
create index idx_documents_source_published on evidence.documents(source_id, published_at desc);

-- Which entities a document is about (I.6).
create table evidence.document_subjects (
  document_id uuid not null references evidence.documents(id),
  entity_id uuid not null references core.entities(id),
  role text not null default 'subject' check (role in ('subject','issuer','mentioned','counterparty')),
  primary key (document_id, entity_id, role)
);
create index idx_document_subjects_entity on evidence.document_subjects(entity_id);

create table evidence.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references evidence.documents(id),
  version_no integer not null,
  content_hash text not null,
  storage_uri text,
  mime_type text,
  byte_size bigint,
  raw_text text,
  captured_at timestamptz not null default now(),
  unique (document_id, version_no),
  unique (document_id, content_hash)
);
create trigger trg_document_versions_version_no
  before insert on evidence.document_versions
  for each row execute function core.assign_version_no('document_id', 'evidence.documents');

create table evidence.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references evidence.document_versions(id),
  chunk_index integer not null,
  text_content text not null,
  page_no integer,
  section_path text,
  token_count integer,
  tsv tsvector generated always as (to_tsvector('english', text_content)) stored,
  unique (document_version_id, chunk_index),
  unique (id, document_version_id)          -- target for composite FK from claim_evidence
);
create index idx_document_chunks_version on evidence.document_chunks(document_version_id);
create index idx_document_chunks_tsv on evidence.document_chunks using gin(tsv);

-- ============================================================
-- EVIDENCE: CANONICAL FACTS (I.1, I.2, I.7, I.8)
-- ============================================================

create table evidence.fact_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  value_type text not null check (value_type in ('numeric','text','boolean','date','json')),
  canonical_unit text,
  description text,
  created_at timestamptz not null default now()
);

-- A fact is ONE observable (definition + entity + period/as-of + qualifiers).
-- Revisions of that observable live in fact_versions. (I.1)
create table evidence.facts (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  fact_definition_id uuid not null references evidence.fact_definitions(id),
  period_start date,
  period_end date,
  as_of_date date,
  qualifiers jsonb not null default '{}'::jsonb,     -- e.g. {"basis":"nameplate","product":"NdPr oxide","facility_id":"..."}
  qualifiers_hash text generated always as (md5(qualifiers::text)) stored,
  current_version_id uuid,
  created_at timestamptz not null default now(),
  foreign key (entity_id, entity_type) references core.entities(id, entity_type),
  check (period_end is null or period_start is null or period_end >= period_start),
  unique nulls not distinct (entity_id, fact_definition_id, period_start, period_end, as_of_date, qualifiers_hash)
);
create index idx_facts_entity on evidence.facts(entity_type, entity_id);
create index idx_facts_definition on evidence.facts(fact_definition_id);

create table evidence.fact_versions (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null references evidence.facts(id),
  version_no integer not null,
  status text not null default 'candidate' check (status in ('candidate','promoted','rejected','superseded')),
  numeric_value numeric(38,12),
  text_value text,
  boolean_value boolean,
  date_value date,
  json_value jsonb,
  unit text,
  currency char(3),
  observed_at timestamptz,
  effective_from timestamptz,
  effective_to timestamptz,
  source_document_version_id uuid references evidence.document_versions(id),
  source_chunk_id uuid references evidence.document_chunks(id),
  quote_excerpt text,
  extraction_method text not null check (extraction_method in ('xbrl','provider','manual','llm','calculated')),
  extraction_confidence numeric(5,4) check (extraction_confidence between 0 and 1),
  proposed_by_model_run_id uuid,                     -- FK added after research.model_runs
  promoted_by text check (promoted_by in ('validator','user','system')),
  promoted_at timestamptz,
  supersedes_version_id uuid references evidence.fact_versions(id),
  created_at timestamptz not null default now(),
  unique (fact_id, version_no),
  check (
    ((numeric_value is not null)::int +
     (text_value is not null)::int +
     (boolean_value is not null)::int +
     (date_value is not null)::int +
     (json_value is not null)::int) = 1
  ),
  -- invariant C.1: promoted => source-backed or deterministic derivation
  check (status <> 'promoted'
         or source_document_version_id is not null
         or extraction_method in ('calculated','provider')),
  -- LLM extraction must carry a locator + verbatim quote (rule proposal 14)
  check (extraction_method <> 'llm' or (source_chunk_id is not null and quote_excerpt is not null)),
  check (status <> 'promoted' or (promoted_by is not null and promoted_at is not null)),
  -- at most one accepted revision per instant (I.7)
  exclude using gist (
    fact_id with =,
    tstzrange(effective_from, effective_to, '[)') with &&
  ) where (status = 'promoted')
);
create index idx_fact_versions_fact on evidence.fact_versions(fact_id, version_no desc);
create index idx_fact_versions_source_doc on evidence.fact_versions(source_document_version_id);
create trigger trg_fact_versions_version_no
  before insert on evidence.fact_versions
  for each row execute function core.assign_version_no('fact_id', 'evidence.facts');

alter table evidence.facts
  add constraint fk_facts_current_version
  foreign key (current_version_id) references evidence.fact_versions(id);

-- current_version_id may only point at a promoted revision of this fact (I.2)
create function evidence.check_current_version() returns trigger
language plpgsql as $$
declare v_status text; v_fact uuid;
begin
  if new.current_version_id is null then return new; end if;
  select status, fact_id into v_status, v_fact from evidence.fact_versions where id = new.current_version_id;
  if v_fact is distinct from new.id then
    raise exception 'current_version_id % does not belong to fact %', new.current_version_id, new.id;
  end if;
  if v_status <> 'promoted' then
    raise exception 'current_version_id % has status %, must be promoted', new.current_version_id, v_status;
  end if;
  return new;
end $$;
create trigger trg_facts_current_version
  before insert or update of current_version_id on evidence.facts
  for each row execute function evidence.check_current_version();

-- The only sanctioned path from candidate to canonical (I.2, I.8).
create function evidence.promote_fact_version(
  p_version_id uuid,
  p_promoted_by text,
  p_effective_from timestamptz default now()
) returns void
language plpgsql as $$
declare v_fact uuid; v_prev uuid;
begin
  select fact_id into v_fact from evidence.fact_versions where id = p_version_id for update;
  if v_fact is null then raise exception 'fact_version % not found', p_version_id; end if;
  perform 1 from evidence.facts where id = v_fact for update;

  select current_version_id into v_prev from evidence.facts where id = v_fact;

  if v_prev is not null then
    update evidence.fact_versions
       set status = 'superseded',
           effective_to = coalesce(effective_to, p_effective_from)
     where id = v_prev;
  end if;

  update evidence.fact_versions
     set status = 'promoted',
         promoted_by = p_promoted_by,
         promoted_at = now(),
         effective_from = coalesce(effective_from, p_effective_from),
         supersedes_version_id = coalesce(supersedes_version_id, v_prev)
   where id = p_version_id;

  update evidence.facts set current_version_id = p_version_id where id = v_fact;
end $$;

-- ============================================================
-- ONTOLOGY: RELATIONSHIPS (needs document_versions)
-- ============================================================

create table ontology.entity_relationships (
  id uuid primary key default gen_random_uuid(),
  from_entity_id uuid not null references core.entities(id),
  relationship_type text not null check (relationship_type in (
    'OWNS','OPERATES','PRODUCES','PROCESSES','SUPPLIES','DEPENDS_ON',
    'LOCATED_IN','USES','COMPETES_WITH','SUBSTITUTES','CUSTOMER_OF','PART_OF'
  )),
  to_entity_id uuid not null references core.entities(id),
  valid_from date,
  valid_to date,
  confidence numeric(5,4) check (confidence between 0 and 1),
  source_document_version_id uuid references evidence.document_versions(id),
  created_at timestamptz not null default now(),
  check (from_entity_id <> to_entity_id),
  unique nulls not distinct (from_entity_id, relationship_type, to_entity_id, valid_from)
);
create index idx_relationships_from on ontology.entity_relationships(from_entity_id, relationship_type);
create index idx_relationships_to on ontology.entity_relationships(to_entity_id, relationship_type);

-- ============================================================
-- MARKET OBSERVATIONS
-- ============================================================

create table market.market_observations (
  id uuid primary key default gen_random_uuid(),
  listing_id uuid not null references core.listings(id),
  observed_at timestamptz not null,
  open numeric(38,12),
  high numeric(38,12),
  low numeric(38,12),
  close numeric(38,12),
  adjusted_close numeric(38,12),
  volume numeric(38,0),
  currency char(3),
  provider text not null,
  provider_observation_id text,
  unique (listing_id, observed_at, provider)
);
create index idx_market_obs_listing_time on market.market_observations(listing_id, observed_at desc);

-- ============================================================
-- RESEARCH: DEFINITIONS / SNAPSHOTS / RUNS
-- ============================================================

create table research.module_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version text not null,
  kind text not null check (kind in ('llm','deterministic','hybrid')),   -- I.20
  category text not null,
  requires text[] not null default '{}',                                  -- single source of DAG truth (I.18)
  description text,
  input_schema jsonb not null,
  output_schema jsonb not null,
  policy jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  unique (code, version)
);

create table research.recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version text not null,
  description text,
  definition jsonb not null,           -- {modules: [{code, version}]}; DAG derived from module requires
  active boolean not null default true,
  unique (code, version)
);

create table research.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  module_definition_id uuid not null references research.module_definitions(id),
  version text not null,
  system_prompt text not null,
  user_prompt_template text,
  response_schema jsonb not null,
  created_at timestamptz not null default now(),
  unique (module_definition_id, version)
);

-- Content-addressed, immutable input snapshot (I.14). manifest = ids only.
create table research.snapshots (
  id uuid primary key default gen_random_uuid(),
  content_hash text not null unique,
  storage_uri text,
  manifest jsonb not null,
  created_at timestamptz not null default now()
);

create table research.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references core.users(id),
  subject_type text not null,
  subject_id uuid not null,
  recipe_id uuid not null references research.recipes(id),
  parent_run_id uuid references research.runs(id),
  as_of_date date not null,
  depth_mode text not null default 'standard' check (depth_mode in ('quick','standard','deep')),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','cancelled')),
  snapshot_id uuid references research.snapshots(id),
  idempotency_key text not null unique,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb,
  foreign key (subject_id, subject_type) references core.entities(id, entity_type)
);
create index idx_runs_subject on research.runs(subject_id, requested_at desc);

create table research.module_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references research.runs(id),
  module_definition_id uuid not null references research.module_definitions(id),
  prompt_version_id uuid references research.prompt_versions(id),
  status text not null default 'queued' check (status in ('queued','running','completed','failed','skipped')),
  attempt integer not null default 1,
  context_manifest jsonb not null default '{}'::jsonb,   -- ids given to the module, not content
  output jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb,
  unique (run_id, module_definition_id, attempt)
);
create index idx_module_runs_run on research.module_runs(run_id);

create table research.model_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid references research.runs(id),
  module_run_id uuid references research.module_runs(id),
  provider text not null,
  model text not null,
  prompt_version_id uuid references research.prompt_versions(id),
  temperature numeric(4,3),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  cost_usd numeric(18,8),
  request_hash text,
  response_hash text,
  request_storage_uri text,
  response_storage_uri text,
  status text not null default 'completed' check (status in ('completed','failed','cached')),
  error jsonb,
  created_at timestamptz not null default now()
);
create index idx_model_runs_module_run on research.model_runs(module_run_id);
create index idx_model_runs_request_hash on research.model_runs(request_hash);

alter table evidence.fact_versions
  add constraint fk_fact_versions_model_run
  foreign key (proposed_by_model_run_id) references research.model_runs(id);

-- ============================================================
-- RESEARCH: CLAIMS / EVIDENCE (I.5, I.10)
-- ============================================================

create table research.claims (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references research.runs(id),
  module_run_id uuid references research.module_runs(id),
  subject_type text not null,
  subject_id uuid not null,
  claim_key text not null,                 -- stable semantic identity across runs
  claim_type text not null,
  statement text not null,
  epistemic_status text not null check (epistemic_status in (
    'VERIFIED','CALCULATED','DERIVED','INFERRED','HYPOTHESIS','UNKNOWN','CONTRADICTED','STALE'
  )),
  confidence numeric(5,4) check (confidence between 0 and 1),
  valid_from timestamptz,
  valid_to timestamptz,
  supersedes_claim_id uuid references research.claims(id),
  created_by text not null default 'llm' check (created_by in ('llm','user','system')),
  created_at timestamptz not null default now(),
  foreign key (subject_id, subject_type) references core.entities(id, entity_type),
  -- LLM-authored claims never enter as VERIFIED (invariant C.7)
  check (created_by <> 'llm' or epistemic_status <> 'VERIFIED')
);
create index idx_claims_subject_key on research.claims(subject_id, claim_key, created_at desc);
create index idx_claims_run on research.claims(run_id);
create index idx_claims_module_run on research.claims(module_run_id);

create table research.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references research.claims(id),
  document_version_id uuid references evidence.document_versions(id),
  chunk_id uuid references evidence.document_chunks(id),
  fact_version_id uuid references evidence.fact_versions(id),
  evidence_role text not null check (evidence_role in ('supports','contradicts','context')),
  support_strength numeric(5,4) check (support_strength between 0 and 1),
  quote_excerpt text,
  created_at timestamptz not null default now(),
  check (document_version_id is not null or fact_version_id is not null),
  check (chunk_id is null or document_version_id is not null),
  -- chunk must belong to the cited document version
  foreign key (chunk_id, document_version_id) references evidence.document_chunks(id, document_version_id)
);
create index idx_claim_evidence_claim on research.claim_evidence(claim_id);
create index idx_claim_evidence_fact_version on research.claim_evidence(fact_version_id);
create index idx_claim_evidence_document_version on research.claim_evidence(document_version_id);

-- Append-only status history; populated automatically on every status change.
create table research.claim_status_events (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,      -- strict order; now() is constant within a transaction
  claim_id uuid not null references research.claims(id),
  from_status text,
  to_status text not null,
  reason text,
  verification_check_id uuid,               -- FK added after verification_checks
  changed_by text not null default 'system' check (changed_by in ('verification','user','system')),
  created_at timestamptz not null default now()
);
create index idx_claim_status_events_claim on research.claim_status_events(claim_id, seq desc);

create function research.log_claim_status_change() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into research.claim_status_events(claim_id, from_status, to_status, changed_by)
    values (new.id, null, new.epistemic_status, 'system');
  elsif new.epistemic_status is distinct from old.epistemic_status then
    insert into research.claim_status_events(claim_id, from_status, to_status, changed_by)
    values (new.id, old.epistemic_status, new.epistemic_status, 'system');
  end if;
  return new;
end $$;
create trigger trg_claims_status_history
  after insert or update of epistemic_status on research.claims
  for each row execute function research.log_claim_status_change();

-- ============================================================
-- VALUATION: ASSUMPTIONS / SCENARIOS / CALCULATIONS (I.4, I.9)
-- ============================================================

create table valuation.assumptions (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  code text not null,
  name text not null,
  unit text,
  description text,
  created_at timestamptz not null default now(),
  foreign key (subject_id, subject_type) references core.entities(id, entity_type),
  unique (subject_id, code)
);

create table valuation.assumption_versions (
  id uuid primary key default gen_random_uuid(),
  assumption_id uuid not null references valuation.assumptions(id),
  version_no integer not null,
  value_numeric numeric(38,12),
  value_text text,
  min_value numeric(38,12),
  max_value numeric(38,12),
  source_claim_id uuid references research.claims(id),
  rationale text,
  status text not null default 'proposed' check (status in ('proposed','approved','rejected','superseded')),
  proposed_by text not null default 'llm' check (proposed_by in ('llm','user','system')),
  approved_by text check (approved_by in ('policy','user')),
  approved_at timestamptz,
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  unique (assumption_id, version_no),
  unique (id, assumption_id),
  check ((value_numeric is not null)::int + (value_text is not null)::int = 1),
  check (min_value is null or max_value is null or max_value >= min_value),
  check (status <> 'approved' or (approved_by is not null and approved_at is not null))
);
create trigger trg_assumption_versions_version_no
  before insert on valuation.assumption_versions
  for each row execute function core.assign_version_no('assumption_id', 'valuation.assumptions');

create table valuation.scenarios (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  foreign key (subject_id, subject_type) references core.entities(id, entity_type),
  unique (subject_id, name)
);

-- One version per assumption per scenario, and only approved versions (I.9, G).
create table valuation.scenario_assumptions (
  scenario_id uuid not null references valuation.scenarios(id),
  assumption_id uuid not null references valuation.assumptions(id),
  assumption_version_id uuid not null references valuation.assumption_versions(id),
  primary key (scenario_id, assumption_id),
  foreign key (assumption_version_id, assumption_id) references valuation.assumption_versions(id, assumption_id)
);

create function valuation.check_scenario_assumption_approved() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from valuation.assumption_versions where id = new.assumption_version_id;
  if v_status <> 'approved' then
    raise exception 'assumption_version % has status %, scenarios accept approved versions only',
      new.assumption_version_id, v_status;
  end if;
  return new;
end $$;
create trigger trg_scenario_assumptions_approved
  before insert or update on valuation.scenario_assumptions
  for each row execute function valuation.check_scenario_assumption_approved();

-- Every deterministic-engine invocation: ratios, DCF, multiples, scenarios.
create table valuation.calculation_runs (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  research_run_id uuid references research.runs(id),
  scenario_id uuid references valuation.scenarios(id),
  method text not null check (method in (
    'ratios','dcf','reverse_dcf','pe','ev_ebitda','ev_sales','fcf_yield','nav','sotp','scenario'
  )),
  engine text not null,
  engine_version text not null,
  status text not null default 'completed' check (status in ('completed','failed')),
  input_snapshot jsonb not null,
  output jsonb not null,
  error jsonb,
  calculated_at timestamptz not null default now(),
  foreign key (subject_id, subject_type) references core.entities(id, entity_type)
);
create index idx_calculation_runs_subject on valuation.calculation_runs(subject_id, calculated_at desc);
create index idx_calculation_runs_research_run on valuation.calculation_runs(research_run_id);

-- Queryable lineage: which fact/assumption versions fed a calculation (I.4).
create table valuation.calculation_run_inputs (
  calculation_run_id uuid not null references valuation.calculation_runs(id),
  fact_version_id uuid references evidence.fact_versions(id),
  assumption_version_id uuid references valuation.assumption_versions(id),
  role text,
  check ((fact_version_id is not null)::int + (assumption_version_id is not null)::int = 1),
  unique nulls not distinct (calculation_run_id, fact_version_id, assumption_version_id)
);
create index idx_calc_inputs_fact_version on valuation.calculation_run_inputs(fact_version_id);
create index idx_calc_inputs_assumption_version on valuation.calculation_run_inputs(assumption_version_id);

-- CALCULATED facts point back to the inputs they were derived from (I.4).
create table evidence.fact_derivations (
  derived_fact_version_id uuid not null references evidence.fact_versions(id),
  input_fact_version_id uuid not null references evidence.fact_versions(id),
  calculation_run_id uuid not null references valuation.calculation_runs(id),
  primary key (derived_fact_version_id, input_fact_version_id),
  check (derived_fact_version_id <> input_fact_version_id)
);
create index idx_fact_derivations_input on evidence.fact_derivations(input_fact_version_id);

-- ============================================================
-- RESEARCH: VERIFICATION (I.10)
-- ============================================================

create table research.verification_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid references research.runs(id),
  target_type text not null,
  target_id uuid not null,
  overall_status text not null check (overall_status in ('passed','warnings','failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);
create index idx_verification_runs_research_run on research.verification_runs(research_run_id);

create table research.verification_checks (
  id uuid primary key default gen_random_uuid(),
  verification_run_id uuid not null references research.verification_runs(id),
  check_type text not null check (check_type in (
    'quote_containment','number_vs_fact','unit_consistency','date_consistency',
    'source_tier','contradiction','schema','other'
  )),
  status text not null check (status in ('passed','failed','skipped')),
  severity text not null check (severity in ('info','warning','error','critical')),
  claim_id uuid references research.claims(id),
  fact_version_id uuid references evidence.fact_versions(id),
  message text,
  evidence jsonb not null default '{}'::jsonb
);
create index idx_verification_checks_run on research.verification_checks(verification_run_id);
create index idx_verification_checks_claim on research.verification_checks(claim_id);

alter table research.claim_status_events
  add constraint fk_claim_status_events_check
  foreign key (verification_check_id) references research.verification_checks(id);

-- ============================================================
-- RESEARCH: THESIS (rule 9)
-- ============================================================

create table research.thesis_versions (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  version_no integer not null,
  verdict text not null check (verdict in ('bullish','neutral','bearish','insufficient_evidence')),
  summary text not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  research_run_id uuid not null references research.runs(id),
  created_at timestamptz not null default now(),
  foreign key (subject_id, subject_type) references core.entities(id, entity_type),
  unique (subject_id, version_no)
);
create index idx_thesis_versions_subject on research.thesis_versions(subject_id, version_no desc);
-- version_no per subject; the entity row is the lock parent
create trigger trg_thesis_versions_version_no
  before insert on research.thesis_versions
  for each row execute function core.assign_version_no('subject_id', 'core.entities');

create table research.thesis_nodes (
  id uuid primary key default gen_random_uuid(),
  thesis_version_id uuid not null references research.thesis_versions(id),
  node_type text not null check (node_type in ('DRIVER','ASSUMPTION','RISK','CATALYST','CONCLUSION','UNKNOWN')),
  statement text not null,
  claim_id uuid references research.claims(id),
  assumption_version_id uuid references valuation.assumption_versions(id),
  calculation_run_id uuid references valuation.calculation_runs(id),
  confidence numeric(5,4) check (confidence between 0 and 1)
);
create index idx_thesis_nodes_version on research.thesis_nodes(thesis_version_id);
create index idx_thesis_nodes_claim on research.thesis_nodes(claim_id);
create index idx_thesis_nodes_assumption_version on research.thesis_nodes(assumption_version_id);

create table research.thesis_edges (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references research.thesis_nodes(id),
  edge_type text not null check (edge_type in ('SUPPORTS','CONTRADICTS','DEPENDS_ON','CAUSES','DERIVED_FROM','INVALIDATES')),
  to_node_id uuid not null references research.thesis_nodes(id),
  check (from_node_id <> to_node_id),
  unique (from_node_id, edge_type, to_node_id)
);

-- ============================================================
-- RESEARCH: EVALUATION
-- ============================================================

create table research.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  model_run_id uuid references research.model_runs(id),
  module_definition_id uuid references research.module_definitions(id),
  dataset_version text,
  score numeric(8,5),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- PORTFOLIO / WATCHLIST
-- ============================================================

create table portfolio.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references core.users(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (user_id, name)
);

create table portfolio.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references portfolio.watchlists(id),
  entity_id uuid not null references core.entities(id),
  added_at timestamptz not null default now(),
  unique (watchlist_id, entity_id)
);

create table portfolio.portfolios (
  id uuid primary key references core.entities(id),
  entity_type text not null default 'portfolio' check (entity_type = 'portfolio'),
  user_id uuid not null references core.users(id),
  name text not null,
  base_currency char(3) not null,
  created_at timestamptz not null default now(),
  foreign key (id, entity_type) references core.entities(id, entity_type)
);

create table portfolio.positions (
  id uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolio.portfolios(id),
  security_id uuid not null references core.securities(id),
  quantity numeric(38,12) not null,
  avg_cost numeric(38,12),
  cost_currency char(3),
  opened_at timestamptz,
  closed_at timestamptz
);
create index idx_positions_portfolio on portfolio.positions(portfolio_id);

-- ============================================================
-- MONITORING / ALERTS (brief §16, I.10)
-- ============================================================

create table monitoring.alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references core.users(id),
  entity_id uuid not null references core.entities(id),
  rule_type text not null check (rule_type in (
    'price_threshold','valuation_threshold','thesis_change','thesis_drift',
    'assumption_invalidated','contradictory_source','new_primary_source',
    'guidance_change','capacity_change','project_delay','commodity_change',
    'bottleneck_change','geopolitical_change'
  )),
  rule_config jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index idx_alert_rules_entity on monitoring.alert_rules(entity_id) where enabled;

create table monitoring.alert_events (
  id uuid primary key default gen_random_uuid(),
  alert_rule_id uuid not null references monitoring.alert_rules(id),
  event_type text not null,
  severity text not null check (severity in ('info','warning','critical')),
  trigger_ref_type text check (trigger_ref_type in ('claim','fact_version','document_version','calculation_run','thesis_version','market_observation')),
  trigger_ref_id uuid,
  dedupe_key text unique,
  payload jsonb not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now(),
  check ((trigger_ref_type is null) = (trigger_ref_id is null))
);
create index idx_alert_events_rule_time on monitoring.alert_events(alert_rule_id, created_at desc);

-- migrate:down
drop schema monitoring cascade;
drop schema portfolio cascade;
drop schema valuation cascade;
drop schema research cascade;
drop schema market cascade;
drop schema evidence cascade;
drop schema ontology cascade;
drop schema core cascade;
drop extension if exists btree_gist;
