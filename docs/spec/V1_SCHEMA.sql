-- Trading Research Platform — PostgreSQL V1 schema
-- Design goals: provenance, temporal versioning, deterministic calculations,
-- structured research, thesis traceability, and clean-room domain ownership.

create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists core;
create schema if not exists market;
create schema if not exists research;
create schema if not exists ontology;
create schema if not exists valuation;
create schema if not exists portfolio;
create schema if not exists monitoring;

-- ============================================================
-- USERS
-- ============================================================
create table core.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================
-- ISSUERS / SECURITIES / LISTINGS
-- ============================================================
create table core.companies (
  id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  common_name text,
  country_code char(2),
  description text,
  website text,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table core.company_aliases (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  alias text not null,
  alias_type text not null,
  unique(company_id, alias)
);

create table core.exchanges (
  id uuid primary key default gen_random_uuid(),
  mic text unique,
  name text not null,
  country_code char(2)
);

create table core.securities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references core.companies(id),
  security_type text not null,
  isin text unique,
  cusip text,
  sedol text,
  currency char(3),
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table core.listings (
  id uuid primary key default gen_random_uuid(),
  security_id uuid not null references core.securities(id),
  exchange_id uuid references core.exchanges(id),
  ticker text not null,
  currency char(3),
  valid_from date,
  valid_to date,
  unique(exchange_id, ticker, valid_from)
);

create index idx_listings_ticker on core.listings(ticker);
create index idx_securities_company on core.securities(company_id);

-- ============================================================
-- SOURCES / DOCUMENTS / DOCUMENT VERSIONS
-- ============================================================
create table research.sources (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_type text not null,
  source_tier smallint not null check (source_tier between 1 and 5),
  publisher text,
  base_url text,
  created_at timestamptz not null default now()
);

create table research.documents (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references research.sources(id),
  canonical_url text,
  external_id text,
  document_type text not null,
  title text not null,
  publisher text,
  published_at timestamptz,
  language_code text,
  created_at timestamptz not null default now(),
  unique(source_id, external_id)
);

create table research.document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references research.documents(id),
  version_no integer not null,
  content_hash text not null,
  storage_uri text,
  raw_text text,
  captured_at timestamptz not null default now(),
  unique(document_id, version_no),
  unique(document_id, content_hash)
);

create table research.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references research.document_versions(id),
  chunk_index integer not null,
  text_content text not null,
  page_no integer,
  section_path text,
  token_count integer,
  embedding vector(1536),
  unique(document_version_id, chunk_index)
);

create index idx_document_chunks_document on research.document_chunks(document_version_id);

-- ============================================================
-- CANONICAL FACTS
-- ============================================================
create table research.fact_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  value_type text not null,
  unit text,
  description text,
  created_at timestamptz not null default now()
);

create table research.facts (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  fact_definition_id uuid not null references research.fact_definitions(id),
  current_version_id uuid,
  created_at timestamptz not null default now(),
  unique(entity_type, entity_id, fact_definition_id)
);

create table research.fact_versions (
  id uuid primary key default gen_random_uuid(),
  fact_id uuid not null references research.facts(id),
  version_no integer not null,
  numeric_value numeric(38, 12),
  text_value text,
  boolean_value boolean,
  date_value date,
  json_value jsonb,
  unit text,
  currency char(3),
  period_start date,
  period_end date,
  as_of_date date,
  observed_at timestamptz,
  valid_from timestamptz,
  valid_to timestamptz,
  source_document_version_id uuid references research.document_versions(id),
  extraction_method text not null,
  extraction_confidence numeric(5,4),
  created_at timestamptz not null default now(),
  unique(fact_id, version_no),
  check (
    ((numeric_value is not null)::int +
     (text_value is not null)::int +
     (boolean_value is not null)::int +
     (date_value is not null)::int +
     (json_value is not null)::int) = 1
  )
);

alter table research.facts
  add constraint fk_facts_current_version
  foreign key(current_version_id) references research.fact_versions(id);

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
  unique(listing_id, observed_at, provider)
);

