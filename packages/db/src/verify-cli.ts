// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { latestRunFor, verifyRun } from './verification-repository.ts';

/**
 * Verify a research run.
 *
 *   pnpm verify "MP"                                    # latest completed run
 *   pnpm verify 7f1c...                                 # a specific run id
 *
 * Verification is deterministic, so running it twice gives the same verdict.
 * Each pass writes its own verification run: the history of what was checked
 * when is part of the record.
 */
const args = process.argv.slice(2);
const target = args[0];
if (!target || target.startsWith('--')) {
  console.error('usage: pnpm verify "<company>" | pnpm verify <run-id>');
  process.exit(2);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const pool = createPool();
try {
  let runId = UUID.test(target) ? target : null;
  if (!runId) {
    const outcome = await resolveCompany(pool, target);
    if (outcome.status !== 'resolved') {
      throw new Error(
        outcome.status === 'ambiguous'
          ? `"${target}" matches ${outcome.candidates.length} companies; name one exactly`
          : `no company matches "${target}"`,
      );
    }
    runId = await latestRunFor(pool, outcome.company.companyId);
    if (!runId) throw new Error(`no completed run for ${outcome.company.legalName}; run pnpm research first`);
  }

  const result = await verifyRun(pool, runId);
  const failures = result.checks.filter((check) => check.status === 'failed');
  for (const check of failures) {
    console.log(`  ${check.severity.padEnd(8)} ${check.type.padEnd(18)} ${check.message}`);
  }
  console.log(
    `\n${result.overall}  ${result.claimsChecked} claims  ${result.checks.length} checks  ` +
      `${failures.length} failed  ${result.contradicted.length} marked CONTRADICTED` +
      `\nrun ${result.runId}  verification ${result.verificationRunId}`,
  );
  if (result.overall === 'failed') process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
