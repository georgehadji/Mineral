-- Seed: seven SEC-registered rare-earth issuers plus twelve that file
-- nowhere the SEC can see them.
--
-- Every CIK here is copied from the SEC's own registry file
-- https://www.sec.gov/files/company_tickers.json (fetched 2026-09-14, later
-- issuers 2026-09-17). An issuer with no SEC registration carries the name
-- and ticker its own exchange publishes instead: the SSE and SZSE company
-- profiles for the Chinese listings, the LSE instrument record and the TMX
-- listed-company directory for the rest, and the ISO 10383 register for
-- every MIC below (all fetched 2026-09-17). Each name is spelled the way the
-- registry that issued it spells it, which is why some of them shout.
--
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
select pg_temp.seed_country('GB', 'United Kingdom');

select pg_temp.seed_exchange('XNYS', 'New York Stock Exchange', 'US');
select pg_temp.seed_exchange('XNAS', 'Nasdaq Stock Market', 'US');
select pg_temp.seed_exchange('XASE', 'NYSE American', 'US');
select pg_temp.seed_exchange('XASX', 'Australian Securities Exchange', 'AU');
select pg_temp.seed_exchange('XTSE', 'Toronto Stock Exchange', 'CA');
select pg_temp.seed_exchange('XTSX', 'TSX Venture Exchange', 'CA');
select pg_temp.seed_exchange('XSHG', 'Shanghai Stock Exchange', 'CN');
select pg_temp.seed_exchange('XSHE', 'Shenzhen Stock Exchange', 'CN');
select pg_temp.seed_exchange('XLON', 'London Stock Exchange', 'GB');

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

-- A seventh issuer, deliberately owned by no suite but the monitoring one:
-- its integration test rewrites the whole record of one company, and the
-- database suites run in parallel.
select pg_temp.seed_issuer(
  'Arafura Rare Earths Limited', 'Arafura', null, 'AU',
  null, 'XASX', 'ARU', 'AUD');

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

-- US-registered: a coking-coal miner with an SEC CIK, developing the Brook
-- Mine rare earth project in Wyoming as a byproduct of its coal reserves.
select pg_temp.seed_issuer(
  'Ramaco Resources, Inc.', 'Ramaco Resources', '1687187', 'US',
  'https://ramacoresources.com', 'XNAS', 'METC', 'USD');

-- US-registered under a Canadian holding company: primary listing is TSX
-- Venture, but the CIK below is real and belongs to the same legal entity,
-- not to the listing it is recorded against (company_identifiers and
-- listings are separate tables for exactly this reason).
select pg_temp.seed_issuer(
  'Ucore Rare Metals Inc.', 'Ucore Rare Metals', '1495651', 'CA',
  'https://ucore.com', 'XTSX', 'UCU', 'CAD');

-- Non-US issuer, no CIK: building the Eneabba rare earth refinery, the
-- separation stage this seed otherwise has only Lynas covering.
select pg_temp.seed_issuer(
  'Iluka Resources Limited', 'Iluka Resources', null, 'AU',
  'https://iluka.com', 'XASX', 'ILU', 'AUD');

-- Non-US issuer, no CIK: separation and permanent-magnet manufacturing, the
-- downstream stage no other issuer in this seed reaches.
select pg_temp.seed_issuer(
  'Neo Performance Materials Inc.', 'Neo Performance Materials', null, 'CA',
  'https://neomaterials.com', 'XTSE', 'NEO', 'CAD');

-- China runs most of this chain and none of it was represented above. These
-- five are its listed end, on Shanghai and Shenzhen, and they are the first
-- rows here to reach the magnet stage in volume rather than in plan. None of
-- them is an SEC registrant, so none has a CIK; the exchange profile is the
-- registry of record and supplies the English name below.
select pg_temp.seed_issuer(
  'JL MAG RARE-EARTH CO., LTD.', 'JL MAG', null, 'CN',
  'https://www.jlmag.com.cn', 'XSHE', '300748', 'CNY');

select pg_temp.seed_issuer(
  'BEIJING ZHONG KE SAN HUAN HIGH-TECH CO., LTD', 'Zhongke Sanhuan', null, 'CN',
  'https://www.san-huan.com.cn', 'XSHE', '000970', 'CNY');

-- The SSE company profile carries no website field, so these three have none
-- instead of a hostname that looked plausible.
select pg_temp.seed_issuer(
  'China Northern Rare Earth (Group) High-Tech Co.,Ltd', 'China Northern Rare Earth',
  null, 'CN', null, 'XSHG', '600111', 'CNY');

select pg_temp.seed_issuer(
  'Ningbo Yunsheng Co.,Ltd.', 'Ningbo Yunsheng', null, 'CN',
  null, 'XSHG', '600366', 'CNY');

select pg_temp.seed_issuer(
  'Shenghe Resources Holding Co.,Ltd', 'Shenghe Resources', null, 'CN',
  null, 'XSHG', '600392', 'CNY');

-- For a Chinese issuer the registered Chinese name is the resolution key and
-- the English one is the translation, which is the reverse of every other row
-- in this file. Both come from the same exchange profile as the listing.
insert into core.company_aliases (company_id, alias, alias_type)
select c.id, v.local_name, 'local_name'
  from (values
    ('JL MAG RARE-EARTH CO., LTD.',
     '江西金力永磁科技股份有限公司'),
    ('BEIJING ZHONG KE SAN HUAN HIGH-TECH CO., LTD',
     '北京中科三环高技术股份有限公司'),
    ('China Northern Rare Earth (Group) High-Tech Co.,Ltd',
     '中国北方稀土(集团)高科技股份有限公司'),
    ('Ningbo Yunsheng Co.,Ltd.',
     '宁波韵升股份有限公司'),
    ('Shenghe Resources Holding Co.,Ltd',
     '盛和资源控股股份有限公司')
  ) as v(legal_name, local_name)
  join core.companies c on c.legal_name = v.legal_name
on conflict do nothing;

-- Country null for the same reason the three US-listed rows above have one:
-- the TMX directory publishes a symbol and a name and nothing else, and no
-- other register consulted states this issuer's jurisdiction.
select pg_temp.seed_issuer(
  'Aclara Resources Inc.', 'Aclara Resources', null, null,
  null, 'XTSE', 'ARA', 'CAD');

-- The LSE quotes PRE in GBX, which is pence rather than an ISO 4217 currency.
-- This column holds the currency, so it holds GBP.
select pg_temp.seed_issuer(
  'PENSANA PLC', 'Pensana', null, 'GB',
  null, 'XLON', 'PRE', 'GBP');

-- Recorded on TSX Venture, its home listing; the AIM line under the same
-- ticker is a depositary interest over these same Canadian shares. No CIK on
-- purpose: there is an SEC registrant named Mkango Rare Earths Ltd, CIK
-- 2052373, formerly Lancaster Exploration Ltd, but it is a different legal
-- entity and its registration was still an unconsummated F-4 on 2026-09-17.
-- Attaching that CIK here is precisely the corruption the header warns about.
select pg_temp.seed_issuer(
  'Mkango Resources Ltd.', 'Mkango Resources', null, 'CA',
  null, 'XTSX', 'MKA', 'CAD');

commit;
