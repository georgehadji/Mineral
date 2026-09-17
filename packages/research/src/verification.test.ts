import { describe, expect, it } from 'vitest';
import { numbersIn, quoteIsContained, verifyClaims, type VerifiableClaim } from './verification.ts';

const CHUNK =
  'Mountain Pass is the only operating rare earth mine in North America.\nThe Company produced\n' +
  '45,455 metric tons of rare earth oxide in concentrate during 2024.';

const claim = (over: Partial<VerifiableClaim> = {}): VerifiableClaim => ({
  claimId: '11111111-1111-1111-1111-111111111111',
  claimKey: 'production_volume',
  claimType: 'business_fact',
  statement: 'The company produced 45,455 metric tons of rare earth oxide in 2024.',
  status: 'DERIVED',
  evidence: [
    {
      chunkId: '22222222-2222-2222-2222-222222222222',
      factVersionId: null,
      quote: 'The Company produced 45,455 metric tons of rare earth oxide in concentrate',
      chunkText: CHUNK,
      sourceTier: 1,
      factValue: null,
      periodEnd: '2024-12-31',
    },
  ],
  ...over,
});

const find = (claims: VerifiableClaim[], type: string) =>
  verifyClaims(claims).checks.filter((check) => check.type === type);

describe('quote containment', () => {
  it('accepts a quote that spans a line wrap in the stored text', () => {
    expect(quoteIsContained('The Company produced 45,455 metric tons', CHUNK)).toBe(true);
  });

  it('rejects a quote that is not in the chunk', () => {
    expect(quoteIsContained('The Company produced 90,000 metric tons', CHUNK)).toBe(false);
  });

  it('fails the check and marks the claim contradicted', () => {
    const bad = claim({
      evidence: [{ ...claim().evidence[0]!, quote: 'The Company produced 90,000 metric tons' }],
    });
    const verdict = verifyClaims([bad]);
    expect(verdict.overall).toBe('failed');
    expect(verdict.contradicted).toEqual([bad.claimId]);
    expect(find([bad], 'quote_containment')[0]).toMatchObject({ status: 'failed', severity: 'critical' });
  });

  it('treats a missing chunk as critical rather than absent', () => {
    const orphan = claim({ evidence: [{ ...claim().evidence[0]!, chunkText: null }] });
    expect(find([orphan], 'quote_containment')[0]).toMatchObject({
      status: 'failed',
      severity: 'critical',
    });
  });
});

