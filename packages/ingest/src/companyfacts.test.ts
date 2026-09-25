import { describe, expect, it } from 'vitest';
import { FACT_DEFINITIONS, parseCompanyFacts } from './companyfacts.ts';

const entry = (over: Record<string, unknown>) => ({
  accn: '0001801368-25-000004',
  form: '10-K',
  filed: '2025-02-20',
  fy: 2024,
  fp: 'FY',
  ...over,
});

const facts = (units: Record<string, unknown>) => ({ facts: { 'us-gaap': units } });

describe('parseCompanyFacts', () => {
  it('reads a duration concept as a period and an instant concept as an as-of date', () => {
    const parsed = parseCompanyFacts(
      facts({
        Revenues: { units: { USD: [entry({ start: '2024-01-01', end: '2024-12-31', val: 203900000 })] } },
        Assets: { units: { USD: [entry({ end: '2024-12-31', val: 2600000000 })] } },
      }),
    );
    expect(parsed).toHaveLength(2);
    const revenue = parsed.find((p) => p.code === 'revenue');
    expect(revenue).toMatchObject({
      periodStart: '2024-01-01',
      periodEnd: '2024-12-31',
      value: 203900000,
      currency: 'USD',
    });
    expect(revenue?.asOfDate).toBeUndefined();
    expect(parsed.find((p) => p.code === 'total_assets')).toMatchObject({ asOfDate: '2024-12-31' });
  });

  it('follows capex to the concept a filer moved it to', () => {
    // Ramaco's shape: PP&E payments until early 2024, capital improvements after.
    const parsed = parseCompanyFacts(
      facts({
        PaymentsToAcquirePropertyPlantAndEquipment: {
          units: { USD: [entry({ start: '2023-01-01', end: '2023-12-31', val: 82904000, fy: 2023 })] },
        },
        PaymentsForCapitalImprovements: {
          units: { USD: [entry({ start: '2025-01-01', end: '2025-12-31', val: 62781000, fy: 2025 })] },
        },
      }),
    );
    expect(parsed.filter((p) => p.code === 'capital_expenditure').map((p) => p.value)).toEqual([82904000, 62781000]);
  });

  it("reads total equity only where the parent's equity is not tagged", () => {
    const including = 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest';
    const parsed = parseCompanyFacts(
      facts({
        StockholdersEquity: { units: { USD: [entry({ end: '2024-12-31', val: 678405000 })] } },
        [including]: {
          units: {
            USD: [entry({ end: '2024-12-31', val: 682570000 }), entry({ end: '2023-12-31', val: 494286000 })],
          },
        },
      }),
    );
    expect(parsed.filter((p) => p.code === 'stockholders_equity').map((p) => [p.asOfDate, p.value])).toEqual([
      ['2023-12-31', 494286000],
      ['2024-12-31', 678405000],
    ]);
  });

  it('reads an IFRS filer, parent-attributable profit first', () => {
    const parsed = parseCompanyFacts({
      facts: {
        'ifrs-full': {
          CashFlowsFromUsedInOperatingActivities: {
            units: { USD: [entry({ start: '2025-01-01', end: '2025-12-31', val: -9_100_000, form: '20-F' })] },
          },
          ProfitLoss: { units: { USD: [entry({ start: '2025-01-01', end: '2025-12-31', val: -30_000_000, form: '20-F' })] } },
          ProfitLossAttributableToOwnersOfParent: {
            units: { USD: [entry({ start: '2025-01-01', end: '2025-12-31', val: -28_500_000, form: '20-F' })] },
          },
        },
      },
    });
    expect(Object.fromEntries(parsed.map((p) => [p.code, [p.concept, p.value]]))).toEqual({
      net_income: ['ProfitLossAttributableToOwnersOfParent', -28_500_000],
      operating_cash_flow: ['CashFlowsFromUsedInOperatingActivities', -9_100_000],
    });
  });

  it('keeps the latest-filed value when a period is reported twice', () => {
    const parsed = parseCompanyFacts(
      facts({
        Assets: {
          units: {
            USD: [
              entry({ end: '2024-12-31', val: 2600000000 }),
              entry({ end: '2024-12-31', val: 2550000000, filed: '2025-05-08', accn: '0001801368-25-000010' }),
            ],
          },
        },
      }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ value: 2550000000, accession: '0001801368-25-000010' });
  });

  it('prefers the ASC 606 concept over Revenues on the same filing', () => {
    const parsed = parseCompanyFacts(
      facts({
        Revenues: { units: { USD: [entry({ start: '2024-01-01', end: '2024-12-31', val: 1 })] } },
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [entry({ start: '2024-01-01', end: '2024-12-31', val: 2 })] },
        },
      }),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({ value: 2, concept: 'RevenueFromContractWithCustomerExcludingAssessedTax' });
  });

  it('ignores unmapped concepts, unaccepted units and mistagged periods', () => {
    const parsed = parseCompanyFacts(
      facts({
        EntityCommonStockSharesOutstanding: { units: { shares: [entry({ end: '2024-12-31', val: 5 })] } },
        Assets: {
          units: {
            EUR: [entry({ end: '2024-12-31', val: 9 })],
            USD: [entry({ start: '2024-01-01', end: '2024-12-31', val: 9 })],
          },
        },
      }),
    );
    expect(parsed).toEqual([]);
  });

  it('drops observations older than the since bound', () => {
    const payload = facts({
      Assets: {
        units: {
          USD: [entry({ end: '2019-12-31', val: 1 }), entry({ end: '2024-12-31', val: 2 })],
        },
      },
    });
    expect(parseCompanyFacts(payload, { since: '2020-01-01' }).map((p) => p.value)).toEqual([2]);
  });

  it('rejects a payload with no facts block', () => {
    expect(() => parseCompanyFacts({})).toThrow(/no facts block/);
  });
});

describe('FACT_DEFINITIONS', () => {
  it('holds one numeric definition per code', () => {
    const codes = FACT_DEFINITIONS.map((d) => d.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(FACT_DEFINITIONS.every((d) => d.valueType === 'numeric')).toBe(true);
    expect(codes).toContain('revenue');
  });
});
