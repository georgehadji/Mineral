/**
 * XBRL companyfacts -> fact candidates. Wholly deterministic: an explicit
 * concept map, no language model anywhere in this path. A number the SEC
 * received from the filer is read, never interpreted.
 */

export interface XbrlConcept {
  taxonomy: string;
  concept: string;
  /** evidence.fact_definitions.code this concept feeds. */
  code: string;
  name: string;
  /** duration concepts carry a period; instant concepts carry an as-of date. */
  period: 'duration' | 'instant';
  canonicalUnit: string;
}

/**
 * Order matters: when two concepts feed the same code for the same period,
 * the one listed first wins. Filers migrated from Revenues to the
 * ASC 606 concept, and many tag both.
 */
export const XBRL_CONCEPTS: readonly XbrlConcept[] = [
  c('RevenueFromContractWithCustomerExcludingAssessedTax', 'revenue', 'Revenue', 'duration'),
  c('Revenues', 'revenue', 'Revenue', 'duration'),
  // Ramaco's revenue since its 2026 10-Qs. pnpm coverage finds these moves.
  c('RevenueFromContractWithCustomerIncludingAssessedTax', 'revenue', 'Revenue', 'duration'),
  c('CostOfRevenue', 'cost_of_revenue', 'Cost of revenue', 'duration'),
  c('GrossProfit', 'gross_profit', 'Gross profit', 'duration'),
  c('OperatingIncomeLoss', 'operating_income', 'Operating income', 'duration'),
  c('NetIncomeLoss', 'net_income', 'Net income', 'duration'),
  c('ResearchAndDevelopmentExpense', 'research_and_development', 'Research and development', 'duration'),
  c('NetCashProvidedByUsedInOperatingActivities', 'operating_cash_flow', 'Operating cash flow', 'duration'),
  c('PaymentsToAcquirePropertyPlantAndEquipment', 'capital_expenditure', 'Capital expenditure', 'duration'),
  // Filers move capex between these: Ramaco and NioCorp to capital improvements,
  // USA Rare Earth to productive assets, Energy Fuels to "other" PP&E in 2026.
  // None of the universe tags two of them for one period in one filing; a filer
  // that did would have them as components, and the first listed would win.
  c('PaymentsToAcquireProductiveAssets', 'capital_expenditure', 'Capital expenditure', 'duration'),
  c('PaymentsForCapitalImprovements', 'capital_expenditure', 'Capital expenditure', 'duration'),
  c('PaymentsToAcquireOtherPropertyPlantAndEquipment', 'capital_expenditure', 'Capital expenditure', 'duration'),
  c('Assets', 'total_assets', 'Total assets', 'instant'),
  c('Liabilities', 'total_liabilities', 'Total liabilities', 'instant'),
  c('StockholdersEquity', 'stockholders_equity', 'Stockholders equity', 'instant'),
  // Total equity, noncontrolling interest included: USA Rare Earth reports only
  // this since 2025. Listed second, so a filer tagging both keeps the parent's.
  c('StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', 'stockholders_equity', 'Stockholders equity', 'instant'),
  c('CashAndCashEquivalentsAtCarryingValue', 'cash_and_equivalents', 'Cash and equivalents', 'instant'),
  c('InventoryNet', 'inventory', 'Inventory, net', 'instant'),
  c('LongTermDebtNoncurrent', 'long_term_debt', 'Long-term debt, noncurrent', 'instant'),

  // Foreign private issuers filing 20-F under IFRS (Critical Metals). A filer
  // reports in one taxonomy, so these never compete with the us-gaap rows.
  ifrs('Revenue', 'revenue', 'Revenue', 'duration'),
  ifrs('CostOfSales', 'cost_of_revenue', 'Cost of revenue', 'duration'),
  ifrs('GrossProfit', 'gross_profit', 'Gross profit', 'duration'),
  ifrs('ProfitLossFromOperatingActivities', 'operating_income', 'Operating income', 'duration'),
  // Attributable to the parent first, as NetIncomeLoss is; the consolidated
  // total only where that is not tagged.
  ifrs('ProfitLossAttributableToOwnersOfParent', 'net_income', 'Net income', 'duration'),
  ifrs('ProfitLoss', 'net_income', 'Net income', 'duration'),
  ifrs('ResearchAndDevelopmentExpense', 'research_and_development', 'Research and development', 'duration'),
  ifrs('CashFlowsFromUsedInOperatingActivities', 'operating_cash_flow', 'Operating cash flow', 'duration'),
  // PP&E only. Exploration and evaluation spend is a second component tagged
  // alongside it in the same filings, and the first-listed rule would keep one
  // of the two; summing components is a derivation, not a mapping.
  ifrs('PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities', 'capital_expenditure', 'Capital expenditure', 'duration'),
  ifrs('Assets', 'total_assets', 'Total assets', 'instant'),
  ifrs('Liabilities', 'total_liabilities', 'Total liabilities', 'instant'),
  ifrs('EquityAttributableToOwnersOfParent', 'stockholders_equity', 'Stockholders equity', 'instant'),
  ifrs('Equity', 'stockholders_equity', 'Stockholders equity', 'instant'),
  ifrs('CashAndCashEquivalents', 'cash_and_equivalents', 'Cash and equivalents', 'instant'),
  ifrs('Inventories', 'inventory', 'Inventory, net', 'instant'),
];

