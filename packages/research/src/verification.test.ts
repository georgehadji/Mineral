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

  /**
   * From a real Ramaco 10-K: the filing is typeset with curly quotes and the
   * model returned the plain ones. Every word matched and the run still died.
   */
  it('accepts a faithful quote whose typography was flattened', () => {
    const typeset =
      'Ramaco Resources, Inc. (the “Company,” “Ramaco”) is a Delaware' +
      ' corporation formed in October 2016 — see Note‑1.';
    const asTheModelReturnedIt =
      'Ramaco Resources, Inc. (the "Company," "Ramaco") is a Delaware corporation formed in' +
      ' October 2016 - see Note-1.';
    expect(quoteIsContained(asTheModelReturnedIt, typeset)).toBe(true);
  });

  it('still rejects a paraphrase of the same sentence', () => {
    // The guard on the rule above: folding a glyph must not fold a word.
    const typeset = 'The Company “produced” 45,455 metric tons of oxide.';
    expect(quoteIsContained('The Company made 45,455 metric tons of oxide.', typeset)).toBe(false);
    expect(quoteIsContained('The Company "produced" 45,455 metric tons', typeset)).toBe(true);
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

  const factCitation = (factValue: string) => ({
    chunkId: null,
    factVersionId: '33333333-3333-3333-3333-333333333333',
    quote: null,
    chunkText: null,
    sourceTier: null,
    factValue,
    periodEnd: null,
  });

  /**
   * From the Ramaco run: the fact is stored at full scale and the statement
   * says it in millions. 161.0 million passed only because "161000000" happens
   * to begin with "161"; 55.96 and 22.4 failed although the fact they cite is
   * exactly the one they state.
   */
  it('accepts a cited fact stated in millions to the precision it was written', () => {
    const stated = claim({
      statement: 'An operating loss of $55.96 million, and operating cash flow of -$22.4m.',
      evidence: [factCitation('-55963000.000000000000'), factCitation('-22430000')],
    });
    expect(find([stated], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });

  it('still fails a scaled number the cited fact does not round to', () => {
    const wrong = claim({
      statement: 'An operating loss of $58.0 million.',
      evidence: [factCitation('-55963000')],
    });
    expect(find([wrong], 'number_vs_fact')[0]).toMatchObject({
      status: 'failed',
      message: expect.stringContaining('58'),
    });
  });

  // From the second Ramaco run: the scale word follows only the upper end.
  it('scales both ends of a range the scale word follows', () => {
    const range = claim({
      statement: 'Total liabilities of $648.6-$657.0 million in the latest two quarters.',
      evidence: [factCitation('648611000'), factCitation('657003000')],
    });
    expect(find([range], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });

  // Filings spell small numbers out; a statement writes the digit.
  it('matches a digit against the number the filing spelled out', () => {
    const spelled = claim({
      statement: 'Capacity is about 4 million clean tons.',
      evidence: [
        {
          ...claim().evidence[0]!,
          quote: 'our estimated aggregate annual production capacity is approximately four million clean tons',
        },
      ],
    });
    expect(find([spelled], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
  });

  it('does not read a day of the month, a quarter or a form name as a metric', () => {
    const dated = claim({
      statement:
        'In the six months to June 30, 2026 the company produced 45,455 metric tons, ' +
        'priced in contracts negotiated in Q3/Q4, as the 10-K states.',
    });
    expect(find([dated], 'number_vs_fact')[0]).toMatchObject({ status: 'passed' });
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

  // From the Ramaco run: two modules, one answer, two lengths of sentence.
  it('records different wording around the same figure as a warning, not a contradiction', () => {
    const verdict = verifyClaims([
      claim({ statement: 'Three customers accounted for approximately 34% of total revenue in 2025.' }),
      other({
        statement:
          'Revenue depends on a handful of buyers: sales to three customers were about 34% of ' +
          'revenue, so losing one contract would be the visible trigger.',
      }),
    ]);
    const contradictions = verdict.checks.filter((check) => check.type === 'contradiction');
    expect(contradictions).toHaveLength(2);
    expect(contradictions.every((check) => check.severity === 'warning')).toBe(true);
  });

  it('still flags two answers that state different figures', () => {
    const verdict = verifyClaims([
      claim({ statement: 'Three customers accounted for approximately 34% of total revenue.' }),
      other({ statement: 'Three customers accounted for approximately 41% of total revenue.' }),
    ]);
    const contradictions = verdict.checks.filter((check) => check.type === 'contradiction');
    expect(contradictions.every((check) => check.severity === 'error')).toBe(true);
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
