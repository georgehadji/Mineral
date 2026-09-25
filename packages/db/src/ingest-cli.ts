// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { ingestDocument, ingestXbrlFacts } from './ingest-repository.ts';
import {
  COMPANY_FACTS_DOCUMENT_TYPE,
  companyFactsUrl,
  fetchEdgar,
  htmlToText,
  parseCompanyFacts,
  parseSubmissions,
  submissionsUrl,
} from '@mineral/ingest';

/**
 * One company, end to end: resolve it, store its filings, promote its XBRL
 * numbers. Run it twice; the second run must write nothing.
 *
 *   pnpm ingest "MP" --forms 10-K,10-Q --limit 2 --since 2019-01-01
 */
const args = process.argv.slice(2);
const query = args[0];
if (!query || query.startsWith('--')) {
  console.error('usage: pnpm ingest "<company>" [--forms 10-K,10-Q,20-F] [--limit 2] [--since 2019-01-01]');
  process.exit(2);
}

const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};
// 20-F is a foreign private issuer's annual report (Critical Metals).
const forms = (flag('forms') ?? '10-K,10-Q,20-F').split(',').filter(Boolean);
const limit = Number(flag('limit') ?? 2);
const since = flag('since') ?? '2019-01-01';

/** SEC asks for no more than ten requests a second. */
const politePause = () => new Promise((resolve) => setTimeout(resolve, 150));

const pool = createPool();
try {
  const outcome = await resolveCompany(pool, query);
  if (outcome.status !== 'resolved') {
    console.error(`${query}: ${outcome.status}`);
    process.exit(1);
  }
  const company = outcome.company;
  const { rows } = await pool.query<{ value: string }>(
    `select value from core.company_identifiers
      where company_id = $1 and id_type = 'cik' limit 1`,
    [company.companyId],
  );
  const cik = rows[0]?.value;
  if (!cik) {
    console.error(`${company.legalName} has no CIK on file; EDGAR ingestion needs one`);
    process.exit(1);
  }
  console.log(`${company.legalName}  CIK ${cik}`);

  const submissions = await fetchEdgar(submissionsUrl(cik));
  const filings = parseSubmissions(JSON.parse(submissions.body), { forms, limit });
  for (const filing of filings) {
    await politePause();
    const fetched = await fetchEdgar(filing.documentUrl);
    const result = await ingestDocument(pool, {
      externalId: filing.accession,
      canonicalUrl: filing.documentUrl,
      documentType: filing.form,
      title: filing.title,
      publishedAt: filing.filedAt,
      content: fetched.body,
      mimeType: fetched.contentType,
      text: htmlToText(fetched.body),
      subjectEntityId: company.companyId,
    });
    console.log(
      `  ${filing.form} ${filing.accession}  ${result.created ? `stored v${result.versionNo}` : 'already stored'}` +
        `  ${result.chunkCount} chunks  ${result.contentHash.slice(0, 12)}`,
    );
  }

  await politePause();
  const companyFacts = await fetchEdgar(companyFactsUrl(cik));
  const factsDocument = await ingestDocument(pool, {
    externalId: `companyfacts-CIK${cik}`,
    canonicalUrl: companyFactsUrl(cik),
    documentType: COMPANY_FACTS_DOCUMENT_TYPE,
    title: `${company.legalName} XBRL company facts`,
    content: companyFacts.body,
    mimeType: companyFacts.contentType,
    chunk: false,
    subjectEntityId: company.companyId,
  });
  const candidates = parseCompanyFacts(JSON.parse(companyFacts.body), { since });
  const facts = await ingestXbrlFacts(pool, {
    companyEntityId: company.companyId,
    candidates,
    fallbackDocumentVersionId: factsDocument.documentVersionId,
  });
  console.log(
    `  companyfacts ${factsDocument.created ? `stored v${factsDocument.versionNo}` : 'already stored'}` +
      `  ${candidates.length} observations since ${since}`,
  );
  console.log(
    `  facts: ${facts.promoted} promoted ${facts.epistemicStatus}, ` +
      `${facts.unchanged} unchanged, ${facts.superseded} superseded`,
  );
} finally {
  await pool.end();
}
