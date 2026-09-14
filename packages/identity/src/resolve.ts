import { normalizeCik, normalizeIsin, normalizeName, normalizeTicker, toMic } from './identifiers.ts';

/**
 * One resolution attempt. The ladder is ordered from exact registry match to
 * fuzzy name match, and the first strategy that returns a row wins, so a
 * resolution can always state how it was reached (report H.3).
 */
export type ResolutionStrategy =
  | { method: 'cik'; cik: string }
  | { method: 'isin'; isin: string }
  | { method: 'ticker'; ticker: string; mic?: string }
  | { method: 'alias'; name: string }
  | { method: 'name_prefix'; name: string };

/** Lower is tried first. Also the confidence ordering reported to the caller. */
export const STRATEGY_PRECEDENCE: Record<ResolutionStrategy['method'], number> = {
  cik: 0,
  isin: 1,
  ticker: 2,
  alias: 3,
  name_prefix: 4,
};

/**
 * Turns free text into the ordered strategies worth trying. A query can yield
 * several: `MP` is both a plausible ticker and a plausible name fragment.
 */
export function planResolution(query: string): ResolutionStrategy[] {
  const raw = query.trim();
  if (raw.length === 0) return [];

  const strategies: ResolutionStrategy[] = [];

  const cik = normalizeCik(raw);
  if (cik) strategies.push({ method: 'cik', cik });

  const isin = normalizeIsin(raw);
  if (isin) strategies.push({ method: 'isin', isin });

  const ticker = normalizeTicker(raw);
  if (ticker) {
    const mic = ticker.exchange ? toMic(ticker.exchange) : null;
    strategies.push(mic ? { method: 'ticker', ticker: ticker.ticker, mic } : { method: 'ticker', ticker: ticker.ticker });
  }

  // A pure number is a CIK, never a name. Everything else can be a name.
  if (cik === null) {
    const name = normalizeName(raw);
    strategies.push({ method: 'alias', name });
    if (name.length >= 3) strategies.push({ method: 'name_prefix', name });
  }

  return strategies.sort((a, b) => STRATEGY_PRECEDENCE[a.method] - STRATEGY_PRECEDENCE[b.method]);
}
