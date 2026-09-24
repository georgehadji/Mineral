import type { UUID } from '@mineral/domain';

/**
 * Deterministic verification (report J.7). Every rule here is a function of
 * stored rows: no model, no judgement, and the same input always produces the
 * same verdict. That is what lets a check be evidence in its own right.
 *
 * The rules run against what was written, not against what a module returned.
 * The runtime already refuses a bad citation at write time; this pass exists
 * because a check that only runs on the way in cannot catch a row that arrived
 * some other way, and cannot be re-run against a claim years later.
 */

export type CheckType =
  | 'quote_containment'
  | 'number_vs_fact'
  | 'unit_consistency'
  | 'date_consistency'
  | 'source_tier'
  | 'contradiction'
  | 'schema'
  | 'other';

export type CheckStatus = 'passed' | 'failed' | 'skipped';
export type CheckSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface VerifiableEvidence {
  chunkId: UUID | null;
  factVersionId: UUID | null;
  quote: string | null;
  /** Text of the cited chunk as stored, null when the citation is a fact. */
  chunkText: string | null;
  /** Tier of the source the cited chunk came from. */
  sourceTier: number | null;
  /** Value of the cited fact version, as stored. */
  factValue: string | null;
  /**
   * When the cited evidence is about: the end of a cited fact's period, or the
   * publication date of the cited document. A quote rarely repeats the year of
   * the statement it supports, and the row it came from usually knows it.
   */
  periodEnd: string | null;
}

export interface VerifiableClaim {
  claimId: UUID;
  claimKey: string;
  claimType: string;
  statement: string;
  status: string;
  evidence: VerifiableEvidence[];
}

export interface CheckResult {
  type: CheckType;
  status: CheckStatus;
  severity: CheckSeverity;
  claimId: UUID;
  message: string;
  evidence: Record<string, unknown>;
}

/** Claim types whose numbers carry money. These may not rest on weak sources. */
const FINANCIAL_CLAIM_TYPES = new Set(['metric', 'financial', 'financial_fact', 'valuation']);

/** Tier 4 and 5 are commentary and aggregators (docs/domain). */
const WEAK_TIER = 4;

/**
 * Typography, folded to its plain form.
 *
 * A filing is typeset: it writes curly quotes, en dashes and non-breaking
 * spaces. A model copying a sentence out of one faithfully returns the plain
 * glyphs, because that is what its tokeniser produced. Comparing character for
 * character then calls a correct quote a fabrication, which is the worst
 * direction for this check to fail in: it teaches whoever reads the error that
 * the gate cries wolf.
 *
 * This is not a licence to paraphrase. Every letter, digit, word and word
 * boundary still has to match. What is folded is only the glyph a typesetter
 * chose for a quote, a dash or a space.
 */
const TYPOGRAPHY: readonly (readonly [RegExp, string])[] = [
  [/[‘’‚‛′]/g, "'"],
  [/[“”„‟″]/g, '"'],
  [/[‐-―−]/g, '-'],
  [/…/g, '...'],
  [/[     ]/g, ' '],
  // Zero-width joiners and byte-order marks survive HTML extraction and are
  // invisible in an error message, which makes them the worst possible reason
  // for a citation to be rejected.
  [/[​‌‍﻿]/g, ''],
];

const fold = (text: string): string =>
  TYPOGRAPHY.reduce((out, [pattern, plain]) => out.replace(pattern, plain), text);

/** Filings wrap lines; a quote copied across a wrap is still the same quote. */
const squeeze = (text: string): string => fold(text).replace(/\s+/g, ' ').trim();

export function quoteIsContained(quote: string, chunkText: string): boolean {
  return chunkText.includes(quote) || squeeze(chunkText).includes(squeeze(quote));
}

/**
 * Numbers as written, normalised for comparison: thousands separators dropped,
 * trailing zeros after a decimal point dropped, so 45,455 and 45455 are the
 * same number and 1.50 matches 1.5.
 */
export function numbersIn(text: string): string[] {
  const found = text.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  return found.map(normaliseNumber).filter((n) => n !== '');
}

function normaliseNumber(raw: string): string {
  const plain = raw.replace(/,/g, '');
  if (!plain.includes('.')) return plain.replace(/^0+(?=\d)/, '');
  return plain.replace(/0+$/, '').replace(/\.$/, '').replace(/^0+(?=\d)/, '');
}

