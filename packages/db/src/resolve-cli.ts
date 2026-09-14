/**
 * Entity resolution from the command line, until the web app exists.
 *   pnpm resolve "MP"
 *   pnpm resolve "CIK-1801368"
 *
 * Imports carry .ts extensions because Node runs this file directly through
 * its type stripper, which does not rewrite specifiers.
 */
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';

const query = process.argv.slice(2).join(' ').trim();

if (query.length === 0) {
  console.error('usage: pnpm resolve "<ticker | CIK | ISIN | name>"');
  process.exit(2);
}

const pool = createPool();
try {
  const outcome = await resolveCompany(pool, query);

  switch (outcome.status) {
    case 'resolved': {
      const c = outcome.company;
      console.log(`${c.legalName}\n  id       ${c.companyId}\n  matched  ${c.matchedValue} (${c.method})`);
      break;
    }
    case 'ambiguous': {
      console.log(`ambiguous by ${outcome.method}, ${outcome.candidates.length} candidates:`);
      for (const c of outcome.candidates) console.log(`  ${c.legalName}  ${c.companyId}`);
      process.exitCode = 1;
      break;
    }
    case 'not_found':
      console.log(`no company matches ${query}`);
      process.exitCode = 1;
      break;
  }
} finally {
  await pool.end();
}
