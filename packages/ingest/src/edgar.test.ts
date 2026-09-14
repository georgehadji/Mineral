import { describe, expect, it } from 'vitest';
import { companyFactsUrl, filingDocumentUrl, parseSubmissions, submissionsUrl } from './edgar.ts';

const submissions = {
  cik: '1801368',
  name: 'MP Materials Corp. / DE',
  filings: {
    recent: {
      accessionNumber: ['0001801368-25-000010', '0001801368-25-000004', '0001801368-24-000030'],
      form: ['10-Q', '10-K', '8-K'],
      filingDate: ['2025-05-08', '2025-02-20', '2024-11-01'],
      reportDate: ['2025-03-31', '2024-12-31', null],
      primaryDocument: ['mp-20250331.htm', 'mp-20241231.htm', ''],
    },
  },
};

describe('EDGAR urls', () => {
  it('pads the CIK for the JSON APIs and unpads it for the archive path', () => {
    expect(submissionsUrl('1801368')).toBe('https://data.sec.gov/submissions/CIK0001801368.json');
    expect(companyFactsUrl('CIK-1801368')).toBe(
      'https://data.sec.gov/api/xbrl/companyfacts/CIK0001801368.json',
    );
    expect(filingDocumentUrl('0001801368', '0001801368-25-000004', 'mp-20241231.htm')).toBe(
      'https://www.sec.gov/Archives/edgar/data/1801368/000180136825000004/mp-20241231.htm',
    );
  });

  it('rejects anything that is not a CIK', () => {
    expect(() => submissionsUrl('MP')).toThrow(/not a CIK/);
  });
});

describe('parseSubmissions', () => {
  it('filters by form and keeps the newest first', () => {
    const filings = parseSubmissions(submissions, { forms: ['10-K', '10-Q'] });
    expect(filings.map((f) => f.form)).toEqual(['10-Q', '10-K']);
    expect(filings[0]?.documentUrl).toContain('/000180136825000010/mp-20250331.htm');
    expect(filings[0]?.title).toBe('MP Materials Corp. / DE 10-Q 2025-03-31');
  });

  it('applies the limit after sorting', () => {
    expect(parseSubmissions(submissions, { limit: 1 })[0]?.accession).toBe('0001801368-25-000010');
  });

  it('drops rows with no primary document rather than half-storing them', () => {
    expect(parseSubmissions(submissions).map((f) => f.form)).toEqual(['10-Q', '10-K']);
  });

  it('rejects a payload with no filings block', () => {
    expect(() => parseSubmissions({ cik: '1801368' })).toThrow(/no filings.recent/);
  });
});