create index idx_market_obs_listing_time
  on market.market_observations(listing_id, observed_at desc);

-- ============================================================
-- ONTOLOGY
-- ============================================================
create table ontology.commodities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text,
  description text
);

create table ontology.materials (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  category text,
  description text
);

create table ontology.themes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  parent_theme_id uuid references ontology.themes(id)
);

create table ontology.facilities (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies(id),
  name text not null,
  facility_type text,
  country_code char(2),
  latitude numeric(9,6),
  longitude numeric(9,6),
  status text
);

create table ontology.projects (
  id uuid primary key default gen_random_uuid(),
  company_id uuid references core.companies(id),
  name text not null,
  project_type text,
  country_code char(2),
  status text,
  expected_start date,
  expected_production_date date
);

create table ontology.company_relationships (
  id uuid primary key default gen_random_uuid(),
  from_entity_type text not null,
  from_entity_id uuid not null,
  relationship_type text not null,
  to_entity_type text not null,
  to_entity_id uuid not null,
  valid_from date,
  valid_to date,
  confidence numeric(5,4),
  source_document_version_id uuid references research.document_versions(id),
  unique(from_entity_type, from_entity_id, relationship_type, to_entity_type, to_entity_id, valid_from)
);

create index idx_relationships_from
  on ontology.company_relationships(from_entity_type, from_entity_id);
create index idx_relationships_to
  on ontology.company_relationships(to_entity_type, to_entity_id);

-- ============================================================
-- RESEARCH RUNS / MODULES
-- ============================================================
create table research.module_definitions (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version text not null,
  category text not null,
  description text,
  input_schema jsonb not null,
  output_schema jsonb not null,
  policy jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  unique(code, version)
);

create table research.recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null,
  version text not null,
  description text,
  definition jsonb not null,
  active boolean not null default true,
  unique(code, version)
);

create table research.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references core.users(id),
  subject_type text not null,
  subject_id uuid not null,
  recipe_id uuid references research.recipes(id),
  status text not null default 'queued',
  depth_mode text not null default 'standard',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  input_snapshot jsonb not null default '{}'::jsonb,
  error jsonb
);

create table research.module_runs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references research.runs(id),
  module_definition_id uuid not null references research.module_definitions(id),
  status text not null default 'queued',
  attempt integer not null default 1,
  input_snapshot jsonb not null default '{}'::jsonb,
  output jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  error jsonb,
  unique(run_id, module_definition_id, attempt)
);

-- ============================================================
-- CLAIMS / EVIDENCE
-- ============================================================
create table research.claims (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references research.runs(id),
  subject_type text not null,
  subject_id uuid not null,
  claim_type text not null,
  statement text not null,
  epistemic_status text not null,
  confidence numeric(5,4),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now()
);

create table research.claim_evidence (
  id uuid primary key default gen_random_uuid(),
  claim_id uuid not null references research.claims(id),
  document_version_id uuid references research.document_versions(id),
  chunk_id uuid references research.document_chunks(id),
  fact_version_id uuid references research.fact_versions(id),
  evidence_role text not null,
  support_strength numeric(5,4),
  quote_excerpt text,
  created_at timestamptz not null default now(),
  check (document_version_id is not null or fact_version_id is not null)
);

create index idx_claims_subject on research.claims(subject_type, subject_id);
create index idx_claim_evidence_claim on research.claim_evidence(claim_id);

-- ============================================================
-- ASSUMPTIONS / SCENARIOS
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
  unique(subject_type, subject_id, code)
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
  status text not null default 'proposed',
  valid_from date,
  valid_to date,
  created_at timestamptz not null default now(),
  unique(assumption_id, version_no)
);

create table valuation.scenarios (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  name text not null,
  description text,
  created_at timestamptz not null default now()
);

create table valuation.scenario_assumptions (
  scenario_id uuid not null references valuation.scenarios(id),
  assumption_version_id uuid not null references valuation.assumption_versions(id),
  primary key(scenario_id, assumption_version_id)
);

