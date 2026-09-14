/**
 * SEC EDGAR connector. Provider specifics (URL shapes, the column-array JSON
 * layout, the User-Agent policy) stay inside this adapter; callers see filings
 * and bytes.
 */

/** Registry row for EDGAR. Tier 1: the filer's own regulatory submission. */
export const EDGAR_SOURCE = {
  sourceName: 'SEC EDGAR',
  sourceType: 'regulatory_filing',
  sourceTier: 1 as const,
  publisher: 'U.S. Securities and Exchange Commission',
  baseUrl: 'https://www.sec.gov',
};

export const COMPANY_FACTS_DOCUMENT_TYPE = 'xbrl_company_facts';

function padCik(cik: string): string {
  const digits = cik.replace(/[^0-9]/g, '');
  if (digits === '' || digits.length > 10) throw new Error(`not a CIK: ${cik}`);
  return digits.padStart(10, '0');
}

export function submissionsUrl(cik: string): string {
  return `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`;
}

export function companyFactsUrl(cik: string): string {
  return `https://data.sec.gov/api/xbrl/companyfacts/CIK${padCik(cik)}.json`;
}

/** EDGAR archive paths use the unpadded CIK and the accession without dashes. */
export function filingDocumentUrl(cik: string, accession: string, primaryDocument: string): string {
  const bare = String(Number.parseInt(padCik(cik), 10));
  const folder = accession.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/data/${bare}/${folder}/${primaryDocument}`;
}

export interface FilingRef {
  accession: string;
  form: string;
  /** Date EDGAR accepted the filing. */
  filedAt: string;
  /** Period the filing reports on, when EDGAR states one. */
  reportDate?: string;
  primaryDocument: string;
  documentUrl: string;
  title: string;
}

export interface ParseSubmissionsOptions {
  /** Keep only these form types. Omit to keep every form. */
  forms?: readonly string[];
  /** Keep at most this many, newest filing date first. */
  limit?: number;
}

interface RecentColumns {
  accessionNumber: string[];
  form: string[];
  filingDate: string[];
  reportDate: (string | null)[];
  primaryDocument: string[];
}

/**
 * `filings.recent` is column-oriented: parallel arrays, one index per filing.
 * Treated as a trust boundary — a row missing an accession or a primary
 * document is dropped rather than half-stored.
 */
export function parseSubmissions(json: unknown, options: ParseSubmissionsOptions = {}): FilingRef[] {
  const root = json as { cik?: string; name?: string; filings?: { recent?: Partial<RecentColumns> } };
  const cik = root.cik;
  const recent = root.filings?.recent;
  if (typeof cik !== 'string' || !recent || !Array.isArray(recent.accessionNumber)) {
    throw new Error('submissions JSON has no filings.recent block');
  }
  const companyName = typeof root.name === 'string' ? root.name : cik;
  const wanted = options.forms ? new Set(options.forms.map((f) => f.toUpperCase())) : null;

  const out: FilingRef[] = [];
  for (let i = 0; i < recent.accessionNumber.length; i += 1) {
    const accession = recent.accessionNumber[i];
    const form = recent.form?.[i];
    const filedAt = recent.filingDate?.[i];
    const primaryDocument = recent.primaryDocument?.[i];
    if (!accession || !form || !filedAt || !primaryDocument) continue;
    if (wanted && !wanted.has(form.toUpperCase())) continue;
    const reportDate = recent.reportDate?.[i];
    out.push({
      accession,
      form,
      filedAt,
      ...(reportDate ? { reportDate } : {}),
      primaryDocument,
      documentUrl: filingDocumentUrl(cik, accession, primaryDocument),
      title: `${companyName} ${form} ${reportDate || filedAt}`,
    });
  }
  out.sort((a, b) => (a.filedAt === b.filedAt ? b.accession.localeCompare(a.accession) : b.filedAt.localeCompare(a.filedAt)));
  return options.limit === undefined ? out : out.slice(0, options.limit);
}

export interface FetchedResource {
  url: string;
  body: string;
  contentType: string;
}

/**
 * SEC declines anonymous traffic outright, so an unset SEC_USER_AGENT is a
 * configuration error rather than a request to retry. The header must name a
 * contact the SEC can reach, in their documented shape:
 *
 *   SEC_USER_AGENT="Acme Research contact@acme.com"
 *
 * A URL in place of an address is refused with 403.
 */
export async function fetchEdgar(
  url: string,
  userAgent = process.env.SEC_USER_AGENT,
): Promise<FetchedResource> {
  if (!userAgent) {
    throw new Error('SEC_USER_AGENT is not set; SEC requires a contact in the User-Agent header');
  }
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, accept: '*/*', 'accept-encoding': 'gzip, deflate' },
  });
  if (!response.ok) {
    const hint =
      response.status === 403
        ? ' (SEC requires SEC_USER_AGENT to carry a name and contact email)'
        : '';
    throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}${hint}`);
  }
  return {
    url,
    body: await response.text(),
    contentType: response.headers.get('content-type') ?? 'application/octet-stream',
  };
}
