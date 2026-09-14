import type { Pool } from 'pg';
import { planResolution, type ResolutionStrategy } from '@mineral/identity';
import type { UUID } from '@mineral/domain';

export interface ResolvedCompany {
  companyId: UUID;
  legalName: string;
  commonName: string | null;
  /** How the match was reached. Stored with anything derived from it. */
  method: ResolutionStrategy['method'];
  /** The value that actually matched, for display and for audit. */
  matchedValue: string;
}

export type ResolutionOutcome =
  | { status: 'resolved'; company: ResolvedCompany }
  /** Several companies match equally well. Resolution never picks one. */
  | { status: 'ambiguous'; method: ResolutionStrategy['method']; candidates: ResolvedCompany[] }
  | { status: 'not_found' };

interface Row {
  company_id: string;
  legal_name: string;
  common_name: string | null;
  matched_value: string;
}

const SELECT = `
  select c.id as company_id, c.legal_name, c.common_name`;

async function runStrategy(pool: Pool, strategy: ResolutionStrategy): Promise<Row[]> {
  switch (strategy.method) {
    case 'cik':
      return (
        await pool.query<Row>(
          `${SELECT}, ci.value as matched_value
           from core.companies c
           join core.company_identifiers ci on ci.company_id = c.id
           where ci.id_type = 'cik' and ci.value = $1`,
          [strategy.cik],
        )
      ).rows;

    case 'isin':
      return (
        await pool.query<Row>(
          `${SELECT}, s.isin as matched_value
           from core.companies c
           join core.securities s on s.company_id = c.id
           where s.isin = $1`,
          [strategy.isin],
        )
      ).rows;

    case 'ticker':
      return (
        await pool.query<Row>(
          `${SELECT}, l.ticker as matched_value
           from core.companies c
           join core.securities s on s.company_id = c.id
           join core.listings l on l.security_id = s.id
           left join core.exchanges e on e.id = l.exchange_id
           where upper(l.ticker) = $1
             and ($2::text is null or e.mic = $2)
             and (l.valid_to is null or l.valid_to > current_date)`,
          [strategy.ticker, strategy.mic ?? null],
        )
      ).rows;

    case 'alias':
      return (
        await pool.query<Row>(
          `${SELECT}, coalesce(a.alias, c.common_name, c.legal_name) as matched_value
           from core.companies c
           left join core.company_aliases a
             on a.company_id = c.id and lower(a.alias) = $1
           where lower(c.legal_name) = $1
              or lower(c.common_name) = $1
              or a.id is not null`,
          [strategy.name],
        )
      ).rows;

    case 'name_prefix':
      return (
        await pool.query<Row>(
          `${SELECT}, c.legal_name as matched_value
           from core.companies c
           where lower(c.legal_name) like $1 || '%'
              or lower(c.common_name) like $1 || '%'
           order by c.legal_name
           limit 5`,
          [strategy.name],
        )
      ).rows;
  }
}

const toResolved = (row: Row, method: ResolutionStrategy['method']): ResolvedCompany => ({
  companyId: row.company_id,
  legalName: row.legal_name,
  commonName: row.common_name,
  method,
  matchedValue: row.matched_value,
});

/**
 * Deterministic entity resolution (report phase 2). Tries the strategy ladder
 * from exact registry identifier to name prefix and stops at the first strategy
 * that matches anything. A strategy matching several distinct companies is
 * ambiguous: the caller must disambiguate, because a wrong identity poisons
 * every fact attached to it afterwards.
 */
export async function resolveCompany(pool: Pool, query: string): Promise<ResolutionOutcome> {
  for (const strategy of planResolution(query)) {
    const rows = await runStrategy(pool, strategy);
    if (rows.length === 0) continue;

    const distinct = new Map(rows.map((r) => [r.company_id, r]));
    if (distinct.size === 1) {
      return { status: 'resolved', company: toResolved([...distinct.values()][0]!, strategy.method) };
    }
    return {
      status: 'ambiguous',
      method: strategy.method,
      candidates: [...distinct.values()].map((r) => toResolved(r, strategy.method)),
    };
  }
  return { status: 'not_found' };
}
