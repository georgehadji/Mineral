import { describe, expect, it } from 'vitest';
import {
  isinCheckDigitValid,
  normalizeCik,
  normalizeIsin,
  normalizeName,
  normalizeTicker,
  toMic,
} from './identifiers.ts';

describe('CIK', () => {
  it('pads to the canonical ten digits', () => {
    expect(normalizeCik('1801368')).toBe('0001801368');
    expect(normalizeCik('0001801368')).toBe('0001801368');
  });

  it('accepts the CIK- prefix the SEC prints on filings', () => {
    expect(normalizeCik('CIK-1801368')).toBe('0001801368');
    expect(normalizeCik('cik 0001385849')).toBe('0001385849');
  });

  it('rejects anything that is not a CIK', () => {
    expect(normalizeCik('MP')).toBeNull();
    expect(normalizeCik('18013689999')).toBeNull();
    expect(normalizeCik('0')).toBeNull();
    expect(normalizeCik('')).toBeNull();
  });
});

describe('ISIN', () => {
  // Check digits verified against the ISO 6166 algorithm, not invented.
  it('accepts valid ISINs', () => {
    expect(normalizeIsin('US0378331005')).toBe('US0378331005');
    expect(normalizeIsin('us0378331005')).toBe('US0378331005');
    expect(normalizeIsin('AU000000BHP4')).toBe('AU000000BHP4');
  });

  it('rejects a transposed ISIN that looks well formed', () => {
    expect(normalizeIsin('US0378331050')).toBeNull();
    expect(isinCheckDigitValid('US0378331005')).toBe(true);
    expect(isinCheckDigitValid('US0378331004')).toBe(false);
  });

  it('rejects wrong shapes', () => {
    expect(normalizeIsin('US037833100')).toBeNull();
    expect(normalizeIsin('0378331005US')).toBeNull();
    expect(normalizeIsin('MP')).toBeNull();
  });
});

describe('ticker', () => {
  it('reads a bare ticker', () => {
    expect(normalizeTicker('MP')).toEqual({ ticker: 'MP' });
    expect(normalizeTicker(' uuuu ')).toEqual({ ticker: 'UUUU' });
  });

  it('splits an exchange prefix', () => {
    expect(normalizeTicker('NYSE:MP')).toEqual({ ticker: 'MP', exchange: 'NYSE' });
    expect(normalizeTicker('asx: lyc')).toEqual({ ticker: 'LYC', exchange: 'ASX' });
  });

  it('keeps a listing suffix', () => {
    expect(normalizeTicker('LYC.AX')).toEqual({ ticker: 'LYC.AX' });
  });

  it('rejects non-tickers', () => {
    expect(normalizeTicker('MP Materials')).toBeNull();
    expect(normalizeTicker('1801368')).toBeNull();
    expect(normalizeTicker('a:b:c')).toBeNull();
  });
});

describe('exchange labels', () => {
  it('maps common labels to MICs', () => {
    expect(toMic('NYSE')).toBe('XNYS');
    expect(toMic('nasdaq')).toBe('XNAS');
    expect(toMic('ASX')).toBe('XASX');
  });

  it('leaves unknown labels unmapped rather than guessing', () => {
    expect(toMic('LSE')).toBeNull();
  });
});

describe('name', () => {
  it('collapses whitespace and case without dropping words', () => {
    expect(normalizeName('  MP   Materials  Corp. ')).toBe('mp materials corp.');
  });
});
