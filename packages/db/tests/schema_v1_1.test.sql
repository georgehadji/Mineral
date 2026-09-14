-- Schema v1.1 invariant checks. Run after the migration:
--   psql -v ON_ERROR_STOP=1 -f packages/db/tests/schema_v1_1.test.sql
-- Every assertion runs inside one transaction that is rolled back at the end.
-- A failing assertion aborts with SQLSTATE T0001 and message "TEST FAIL: ...".

\set ON_ERROR_STOP on
begin;

create function pg_temp.expect_error(p_sql text, p_state text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception using errcode = 'T0001', message = format('TEST FAIL: expected %s from: %s', p_state, p_sql);
exception when others then
  if sqlstate = 'T0001' then raise; end if;
  if sqlstate <> p_state then
    raise exception using errcode = 'T0001',
      message = format('TEST FAIL: expected %s got %s (%s) from: %s', p_state, sqlstate, sqlerrm, p_sql);
  end if;
end $$;

create function pg_temp.assert(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
  if not p_ok then
    raise exception using errcode = 'T0001', message = 'TEST FAIL: ' || p_msg;
  end if;
end $$;

-- ------------------------------------------------------------
-- fixtures
-- ------------------------------------------------------------
create temp table f as
select
  core.new_entity('country')  as country_id,
  core.new_entity('company')  as company_id,
  core.new_entity('project')  as project_id;

insert into ontology.countries(id, iso2, name) select country_id, 'US', 'United States' from f;
insert into core.companies(id, legal_name, country_code) select company_id, 'Test Co', 'US' from f;
insert into ontology.projects(id, company_id, name) select project_id, company_id, 'Test Project' from f;

-- 1. entity registry: a project id cannot be used as a company id (I.3)
select pg_temp.expect_error(
  format('insert into core.companies(id, legal_name) values (%L, ''Bad'')', (select project_id from f)),
  '23503');

-- 2. version_no assigned by trigger under parent lock (I.8)
insert into evidence.sources(id, source_name, source_type, source_tier)
  values ('00000000-0000-0000-0000-000000000001', 'SEC EDGAR', 'regulator', 1);
insert into evidence.documents(id, source_id, external_id, document_type, title, published_at)
  values ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000001',
          '0001-23-000001', '10-K', 'Annual report', '2025-03-01');
insert into evidence.document_versions(id, document_id, version_no, content_hash)
  values ('00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000000010', 99, 'h1');
insert into evidence.document_versions(id, document_id, version_no, content_hash)
  values ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000010', 99, 'h2');
select pg_temp.assert(
  (select array_agg(version_no order by version_no) from evidence.document_versions) = '{1,2}',
  'document_versions.version_no should be {1,2} regardless of supplied value');

-- 3. documents: null external_id must not create duplicates (I.6)
insert into evidence.documents(source_id, canonical_url, document_type, title)
  values ('00000000-0000-0000-0000-000000000001', 'https://x/a', 'press_release', 'A');
select pg_temp.expect_error(
  'insert into evidence.documents(source_id, canonical_url, document_type, title)
   values (''00000000-0000-0000-0000-000000000001'', ''https://x/a'', ''press_release'', ''A again'')',
  '23505');

-- chunks
insert into evidence.document_chunks(id, document_version_id, chunk_index, text_content)
  values ('00000000-0000-0000-0000-000000001000', '00000000-0000-0000-0000-000000000100', 0,
          'Total revenue was $203.9 million for the year ended December 31, 2024.');
insert into evidence.document_chunks(id, document_version_id, chunk_index, text_content)
  values ('00000000-0000-0000-0000-000000001001', '00000000-0000-0000-0000-000000000101', 0,
          'Restated: total revenue was $204.1 million for the year ended December 31, 2024.');

-- 4. fact identity includes period + qualifiers (I.1)
insert into evidence.fact_definitions(id, code, name, value_type, canonical_unit)
  values ('00000000-0000-0000-0000-000000010000', 'revenue', 'Revenue', 'numeric', 'USD');
insert into evidence.facts(id, entity_type, entity_id, fact_definition_id, period_start, period_end)
  select '00000000-0000-0000-0000-000000020000', 'company', company_id,
         '00000000-0000-0000-0000-000000010000', '2024-01-01', '2024-12-31' from f;
insert into evidence.facts(id, entity_type, entity_id, fact_definition_id, period_start, period_end)
  select '00000000-0000-0000-0000-000000020001', 'company', company_id,
         '00000000-0000-0000-0000-000000010000', '2023-01-01', '2023-12-31' from f;
select pg_temp.expect_error(
  format('insert into evidence.facts(entity_type, entity_id, fact_definition_id, period_start, period_end)
          values (''company'', %L, ''00000000-0000-0000-0000-000000010000'', ''2024-01-01'', ''2024-12-31'')',
         (select company_id from f)),
  '23505');
-- same period, different qualifiers => distinct fact
insert into evidence.facts(entity_type, entity_id, fact_definition_id, period_start, period_end, qualifiers)
  select 'company', company_id, '00000000-0000-0000-0000-000000010000', '2024-01-01', '2024-12-31',
         '{"segment":"magnetics"}' from f;

-- 5. LLM extraction requires locator + verbatim quote (rule proposal 14)
select pg_temp.expect_error(
  'insert into evidence.fact_versions(fact_id, version_no, numeric_value, extraction_method, source_document_version_id)
   values (''00000000-0000-0000-0000-000000020000'', 0, 203900000, ''llm'', ''00000000-0000-0000-0000-000000000100'')',
  '23514');

-- candidate v1 (llm) and v2 (xbrl)
insert into evidence.fact_versions(id, fact_id, version_no, numeric_value, unit, currency, extraction_method,
                                   source_document_version_id, source_chunk_id, quote_excerpt, extraction_confidence)
  values ('00000000-0000-0000-0000-000000030000', '00000000-0000-0000-0000-000000020000', 0,
          203900000, 'USD', 'USD', 'llm',
          '00000000-0000-0000-0000-000000000100', '00000000-0000-0000-0000-000000001000',
          'Total revenue was $203.9 million', 0.9);
insert into evidence.fact_versions(id, fact_id, version_no, numeric_value, unit, currency, extraction_method,
                                   source_document_version_id, extraction_confidence)
  values ('00000000-0000-0000-0000-000000030001', '00000000-0000-0000-0000-000000020000', 0,
          204100000, 'USD', 'USD', 'xbrl', '00000000-0000-0000-0000-000000000101', 1);
select pg_temp.assert(
  (select array_agg(version_no order by version_no) from evidence.fact_versions
    where fact_id = '00000000-0000-0000-0000-000000020000') = '{1,2}',
  'fact_versions.version_no should be {1,2}');

-- 6. current_version_id cannot point at a candidate (I.2)
select pg_temp.expect_error(
  'update evidence.facts set current_version_id = ''00000000-0000-0000-0000-000000030000''
    where id = ''00000000-0000-0000-0000-000000020000''',
  'P0001');

-- 7. promoted requires promoted_by/promoted_at; direct status flip is rejected
select pg_temp.expect_error(
  'update evidence.fact_versions set status = ''promoted'' where id = ''00000000-0000-0000-0000-000000030000''',
  '23514');

-- 8. promotion function: v1 promoted, then v2 supersedes v1 and moves the pointer
select evidence.promote_fact_version('00000000-0000-0000-0000-000000030000', 'validator', '2025-03-01');
select pg_temp.assert(
  (select current_version_id from evidence.facts where id = '00000000-0000-0000-0000-000000020000')
    = '00000000-0000-0000-0000-000000030000',
  'current_version_id should be v1 after first promotion');

select evidence.promote_fact_version('00000000-0000-0000-0000-000000030001', 'validator', '2025-06-01');
select pg_temp.assert(
  (select status from evidence.fact_versions where id = '00000000-0000-0000-0000-000000030000') = 'superseded'
  and (select effective_to from evidence.fact_versions where id = '00000000-0000-0000-0000-000000030000') = '2025-06-01'::timestamptz
  and (select supersedes_version_id from evidence.fact_versions where id = '00000000-0000-0000-0000-000000030001')
        = '00000000-0000-0000-0000-000000030000'
  and (select current_version_id from evidence.facts where id = '00000000-0000-0000-0000-000000020000')
        = '00000000-0000-0000-0000-000000030001',
  'second promotion should supersede v1, close its window, link supersedes, move pointer');

-- 9. overlapping promoted windows rejected by exclusion constraint (I.7)
select pg_temp.expect_error(
  'update evidence.fact_versions set effective_to = null where id = ''00000000-0000-0000-0000-000000030000''
     and status = ''superseded''; ' ||
  'update evidence.fact_versions set status = ''promoted'', promoted_by = ''system'', promoted_at = now()
     where id = ''00000000-0000-0000-0000-000000030000''',
  '23P01');

-- 10. a promoted fact cannot be a source-less manual entry (C.1)
select pg_temp.expect_error(
  'insert into evidence.fact_versions(fact_id, version_no, numeric_value, extraction_method, status, promoted_by, promoted_at)
   values (''00000000-0000-0000-0000-000000020001'', 0, 1, ''manual'', ''promoted'', ''user'', now())',
  '23514');

-- ------------------------------------------------------------
-- research: runs, claims, evidence
-- ------------------------------------------------------------
insert into research.recipes(id, code, version, definition)
  values ('00000000-0000-0000-0000-000000040000', 'company-deep-research', '1.0.0', '{"modules":[]}');
insert into research.runs(id, subject_type, subject_id, recipe_id, as_of_date, idempotency_key)
  select '00000000-0000-0000-0000-000000050000', 'company', company_id,
         '00000000-0000-0000-0000-000000040000', '2025-09-14', 'run-1' from f;

-- 11. run subject type must match the registry (I.3)
select pg_temp.expect_error(
  format('insert into research.runs(subject_type, subject_id, recipe_id, as_of_date, idempotency_key)
          values (''project'', %L, ''00000000-0000-0000-0000-000000040000'', ''2025-09-14'', ''run-2'')',
         (select company_id from f)),
  '23503');

-- 12. LLM-authored claim cannot be VERIFIED (C.7)
select pg_temp.expect_error(
  format('insert into research.claims(run_id, subject_type, subject_id, claim_key, claim_type, statement, epistemic_status)
          values (''00000000-0000-0000-0000-000000050000'', ''company'', %L, ''rev.growth'', ''financial'', ''x'', ''VERIFIED'')',
         (select company_id from f)),
  '23514');

insert into research.claims(id, run_id, subject_type, subject_id, claim_key, claim_type, statement, epistemic_status, confidence)
  select '00000000-0000-0000-0000-000000060000', '00000000-0000-0000-0000-000000050000', 'company', company_id,
         'rev.growth', 'financial', 'Revenue is growing', 'DERIVED', 0.8 from f;

-- 13. claim status history written automatically (I.5)
update research.claims set epistemic_status = 'CONTRADICTED' where id = '00000000-0000-0000-0000-000000060000';
select pg_temp.assert(
  (select array_agg(to_status order by seq) from research.claim_status_events
    where claim_id = '00000000-0000-0000-0000-000000060000') = '{DERIVED,CONTRADICTED}',
  'claim_status_events should record insert + change');

-- 14. claim_evidence chunk must belong to the cited document version
select pg_temp.expect_error(
  'insert into research.claim_evidence(claim_id, document_version_id, chunk_id, evidence_role)
   values (''00000000-0000-0000-0000-000000060000'', ''00000000-0000-0000-0000-000000000100'',
           ''00000000-0000-0000-0000-000000001001'', ''supports'')',
  '23503');
insert into research.claim_evidence(claim_id, document_version_id, chunk_id, evidence_role, support_strength, quote_excerpt)
  values ('00000000-0000-0000-0000-000000060000', '00000000-0000-0000-0000-000000000100',
          '00000000-0000-0000-0000-000000001000', 'supports', 0.9, 'Total revenue was $203.9 million');

-- 15. evidence must reference a document version or a fact version
select pg_temp.expect_error(
  'insert into research.claim_evidence(claim_id, evidence_role) values (''00000000-0000-0000-0000-000000060000'', ''context'')',
  '23514');

-- ------------------------------------------------------------
-- valuation: assumptions, scenarios, calculations
-- ------------------------------------------------------------
insert into valuation.assumptions(id, subject_type, subject_id, code, name, unit)
  select '00000000-0000-0000-0000-000000070000', 'company', company_id, 'ndpr_price', 'NdPr oxide price', 'USD/kg' from f;
insert into valuation.assumption_versions(id, assumption_id, version_no, value_numeric, status)
  values ('00000000-0000-0000-0000-000000080000', '00000000-0000-0000-0000-000000070000', 0, 60, 'proposed');
insert into valuation.scenarios(id, subject_type, subject_id, name)
  select '00000000-0000-0000-0000-000000090000', 'company', company_id, 'base' from f;

-- 16. scenarios reject proposed assumption versions (G)
select pg_temp.expect_error(
  'insert into valuation.scenario_assumptions(scenario_id, assumption_id, assumption_version_id)
   values (''00000000-0000-0000-0000-000000090000'', ''00000000-0000-0000-0000-000000070000'', ''00000000-0000-0000-0000-000000080000'')',
  'P0001');

update valuation.assumption_versions set status = 'approved', approved_by = 'policy', approved_at = now()
  where id = '00000000-0000-0000-0000-000000080000';
insert into valuation.scenario_assumptions(scenario_id, assumption_id, assumption_version_id)
  values ('00000000-0000-0000-0000-000000090000', '00000000-0000-0000-0000-000000070000', '00000000-0000-0000-0000-000000080000');

-- 17. one version per assumption per scenario (I.9)
insert into valuation.assumption_versions(id, assumption_id, version_no, value_numeric, status, approved_by, approved_at)
  values ('00000000-0000-0000-0000-000000080001', '00000000-0000-0000-0000-000000070000', 0, 70, 'approved', 'user', now());
select pg_temp.expect_error(
  'insert into valuation.scenario_assumptions(scenario_id, assumption_id, assumption_version_id)
   values (''00000000-0000-0000-0000-000000090000'', ''00000000-0000-0000-0000-000000070000'', ''00000000-0000-0000-0000-000000080001'')',
  '23505');

-- 18. lineage: calculation run -> inputs -> derived CALCULATED fact (I.4)
insert into valuation.calculation_runs(id, subject_type, subject_id, research_run_id, method, engine, engine_version, input_snapshot, output)
  select '00000000-0000-0000-0000-0000000a0000', 'company', company_id, '00000000-0000-0000-0000-000000050000',
         'ratios', 'mineral-analytics', '0.1.0', '{}', '{"gross_margin":0.41}' from f;
insert into valuation.calculation_run_inputs(calculation_run_id, fact_version_id, role)
  values ('00000000-0000-0000-0000-0000000a0000', '00000000-0000-0000-0000-000000030001', 'revenue');
insert into evidence.fact_definitions(id, code, name, value_type)
  values ('00000000-0000-0000-0000-000000010001', 'gross_margin', 'Gross margin', 'numeric');
insert into evidence.facts(id, entity_type, entity_id, fact_definition_id, period_start, period_end)
  select '00000000-0000-0000-0000-000000020002', 'company', company_id,
         '00000000-0000-0000-0000-000000010001', '2024-01-01', '2024-12-31' from f;
insert into evidence.fact_versions(id, fact_id, version_no, numeric_value, extraction_method, status, promoted_by, promoted_at)
  values ('00000000-0000-0000-0000-000000030002', '00000000-0000-0000-0000-000000020002', 0, 0.41, 'calculated', 'promoted', 'system', now());
insert into evidence.fact_derivations(derived_fact_version_id, input_fact_version_id, calculation_run_id)
  values ('00000000-0000-0000-0000-000000030002', '00000000-0000-0000-0000-000000030001', '00000000-0000-0000-0000-0000000a0000');

-- "what depends on revenue v2?" answered by joins only
select pg_temp.assert(
  (select count(*) from evidence.fact_derivations where input_fact_version_id = '00000000-0000-0000-0000-000000030001') = 1
  and (select count(*) from valuation.calculation_run_inputs where fact_version_id = '00000000-0000-0000-0000-000000030001') = 1,
  'lineage tables should expose dependents of a fact version');

-- ------------------------------------------------------------
-- thesis
-- ------------------------------------------------------------
insert into research.thesis_versions(id, subject_type, subject_id, version_no, verdict, summary, confidence, research_run_id)
  select '00000000-0000-0000-0000-0000000b0000', 'company', company_id, 0, 'bullish', 's', 0.72,
         '00000000-0000-0000-0000-000000050000' from f;
insert into research.thesis_versions(id, subject_type, subject_id, version_no, verdict, summary, confidence, research_run_id)
  select '00000000-0000-0000-0000-0000000b0001', 'company', company_id, 0, 'neutral', 's2', 0.5,
         '00000000-0000-0000-0000-000000050000' from f;
select pg_temp.assert(
  (select array_agg(version_no order by version_no) from research.thesis_versions) = '{1,2}',
  'thesis_versions.version_no should be {1,2} per subject');

-- 19. thesis version must point at a run (rule 9)
select pg_temp.expect_error(
  format('insert into research.thesis_versions(subject_type, subject_id, version_no, verdict, summary)
          values (''company'', %L, 0, ''bullish'', ''s'')', (select company_id from f)),
  '23502');

insert into research.thesis_nodes(id, thesis_version_id, node_type, statement, claim_id, calculation_run_id)
  values ('00000000-0000-0000-0000-0000000c0000', '00000000-0000-0000-0000-0000000b0001', 'DRIVER', 'growth',
          '00000000-0000-0000-0000-000000060000', '00000000-0000-0000-0000-0000000a0000');

-- full provenance walk: thesis node -> claim -> evidence -> chunk -> document version -> document -> source tier
select pg_temp.assert(
  (select s.source_tier
     from research.thesis_nodes n
     join research.claims c on c.id = n.claim_id
     join research.claim_evidence ce on ce.claim_id = c.id
     join evidence.document_chunks ch on ch.id = ce.chunk_id
     join evidence.document_versions dv on dv.id = ch.document_version_id
     join evidence.documents d on d.id = dv.document_id
     join evidence.sources s on s.id = d.source_id
    where n.id = '00000000-0000-0000-0000-0000000c0000') = 1,
  'provenance walk from thesis node to source tier should resolve');

select 'ALL SCHEMA TESTS PASSED' as result;
rollback;
