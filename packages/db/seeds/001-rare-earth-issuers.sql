-- Seed: five SEC-registered rare-earth issuers plus one non-US issuer.
--
-- Every CIK here is copied from the SEC's own registry file
-- https://www.sec.gov/files/company_tickers.json (fetched 2026-09-14).
-- Fields that could not be verified from a primary source are left null
-- rather than guessed: an absent identifier is a correct statement about
-- what we know, a wrong one corrupts entity resolution permanently.
--
-- Idempotent: re-running changes nothing. Natural keys are the CIK for US
-- filers, the legal name otherwise, and (exchange, ticker) for listings.

\set ON_ERROR_STOP on

begin;

create function pg_temp.seed_country(p_iso2 char(2), p_name text) returns void
language sql as $$
  insert into ontology.countries (id, iso2, name)
  select core.new_entity('country'), p_iso2, p_name
  where not exists (select 1 from ontology.countries where iso2 = p_iso2);
$$;

create function pg_temp.seed_exchange(p_mic text, p_name text, p_country char(2))
returns void language sql as $$
  insert into core.exchanges (mic, name, country_code)
  select p_mic, p_name, p_country
  where not exists (select 1 from core.exchanges where mic = p_mic);
$$;

-- Creates company, registry identifier, short-name alias, one common-stock
-- security and one listing. Returns the company id.
create function pg_temp.seed_issuer(
  p_legal_name text,
  p_common_name text,
  p_cik text,
  p_country char(2),
  p_website text,
  p_mic text,
  p_ticker text,
  p_currency char(3)
) returns uuid language plpgsql as $$
declare
  v_company uuid;
  v_security uuid;
  v_exchange uuid;
begin
  if p_cik is not null then
    select company_id into v_company
    from core.company_identifiers where id_type = 'cik' and value = p_cik;
  end if;

  if v_company is null then
    select id into v_company from core.companies where legal_name = p_legal_name;
  end if;

  if v_company is null then
    v_company := core.new_entity('company');
    insert into core.companies (id, legal_name, common_name, country_code, website)
    values (v_company, p_legal_name, p_common_name, p_country, p_website);
  end if;

  if p_cik is not null then
    insert into core.company_identifiers (company_id, id_type, value)
    values (v_company, 'cik', p_cik)
    on conflict do nothing;
  end if;

  insert into core.company_aliases (company_id, alias, alias_type)
  values (v_company, p_common_name, 'short_name')
  on conflict do nothing;

  select id into v_security
  from core.securities where company_id = v_company and security_type = 'common_stock';

  if v_security is null then
    v_security := core.new_entity('security');
    insert into core.securities (id, company_id, security_type, currency)
    values (v_security, v_company, 'common_stock', p_currency);
  end if;

  select id into v_exchange from core.exchanges where mic = p_mic;

  if not exists (
    select 1 from core.listings where exchange_id = v_exchange and ticker = p_ticker
  ) then
    insert into core.listings (id, security_id, exchange_id, ticker, currency)
    values (core.new_entity('listing'), v_security, v_exchange, p_ticker, p_currency);
  end if;

  return v_company;
end $$;

select pg_temp.seed_country('US', 'United States');
select pg_temp.seed_country('AU', 'Australia');
select pg_temp.seed_country('CA', 'Canada');
select pg_temp.seed_country('CN', 'China');

select pg_temp.seed_exchange('XNYS', 'New York Stock Exchange', 'US');
select pg_temp.seed_exchange('XNAS', 'Nasdaq Stock Market', 'US');
select pg_temp.seed_exchange('XASE', 'NYSE American', 'US');
select pg_temp.seed_exchange('XASX', 'Australian Securities Exchange', 'AU');

select pg_temp.seed_issuer(
  'MP Materials Corp. / DE', 'MP Materials', '0001801368', 'US',
  'https://mpmaterials.com', 'XNYS', 'MP', 'USD');

select pg_temp.seed_issuer(
  'USA Rare Earth, Inc.', 'USA Rare Earth', '0001970622', 'US',
  null, 'XNAS', 'USAR', 'USD');

select pg_temp.seed_issuer(
  'ENERGY FUELS INC', 'Energy Fuels', '0001385849', null,
  null, 'XASE', 'UUUU', 'USD');

select pg_temp.seed_issuer(
  'NIOCORP DEVELOPMENTS LTD', 'NioCorp', '0001512228', null,
  null, 'XNAS', 'NB', 'USD');

select pg_temp.seed_issuer(
  'Critical Metals Corp.', 'Critical Metals', '0001951089', null,
  null, 'XNAS', 'CRML', 'USD');

-- Non-US issuer: no SEC registration, so no CIK. Resolution has to reach it
-- through ticker and alias alone.
select pg_temp.seed_issuer(
  'Lynas Rare Earths Limited', 'Lynas', null, 'AU',
  'https://lynasrareearths.com', 'XASX', 'LYC', 'AUD');

insert into core.company_aliases (company_id, alias, alias_type)
select id, 'Molycorp', 'former_name' from core.companies
where legal_name = 'MP Materials Corp. / DE'
on conflict do nothing;

insert into core.company_aliases (company_id, alias, alias_type)
select id, 'Lynas Corporation', 'former_name' from core.companies
where legal_name = 'Lynas Rare Earths Limited'
on conflict do nothing;

commit;
