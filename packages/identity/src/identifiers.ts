/**
 * Identifier normalisation. Pure, no I/O.
 *
 * Resolution is deterministic by design (rule 2): a registry identifier either
 * matches or it does not. Nothing here guesses, and every function returns null
 * rather than a best effort when the input is not a valid identifier.
 */

/** SEC central index key, canonicalised to the 10-digit zero-padded form. */
export function normalizeCik(input: string): string | null {
  const trimmed = input.trim().replace(/^cik[-_:\s]*/i, '');
  if (!/^\d{1,10}$/.test(trimmed)) return null;
  const padded = trimmed.padStart(10, '0');
  return padded === '0000000000' ? null : padded;
}

/** ISO 6166 ISIN: 2-letter country, 9 alphanumeric, 1 check digit. */
export function normalizeIsin(input: string): string | null {
  const candidate = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(candidate)) return null;
  return isinCheckDigitValid(candidate) ? candidate : null;
}

/**
 * Luhn over the digit expansion: each letter becomes its position value
 * (A = 10 ... Z = 35), then the standard mod-10 check applies.
 */
export function isinCheckDigitValid(isin: string): boolean {
  const digits = [...isin.slice(0, 11)]
    .map((c) => (c >= 'A' && c <= 'Z' ? String(c.charCodeAt(0) - 55) : c))
    .join('');

  let sum = 0;
  let double = true; // rightmost body digit is doubled
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === Number(isin[11]);
}

/**
 * Ticker, with any exchange prefix removed: `NYSE:MP`, `nyse: mp` and `MP` all
 * normalise to `MP`. The exchange is returned separately when present, because
 * a ticker is only unique within an exchange.
 */
export function normalizeTicker(input: string): { ticker: string; exchange?: string } | null {
  const raw = input.trim();
  const parts = raw.split(':');
  if (parts.length > 2) return null;

  const tickerPart = (parts.length === 2 ? parts[1] : parts[0])!.trim().toUpperCase();
  const exchangePart = parts.length === 2 ? parts[0]!.trim().toUpperCase() : undefined;

  if (!/^[A-Z][A-Z0-9]{0,6}(\.[A-Z]{1,2})?$/.test(tickerPart)) return null;
  if (exchangePart !== undefined && !/^[A-Z]{2,8}$/.test(exchangePart)) return null;

  return exchangePart === undefined ? { ticker: tickerPart } : { ticker: tickerPart, exchange: exchangePart };
}

/** Collapses whitespace and case for alias comparison. Keeps the words intact. */
export function normalizeName(input: string): string {
  return input.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Common exchange labels mapped to ISO 10383 MICs. Unknown labels stay unmapped. */
const MIC_BY_LABEL: Record<string, string> = {
  NYSE: 'XNYS',
  XNYS: 'XNYS',
  NASDAQ: 'XNAS',
  XNAS: 'XNAS',
  AMEX: 'XASE',
  NYSEAMER: 'XASE',
  XASE: 'XASE',
  ASX: 'XASX',
  XASX: 'XASX',
};

export function toMic(label: string): string | null {
  return MIC_BY_LABEL[label.trim().toUpperCase()] ?? null;
}