function c(concept: string, code: string, name: string, period: 'duration' | 'instant'): XbrlConcept {
  return { taxonomy: 'us-gaap', concept, code, name, period, canonicalUnit: 'USD' };
}

function ifrs(concept: string, code: string, name: string, period: 'duration' | 'instant'): XbrlConcept {
  return { ...c(concept, code, name, period), taxonomy: 'ifrs-full' };
}

export interface FactDefinition {
  code: string;
  name: string;
  valueType: 'numeric';
  canonicalUnit: string;
  description: string;
}

/** One definition per code, in first-listed order. */
export const FACT_DEFINITIONS: readonly FactDefinition[] = XBRL_CONCEPTS.reduce<FactDefinition[]>(
  (acc, concept) => {
    if (acc.some((d) => d.code === concept.code)) return acc;
    acc.push({
      code: concept.code,
      name: concept.name,
      valueType: 'numeric',
      canonicalUnit: concept.canonicalUnit,
      description: `US-GAAP XBRL concept ${concept.concept} as filed with the SEC`,
    });
    return acc;
  },
  [],
);

export interface XbrlFactCandidate {
  code: string;
  concept: string;
  value: number;
  unit: string;
  currency?: string;
  periodStart?: string;
  periodEnd?: string;
  asOfDate?: string;
  /** Accession of the filing that reported this value. */
  accession: string;
  form: string;
  filedAt: string;
  fiscalYear?: number;
  fiscalPeriod?: string;
}

export interface ParseCompanyFactsOptions {
  /** Drop observations whose period ends before this date. */
  since?: string;
  /** XBRL units to accept. Default USD only. */
  units?: readonly string[];
}

interface UnitEntry {
  start?: string;
  end?: string;
  val?: number;
  accn?: string;
  form?: string;
  filed?: string;
  fy?: number;
  fp?: string;
}

/**
 * One candidate per observable. The same period is re-reported across filings
 * and restated afterwards, so the latest-filed value wins; an earlier value
 * that disagrees becomes a superseded fact version at write time, not a
 * competing fact.
 */
export function parseCompanyFacts(
  json: unknown,
  options: ParseCompanyFactsOptions = {},
): XbrlFactCandidate[] {
  const facts = (json as { facts?: Record<string, Record<string, { units?: Record<string, UnitEntry[]> }>> }).facts;
  if (!facts || typeof facts !== 'object') {
    throw new Error('companyfacts JSON has no facts block');
  }
  const accepted = new Set(options.units ?? ['USD']);
  const best = new Map<string, { candidate: XbrlFactCandidate; precedence: number }>();

  XBRL_CONCEPTS.forEach((concept, precedence) => {
    const units = facts[concept.taxonomy]?.[concept.concept]?.units;
    if (!units) return;
    for (const [unit, entries] of Object.entries(units)) {
      if (!accepted.has(unit) || !Array.isArray(entries)) continue;
      for (const entry of entries) {
        const candidate = toCandidate(concept, unit, entry, options.since);
        if (!candidate) continue;
        const key = `${candidate.code}|${candidate.periodStart ?? ''}|${candidate.periodEnd ?? ''}|${candidate.asOfDate ?? ''}`;
        const held = best.get(key);
        if (!held || wins(candidate, precedence, held)) best.set(key, { candidate, precedence });
      }
    }
  });

  return [...best.values()]
    .map((held) => held.candidate)
    .sort((a, b) => {
      const byCode = a.code.localeCompare(b.code);
      if (byCode !== 0) return byCode;
      return (a.periodEnd ?? a.asOfDate ?? '').localeCompare(b.periodEnd ?? b.asOfDate ?? '');
    });
}

/** Later filing wins; then the preferred concept; then the higher accession. */
function wins(
  candidate: XbrlFactCandidate,
  precedence: number,
  held: { candidate: XbrlFactCandidate; precedence: number },
): boolean {
  if (candidate.filedAt !== held.candidate.filedAt) return candidate.filedAt > held.candidate.filedAt;
  if (precedence !== held.precedence) return precedence < held.precedence;
  return candidate.accession > held.candidate.accession;
}

function toCandidate(
  concept: XbrlConcept,
  unit: string,
  entry: UnitEntry,
  since: string | undefined,
): XbrlFactCandidate | null {
  const { val, end, start, accn, form, filed } = entry;
  if (typeof val !== 'number' || !Number.isFinite(val)) return null;
  if (!end || !accn || !form || !filed) return null;
  // A duration concept without a start, or an instant with one, is a tagging
  // error we cannot repair; dropping it beats guessing the period.
  if (concept.period === 'duration' && !start) return null;
  if (concept.period === 'instant' && start) return null;
  if (since && end < since) return null;

  return {
    code: concept.code,
    concept: concept.concept,
    value: val,
    unit,
    ...(unit === concept.canonicalUnit ? { currency: unit } : {}),
    ...(concept.period === 'duration' ? { periodStart: start, periodEnd: end } : { asOfDate: end }),
    accession: accn,
    form,
    filedAt: filed,
    ...(typeof entry.fy === 'number' ? { fiscalYear: entry.fy } : {}),
    ...(typeof entry.fp === 'string' ? { fiscalPeriod: entry.fp } : {}),
  };
}
