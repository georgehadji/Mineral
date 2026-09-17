import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { score, type Outcome } from './score.ts';
import { runExtraction, runVerification } from './suites.ts';

/**
 * The harness has to be trustworthy before its scores mean anything. These
 * check the scorer against cases where the right answer is obvious, and then
 * check that the shipped datasets still clear the thresholds they carry, which
 * is the same thing `pnpm eval` gates on.
 */

const datasets = fileURLToPath(new URL('../datasets/', import.meta.url));

const outcome = (over: Partial<Outcome> = {}): Outcome => ({
  id: 'case',
  group: 'rule',
  expected: 'passed',
  actual: 'passed',
  ...over,
});

describe('score', () => {
  it('scores an empty dataset zero, not one', () => {
    // "Nothing was checked" must never read as "everything passed".
    expect(score([]).accuracy).toBe(0);
  });

  it('counts a case correct only when the verdicts match', () => {
    const result = score([outcome({ id: 'a' }), outcome({ id: 'b', actual: 'failed' })]);
    expect(result.correct).toBe(1);
    expect(result.accuracy).toBe(0.5);
    expect(result.misses.map((miss) => miss.id)).toEqual(['b']);
  });

  it('gives a rule that fires on everything perfect recall and poor precision', () => {
    const result = score([
      outcome({ id: 'real', expected: 'failed', actual: 'failed' }),
      outcome({ id: 'clean-1', expected: 'passed', actual: 'failed' }),
      outcome({ id: 'clean-2', expected: 'passed', actual: 'failed' }),
    ]);
    const group = result.groups[0]!;
    expect(group.recall).toBe(1);
    expect(group.precision).toBeCloseTo(1 / 3, 6);
  });

  it('gives a rule that never fires no recall at all', () => {
    const result = score([
      outcome({ id: 'missed', expected: 'failed', actual: 'passed' }),
      outcome({ id: 'clean', expected: 'passed', actual: 'passed' }),
    ]);
    const group = result.groups[0]!;
    expect(group.recall).toBe(0);
    // Nothing was reported, so there is no precision to report either.
    expect(group.precision).toBeNull();
  });

  it('keeps rules apart', () => {
    const result = score([
      outcome({ id: 'a', group: 'quote_containment' }),
      outcome({ id: 'b', group: 'source_tier', actual: 'failed' }),
    ]);
    expect(result.groups.map((group) => group.group)).toEqual(['quote_containment', 'source_tier']);
    expect(result.groups[0]!.accuracy).toBe(1);
    expect(result.groups[1]!.accuracy).toBe(0);
  });
});

describe('the shipped datasets', () => {
  it('scores the verification rules at or above the threshold they carry', () => {
    const result = runVerification(`${datasets}verification-v1.json`);
    expect(result.score.misses).toEqual([]);
    expect(result.score.accuracy).toBeGreaterThanOrEqual(result.minAccuracy);
    expect(result.passed).toBe(true);
  });

  it('covers every rule the verifier implements', () => {
    const result = runVerification(`${datasets}verification-v1.json`);
    const covered = result.score.groups.map((group) => group.group).sort();
    expect(covered).toEqual([
      'contradiction',
      'date_consistency',
      'number_vs_fact',
      'quote_containment',
      'source_tier',
    ]);
    // A rule measured only on cases it should fail proves nothing about false
    // positives, so every rule carries more than one case.
    for (const group of result.score.groups) {
      expect(group.cases, `${group.group} has too few cases to mean anything`).toBeGreaterThan(1);
    }
  });

  it('scores extraction against XBRL at or above its threshold', () => {
    const result = runExtraction(`${datasets}extraction-v1.json`);
    expect(result.score.misses).toEqual([]);
    expect(result.passed).toBe(true);
  });
});