create table valuation.valuation_runs (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  scenario_id uuid references valuation.scenarios(id),
  method text not null,
  engine_version text not null,
  input_snapshot jsonb not null,
  output jsonb not null,
  calculated_at timestamptz not null default now()
);

-- ============================================================
-- THESIS
-- ============================================================
create table research.thesis_versions (
  id uuid primary key default gen_random_uuid(),
  subject_type text not null,
  subject_id uuid not null,
  version_no integer not null,
  verdict text not null,
  summary text not null,
  confidence numeric(5,4),
  research_run_id uuid references research.runs(id),
  created_at timestamptz not null default now(),
  unique(subject_type, subject_id, version_no)
);

create table research.thesis_nodes (
  id uuid primary key default gen_random_uuid(),
  thesis_version_id uuid not null references research.thesis_versions(id),
  node_type text not null,
  statement text not null,
  claim_id uuid references research.claims(id),
  assumption_version_id uuid references valuation.assumption_versions(id),
  confidence numeric(5,4)
);

create table research.thesis_edges (
  id uuid primary key default gen_random_uuid(),
  from_node_id uuid not null references research.thesis_nodes(id),
  edge_type text not null,
  to_node_id uuid not null references research.thesis_nodes(id),
  unique(from_node_id, edge_type, to_node_id)
);

create index idx_thesis_versions_subject
  on research.thesis_versions(subject_type, subject_id, version_no desc);

-- ============================================================
-- VERIFICATION
-- ============================================================
create table research.verification_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid references research.runs(id),
  target_type text not null,
  target_id uuid not null,
  overall_status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  summary jsonb not null default '{}'::jsonb
);

create table research.verification_checks (
  id uuid primary key default gen_random_uuid(),
  verification_run_id uuid not null references research.verification_runs(id),
  check_type text not null,
  status text not null,
  severity text not null,
  message text,
  evidence jsonb not null default '{}'::jsonb
);

-- ============================================================
-- PORTFOLIO / WATCHLIST
-- ============================================================
create table portfolio.watchlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references core.users(id),
  name text not null,
  created_at timestamptz not null default now()
);

create table portfolio.watchlist_items (
  id uuid primary key default gen_random_uuid(),
  watchlist_id uuid not null references portfolio.watchlists(id),
  entity_type text not null,
  entity_id uuid not null,
  added_at timestamptz not null default now(),
  unique(watchlist_id, entity_type, entity_id)
);

create table portfolio.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references core.users(id),
  name text not null,
  base_currency char(3) not null,
  created_at timestamptz not null default now()
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

-- ============================================================
-- MONITORING / ALERTS
-- ============================================================
create table monitoring.alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references core.users(id),
  entity_type text not null,
  entity_id uuid not null,
  rule_type text not null,
  rule_config jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create table monitoring.alert_events (
  id uuid primary key default gen_random_uuid(),
  alert_rule_id uuid not null references monitoring.alert_rules(id),
  event_type text not null,
  severity text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- MODEL / PROMPT / EVALUATION TRACEABILITY
-- ============================================================
create table research.prompt_versions (
  id uuid primary key default gen_random_uuid(),
  module_definition_id uuid references research.module_definitions(id),
  version text not null,
  system_prompt text not null,
  user_prompt_template text,
  response_schema jsonb not null,
  created_at timestamptz not null default now(),
  unique(module_definition_id, version)
);

create table research.model_runs (
  id uuid primary key default gen_random_uuid(),
  research_run_id uuid references research.runs(id),
  module_run_id uuid references research.module_runs(id),
  provider text not null,
  model text not null,
  prompt_version_id uuid references research.prompt_versions(id),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  cost_usd numeric(18,8),
  request_payload_hash text,
  response_hash text,
  created_at timestamptz not null default now()
);

create table research.evaluation_runs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,
  model_run_id uuid references research.model_runs(id),
  dataset_version text,
  score numeric(8,5),
  metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