/**
 * A four-digit number in this range is almost always a year, and a year is
 * routinely stated in a sentence without appearing in the quoted span.
 */
// ponytail: year heuristic by range; if a real metric ever lands between 1900
// and 2100 it is skipped rather than checked, so tighten only if that bites.
function looksLikeAYear(value: string): boolean {
  if (!/^\d{4}$/.test(value)) return false;
  const year = Number(value);
  return year >= 1900 && year <= 2100;
}

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|' +
  'sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

/**
 * Digits that name something rather than count it: the day in "June 30", an
 * ISO date, the 3 in "Q3", the 10 in "10-K". A statement dates itself and names
 * its source this way all the time and the quote it cites almost never repeats
 * either, so counting them as metrics failed the Ramaco run on "the six months
 * to June 30" and "the 10-K states".
 */
// ponytail: a number glued to a month ("in May 5 million tons") is read as a
// day and skipped rather than checked; tighten if that ever hides a figure.
const NOT_QUANTITIES: readonly RegExp[] = [
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'gi'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}\\b`, 'gi'),
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b[QH][1-4]\b/g,
  /\b(?:10-[KQ]|8-K|6-K|20-F|40-F|[SF]-[134])\b/gi,
];

const withoutLabels = (text: string): string =>
  NOT_QUANTITIES.reduce((out, pattern) => out.replace(pattern, ' '), text);

const SCALES: Readonly<Record<string, number>> = {
  thousand: 1e3,
  k: 1e3,
  million: 1e6,
  mn: 1e6,
  m: 1e6,
  billion: 1e9,
  bn: 1e9,
};

/**
 * Numbers written with a scale -- "$55.96 million", "22.4m" -- as the value
 * they denote and how far off a true value may be and still be written that
 * way. A fact is stored at full scale, so "55.96 million" has to be compared
 * as 55,960,000 give or take half a unit in its last digit, not as the string
 * "55.96". Bare "b" is left out: it is a unit as often as it is a billion.
 */
function scaledNumbersIn(text: string): { normalised: string; value: number; tolerance: number }[] {
  // A range written once with its scale -- "$648.6-$657.0 million" -- scales
  // both ends; the lower one has no word of its own after it.
  const found = text.matchAll(
    /(\d[\d,]*(?:\.\d+)?)(?:\s*(?:[-–—]|to)\s*\$?(\d[\d,]*(?:\.\d+)?))?\s*(thousand|million|billion|mn|bn|m|k)\b/gi,
  );
  return [...found].flatMap((match) => {
    const scale = SCALES[match[3]!.toLowerCase()]!;
    return [match[1], match[2]]
      .filter((raw): raw is string => raw !== undefined)
      .map((raw) => ({
        normalised: normaliseNumber(raw),
        value: Number(raw.replace(/,/g, '')) * scale,
        tolerance: (0.5 * scale) / 10 ** (raw.split('.')[1]?.length ?? 0),
      }));
  });
}

const UNIT_WORDS = (
  'zero one two three four five six seven eight nine ten eleven twelve thirteen ' +
  'fourteen fifteen sixteen seventeen eighteen nineteen twenty'
).split(' ');
const TENS_WORDS = ['thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(UNIT_WORDS.map((word, n) => [word, String(n)])),
  ...Object.fromEntries(TENS_WORDS.map((word, i) => [word, String(30 + 10 * i)])),
};

/**
 * A filing spells small numbers out -- "approximately four million clean
 * tons" -- and a statement copying the fact writes the digit. Read on the
 * evidence side only, so it can let a spelled-out number through and never
 * invent one in a statement.
 */
const withDigits = (text: string): string =>
  text.replace(/\b[a-z]+\b/gi, (word) => NUMBER_WORDS[word.toLowerCase()] ?? word);

function pass(type: CheckType, claimId: UUID, message: string): CheckResult {
  return { type, status: 'passed', severity: 'info', claimId, message, evidence: {} };
}

/**
 * Every number in a statement has to come from somewhere the claim cites. A
 * number the evidence does not contain was produced by the model, and a
 * produced number is the failure this whole system exists to prevent.
 */
function checkNumbers(claim: VerifiableClaim): CheckResult {
  const cited = new Set<string>();
  // The same evidence as values, for the scaled comparison. Magnitudes only: a
  // loss is stored negative and stated as "a loss of $55.96 million".
  const values: number[] = [];
  for (const ref of claim.evidence) {
    const quote = withDigits(ref.quote ?? '');
    for (const number of numbersIn(quote)) {
      cited.add(number);
      values.push(Number(number));
    }
    for (const scaled of scaledNumbersIn(quote)) values.push(scaled.value);
    for (const number of numbersIn(ref.factValue ?? '')) {
      cited.add(number);
      values.push(Number(number));
    }
  }

  const statement = withoutLabels(claim.statement);
  const scaledHits = new Set(
    scaledNumbersIn(statement)
      .filter((scaled) => values.some((value) => Math.abs(value - scaled.value) <= scaled.tolerance))
      .map((scaled) => scaled.normalised),
  );

  const missing = numbersIn(statement)
    .filter((number) => !looksLikeAYear(number))
    .filter((number) => !scaledHits.has(number))
    .filter((number) => !cited.has(number) && ![...cited].some((c) => c.startsWith(number)));

  if (missing.length === 0) {
    return pass('number_vs_fact', claim.claimId, 'every number in the statement is in the evidence');
  }
  return {
    type: 'number_vs_fact',
    status: 'failed',
    severity: 'error',
    claimId: claim.claimId,
    message: `statement contains ${missing.join(', ')}, which the cited evidence does not`,
    evidence: { missing },
  };
}

/** Four digits in a range no metric of this domain occupies. */
function yearsIn(text: string): string[] {
  const found = text.match(/\b(19|20)\d{2}\b/g) ?? [];
  return [...new Set(found)];
}

/**
 * Temporal correctness. A statement that names a year has attributed itself to
 * a period, and the evidence has to be about that period. This is the other
 * half of the number rule, which skips four-digit years precisely because they
 * are usually stated in a sentence without appearing in the quoted span; the
 * years it drops are picked up here, against the dates the cited rows carry as
 * well as their text.
 *
 * Warning rather than error, and that is not timidity. A filing says "the year
 * ended December 31, 2025" where a claim says "in fiscal 2025", and both are
 * right; the rule cannot tell that case from a misattributed one, so it reports
 * rather than demotes. The eval dataset is what measures how often it is right.
 */
function checkDates(claim: VerifiableClaim): CheckResult {
  const stated = yearsIn(claim.statement);
  if (stated.length === 0) {
    return { type: 'date_consistency', status: 'skipped', severity: 'info', claimId: claim.claimId,
      message: 'the statement names no year', evidence: {} };
  }

  const cited = new Set<string>();
  for (const ref of claim.evidence) {
    for (const year of yearsIn(ref.quote ?? '')) cited.add(year);
    for (const year of yearsIn(ref.factValue ?? '')) cited.add(year);
    for (const year of yearsIn(ref.periodEnd ?? '')) cited.add(year);
  }

  const missing = stated.filter((year) => !cited.has(year));
  if (missing.length === 0) {
    return pass('date_consistency', claim.claimId, 'every year in the statement is in the evidence');
  }
  return {
    type: 'date_consistency',
    status: 'failed',
    severity: 'warning',
    claimId: claim.claimId,
    message: `statement is about ${missing.join(', ')}, which the cited evidence is not`,
    evidence: { missing, cited: [...cited] },
  };
}

function checkTier(claim: VerifiableClaim): CheckResult {
  const tiers = claim.evidence.map((ref) => ref.sourceTier).filter((tier): tier is number => tier !== null);
  const facts = claim.evidence.filter((ref) => ref.factVersionId !== null).length;

  if (tiers.length === 0 && facts > 0) {
    return pass('source_tier', claim.claimId, 'rests on promoted facts, which carry their own provenance');
  }
  if (tiers.length === 0) {
    return { type: 'source_tier', status: 'skipped', severity: 'info', claimId: claim.claimId,
      message: 'no cited source has a tier', evidence: {} };
  }

  const best = Math.min(...tiers);
  if (best < WEAK_TIER) {
    return pass('source_tier', claim.claimId, `strongest cited source is tier ${best}`);
  }
  // A financial number resting only on commentary is wrong even when the quote
  // is real: the source is not one that can be held to it (report G).
  const financial = FINANCIAL_CLAIM_TYPES.has(claim.claimType);
  return {
    type: 'source_tier',
    status: 'failed',
    severity: financial ? 'error' : 'warning',
    claimId: claim.claimId,
    message: `every cited source is tier ${best}${financial ? ', which may not carry a financial claim' : ''}`,
    evidence: { tiers },
  };
}

function checkQuotes(claim: VerifiableClaim): CheckResult[] {
  const results: CheckResult[] = [];
  for (const ref of claim.evidence) {
    if (ref.chunkId === null) continue;
    if (ref.chunkText === null) {
      results.push({ type: 'quote_containment', status: 'failed', severity: 'critical', claimId: claim.claimId,
        message: `cited chunk ${ref.chunkId} does not exist`, evidence: { chunkId: ref.chunkId } });
      continue;
    }
    if (!ref.quote) {
      results.push({ type: 'quote_containment', status: 'failed', severity: 'error', claimId: claim.claimId,
        message: `cites chunk ${ref.chunkId} with no quote`, evidence: { chunkId: ref.chunkId } });
      continue;
    }
    results.push(
      quoteIsContained(ref.quote, ref.chunkText)
        ? pass('quote_containment', claim.claimId, 'the quote is in the chunk it cites')
        : {
            type: 'quote_containment',
            status: 'failed',
            severity: 'critical',
            claimId: claim.claimId,
            message: `the quote is not in chunk ${ref.chunkId}`,
            evidence: { chunkId: ref.chunkId, quote: ref.quote },
          },
    );
  }
  return results;
}

/**
 * Two claims sharing a claim_key are two answers to the same question. Equal
 * statements are one answer recorded twice; different statements are a
 * disagreement, and the system records disagreements rather than picking.
 */
function checkContradictions(claims: VerifiableClaim[]): CheckResult[] {
  const byKey = new Map<string, VerifiableClaim[]>();
  for (const claim of claims) {
    const group = byKey.get(claim.claimKey) ?? [];
    group.push(claim);
    byKey.set(claim.claimKey, group);
  }

  const results: CheckResult[] = [];
  for (const [key, group] of byKey) {
    const statements = new Set(group.map((claim) => claim.statement.trim()));

    // A verdict for every claim, including the clean ones. Emitting a row only
    // on failure would leave "checked, nothing disagreed" and "this rule never
    // ran" looking identical in research.verification_checks, and a stored
    // check is the evidence that the check happened.
    if (group.length < 2) {
      results.push({ type: 'contradiction', status: 'skipped', severity: 'info',
        claimId: group[0]!.claimId, message: `nothing else answers ${key}`, evidence: { claimKey: key } });
      continue;
    }
    if (statements.size < 2) {
      for (const claim of group) {
        results.push(pass('contradiction', claim.claimId, `${group.length} claims agree on ${key}`));
      }
      continue;
    }
    for (const claim of group) {
      results.push({
        type: 'contradiction',
        status: 'failed',
        severity: 'error',
        claimId: claim.claimId,
        message: `${group.length} claims share the key ${key} and do not agree`,
        evidence: { claimKey: key, statements: [...statements] },
      });
    }
  }
  return results;
}

export interface VerificationVerdict {
  checks: CheckResult[];
  /** Claims a failure makes untrustworthy, so their status has to change. */
  contradicted: UUID[];
  overall: 'passed' | 'warnings' | 'failed';
}

export function verifyClaims(claims: VerifiableClaim[]): VerificationVerdict {
  const checks: CheckResult[] = [];
  for (const claim of claims) {
    checks.push(...checkQuotes(claim));
    checks.push(checkNumbers(claim));
    checks.push(checkDates(claim));
    checks.push(checkTier(claim));
  }
  checks.push(...checkContradictions(claims));

  const failed = checks.filter((check) => check.status === 'failed');
  const serious = failed.filter((check) => check.severity === 'error' || check.severity === 'critical');

  return {
    checks,
    contradicted: [...new Set(serious.map((check) => check.claimId))],
    overall: serious.length > 0 ? 'failed' : failed.length > 0 ? 'warnings' : 'passed',
  };
}
