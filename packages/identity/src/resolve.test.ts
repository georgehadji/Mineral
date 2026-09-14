import { describe, expect, it } from 'vitest';
import { planResolution } from './resolve.ts';

const methods = (query: string) => planResolution(query).map((s) => s.method);

describe('resolution planning', () => {
  it('treats a bare number as a CIK and nothing else', () => {
    expect(methods('1801368')).toEqual(['cik']);
    expect(planResolution('1801368')[0]).toEqual({ method: 'cik', cik: '0001801368' });
  });

  it('tries ticker before name for a short symbol', () => {
    expect(methods('MP')).toEqual(['ticker', 'alias']);
  });

  it('skips prefix search on a query too short to narrow anything', () => {
    expect(methods('MP')).not.toContain('name_prefix');
    expect(methods('UUUU')).toContain('name_prefix');
  });

  it('pins the exchange when the query names one', () => {
    expect(planResolution('NYSE:MP')[0]).toEqual({ method: 'ticker', ticker: 'MP', mic: 'XNYS' });
  });

  it('drops an exchange it cannot map instead of guessing', () => {
    expect(planResolution('LSE:MP')[0]).toEqual({ method: 'ticker', ticker: 'MP' });
  });

  it('treats a company name as alias then prefix', () => {
    expect(methods('MP Materials')).toEqual(['alias', 'name_prefix']);
  });

  it('puts an ISIN ahead of every weaker strategy', () => {
    expect(methods('US0378331005')[0]).toBe('isin');
  });

  it('returns nothing for an empty query', () => {
    expect(planResolution('   ')).toEqual([]);
  });

  it('orders strategies from exact to fuzzy', () => {
    const plan = planResolution('MP');
    expect(plan).toEqual([
      { method: 'ticker', ticker: 'MP' },
      { method: 'alias', name: 'mp' },
    ]);
    expect(planResolution('Lynas Rare Earths').map((s) => s.method)).toEqual([
      'alias',
      'name_prefix',
    ]);
  });
});
