import { readFileSync } from 'node:fs';
import { parseCompanyFacts, type XbrlFactCandidate } from '@mineral/ingest';
import { verifyClaims, type VerifiableClaim, type VerifiableEvidence } from '@mineral/research';
import { score, type Outcome, type Score } from './score.ts';

/**
 * The eval suites (report J.12). Each one turns a labelled dataset into
 * outcomes, which `score` turns into a number.
 *
 * Both suites are hermetic. They call the same functions the pipeline calls,
 * with no model and no network, so they can run on every pull request; that is
 * what "eval suite runs in CI" has to mean in a repository whose CI has no API
 * key. What they measure is the deterministic layer: the rules that decide
 * whether a claim is trustworthy, and the map that reads a figure out of XBRL.
 * Scoring the judgement of a model needs cached model runs, and belongs to the
 * phase that has a key to record them with.
 */

export interface SuiteResult {
  dataset: string;
  version: string;
  target: string;
  minAccuracy: number;
  score: Score;
  passed: boolean;
}

export function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

// --- verification -----------------------------------------------------------

interface CaseEvidence {
  quote?: string | null;
  chunkText?: string | null;
  sourceTier?: number | null;
  factVersionId?: string | null;
  factValue?: string | null;
  periodEnd?: string | null;
}

interface CaseClaim {
  claimKey?: string;
  claimType: string;
  statement: string;
  evidence: CaseEvidence[];
}

interface VerificationCase {
  id: string;
  group: string;
  expect: string;
  claim?: CaseClaim;
  claims?: CaseClaim[];
}

interface VerificationDataset {
  dataset: string;
  version: string;
  target: string;
  minAccuracy: number;
  cases: VerificationCase[];
}

/** A dataset writes only what a case is about; the rest takes its null. */
function toEvidence(ref: CaseEvidence, index: number): VerifiableEvidence {
  const citesFact = ref.factVersionId !== undefined && ref.factVersionId !== null;
  return {
    chunkId: citesFact ? null : `chunk-${index}`,
    factVersionId: ref.factVersionId ?? null,
    quote: ref.quote ?? null,
    chunkText: ref.chunkText === undefined ? null : ref.chunkText,
    sourceTier: ref.sourceTier ?? null,
    factValue: ref.factValue ?? null,
    periodEnd: ref.periodEnd ?? null,
  };
}

function toClaim(claim: CaseClaim, id: string, index: number): VerifiableClaim {
  return {
    claimId: `${id}-${index}`,
    claimKey: claim.claimKey ?? `${id}-key`,
    claimType: claim.claimType,
    statement: claim.statement,
    status: 'DERIVED',
    evidence: claim.evidence.map(toEvidence),
  };
}

/**
 * The verdict the named rule reached for one case.
 *
 * A rule that emits one check per citation can fail on one and pass on another,
 * so a failure anywhere is the verdict: a claim is not half cited. Where the
 * rule emitted nothing at all the case counts as `absent`, which matches no
 * expected value and so is always a miss. A rule that has silently stopped
 * running has to score zero rather than disappear.
 */
function verdictFor(claims: VerifiableClaim[], group: string): string {
  const checks = verifyClaims(claims).checks.filter((check) => check.type === group);
  if (checks.length === 0) return 'absent';
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => check.status === 'passed')) return 'passed';
  return 'skipped';
}

export function runVerification(path: string): SuiteResult {
  const data = loadJson<VerificationDataset>(path);
  const outcomes: Outcome[] = data.cases.map((testCase) => {
    const claims = (testCase.claims ?? (testCase.claim ? [testCase.claim] : [])).map(
      (claim, index) => toClaim(claim, testCase.id, index),
    );
    return {
      id: testCase.id,
      group: testCase.group,
      expected: testCase.expect,
      actual: verdictFor(claims, testCase.group),
    };
  });

  const result = score(outcomes);
  return {
    dataset: data.dataset,
    version: data.version,
    target: data.target,
    minAccuracy: data.minAccuracy,
    score: result,
    passed: result.accuracy >= data.minAccuracy,
  };
}

// --- extraction against XBRL ------------------------------------------------

interface ExpectedCandidate {
  code: string;
  concept: string;
  value: number;
  unit: string;
  periodStart?: string;
  periodEnd?: string;
  asOfDate?: string;
}

interface ExtractionCase {
  id: string;
  expected: ExpectedCandidate[];
  companyfacts: unknown;
  options?: { since?: string; units?: string[] };
}

interface ExtractionDataset {
  dataset: string;
  version: string;
  target: string;
  minAccuracy: number;
  cases: ExtractionCase[];
}

/** Identity of one observation: the code, the value and the slice of time. */
function key(candidate: ExpectedCandidate | XbrlFactCandidate): string {
  return [
    candidate.code,
    candidate.concept,
    candidate.value,
    candidate.unit,
    candidate.periodStart ?? '',
    candidate.periodEnd ?? '',
    candidate.asOfDate ?? '',
  ].join('|');
}

/**
 * A case passes only on an exact match of the whole set. A missing figure and
 * an invented one are failures of the same kind here, and grading them
 * partially would let a parser that returns everything score well.
 */
export function runExtraction(path: string): SuiteResult {
  const data = loadJson<ExtractionDataset>(path);
  const outcomes: Outcome[] = data.cases.map((testCase) => {
    let actual: string;
    try {
      const produced = parseCompanyFacts(testCase.companyfacts, testCase.options ?? {});
      const got = produced.map(key).sort();
      const want = testCase.expected.map(key).sort();
      actual =
        got.length === want.length && got.every((value, index) => value === want[index])
          ? 'passed'
          : `mismatch: ${JSON.stringify(got)}`;
    } catch (error) {
      actual = `threw: ${error instanceof Error ? error.message : String(error)}`;
    }
    return { id: testCase.id, group: 'xbrl_extraction', expected: 'passed', actual };
  });

  const result = score(outcomes);
  return {
    dataset: data.dataset,
    version: data.version,
    target: data.target,
    minAccuracy: data.minAccuracy,
    score: result,
    passed: result.accuracy >= data.minAccuracy,
  };
}