describe('numbers against evidence', () => {
  it('normalises separators and trailing zeros', () => {
    expect(numbersIn('45,455 tons at 1.50 each')).toEqual(['45455', '1.5']);
  });

  it('passes when every number is in the quote', () => {
    expect(find([claim()], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });

  it('fails a number the evidence does not contain', () => {
    const invented = claim({ statement: 'The company produced 90,000 metric tons.' });
    expect(find([invented], 'number_vs_fact')[0]).toMatchObject({
      status: 'failed',
      severity: 'error',
      message: expect.stringContaining('90000'),
    });
  });

  it('does not demand that a year appear in the quote', () => {
    const dated = claim({
      statement: 'In 2023 the company produced 45,455 metric tons.',
      evidence: [{ ...claim().evidence[0]! }],
    });
    expect(find([dated], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });

  it('accepts a number that comes from a cited fact instead of a quote', () => {
    const fromFact = claim({
      statement: 'Revenue was 253400000 for the year.',
      evidence: [
        {
          chunkId: null,
          factVersionId: '33333333-3333-3333-3333-333333333333',
          quote: null,
          chunkText: null,
          sourceTier: null,
          factValue: '253400000',
          periodEnd: null,
        },
      ],
    });
    expect(find([fromFact], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });
});

describe('source tier', () => {
  it('passes a claim resting on a primary source', () => {
    expect(find([claim()], 'source_tier')[0]).toMatchObject({ status: 'passed' });
  });

  it('warns when a business claim rests only on commentary', () => {
    const weak = claim({ evidence: [{ ...claim().evidence[0]!, sourceTier: 4 }] });
    expect(find([weak], 'source_tier')[0]).toMatchObject({ status: 'failed', severity: 'warning' });
    // A warning is not a demotion: the quote is real, the source is just weak.
    expect(verifyClaims([weak]).contradicted).toEqual([]);
    expect(verifyClaims([weak]).overall).toBe('warnings');
  });

  it('refuses a financial claim resting only on commentary', () => {
    const weak = claim({ claimType: 'metric', evidence: [{ ...claim().evidence[0]!, sourceTier: 5 }] });
    expect(find([weak], 'source_tier')[0]).toMatchObject({ status: 'failed', severity: 'error' });
    expect(verifyClaims([weak]).contradicted).toEqual([weak.claimId]);
  });

  it('accepts a promoted fact as carrying its own provenance', () => {
    const fromFact = claim({
      statement: 'Revenue was reported for the year.',
      evidence: [
        { chunkId: null, factVersionId: '44444444-4444-4444-4444-444444444444', quote: null,
          chunkText: null, sourceTier: null, factValue: '1', periodEnd: null },
      ],
    });
    expect(find([fromFact], 'source_tier')[0]).toMatchObject({ status: 'passed' });
  });
});

describe('contradiction on a shared claim key', () => {
  const other = (over: Partial<VerifiableClaim>) =>
    claim({ claimId: '55555555-5555-5555-5555-555555555555', ...over });

  it('flags two different answers to the same question', () => {
    const verdict = verifyClaims([claim(), other({ statement: 'The company produced nothing.' })]);
    const contradictions = verdict.checks.filter((check) => check.type === 'contradiction');
    expect(contradictions).toHaveLength(2);
    expect(verdict.overall).toBe('failed');
  });

  it('records agreement rather than silence when the same answer is recorded twice', () => {
    const verdict = verifyClaims([claim(), other({})]);
    const contradictions = verdict.checks.filter((check) => check.type === 'contradiction');
    // A row per claim, passed. Emitting nothing would make "checked, nothing
    // disagreed" and "this rule never ran" identical in the stored checks.
    expect(contradictions).toHaveLength(2);
    expect(contradictions.every((check) => check.status === 'passed')).toBe(true);
    expect(verdict.overall).toBe('passed');
  });

  it('does not flag different keys that happen to disagree', () => {
    const verdict = verifyClaims([
      claim(),
      other({ claimKey: 'revenue_concentration', statement: 'The company produced nothing.',
        evidence: [{ ...claim().evidence[0]! }] }),
    ]);
    const contradictions = verdict.checks.filter((check) => check.type === 'contradiction');
    expect(contradictions.every((check) => check.status === 'skipped')).toBe(true);
    expect(verdict.overall).not.toBe('failed');
  });

  it('says a claim nobody else answers was checked and skipped', () => {
    const contradictions = find([claim()], 'contradiction');
    expect(contradictions).toHaveLength(1);
    expect(contradictions[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('temporal correctness', () => {
  it('accepts a year the quote states', () => {
    expect(find([claim()], 'date_consistency')[0]).toMatchObject({ status: 'passed' });
  });

  it('accepts a year carried by the cited period rather than by the quote', () => {
    const dated = claim({
      statement: 'Production rose over the 2024 financial year.',
      evidence: [
        {
          chunkId: '22222222-2222-2222-2222-222222222222',
          factVersionId: null,
          quote: 'Production rose over the financial year',
          chunkText: 'Production rose over the financial year on higher throughput.',
          sourceTier: 1,
          factValue: null,
          periodEnd: '2024-12-31',
        },
      ],
    });
    expect(find([dated], 'date_consistency')[0]).toMatchObject({ status: 'passed' });
  });

  it('flags a year no cited evidence is about', () => {
    const misdated = claim({ statement: 'The company produced 45,455 metric tons in 2019.' });
    expect(find([misdated], 'date_consistency')[0]).toMatchObject({
      status: 'failed',
      severity: 'warning',
    });
  });

  it('reports rather than demotes, so a date alone never contradicts a claim', () => {
    const misdated = claim({ statement: 'The company produced 45,455 metric tons in 2019.' });
    const verdict = verifyClaims([misdated]);
    expect(verdict.contradicted).toEqual([]);
    expect(verdict.overall).toBe('warnings');
  });

  it('skips a statement that names no year', () => {
    const undated = claim({ statement: 'The company operates one separation facility.' });
    expect(find([undated], 'date_consistency')[0]).toMatchObject({ status: 'skipped' });
  });

  it('picks up exactly what the number rule drops', () => {
    const misdated = claim({ statement: 'The company produced 45,455 metric tons in 2019.' });
    // The number rule skips four-digit years on purpose; without this rule a
    // misattributed period would pass every check unremarked.
    expect(find([misdated], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
    expect(find([misdated], 'date_consistency')[0]).toMatchObject({ status: 'failed' });
  });
});

describe('the overall verdict', () => {
  it('passes a clean claim', () => {
    expect(verifyClaims([claim()]).overall).toBe('passed');
  });

  it('checks nothing and passes when there are no claims', () => {
    expect(verifyClaims([])).toEqual({ checks: [], contradicted: [], overall: 'passed' });
  });
});
