// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { latestRunFor } from './verification-repository.ts';
import { decide } from './decision-repository.ts';

/**
 * Turn a completed research run into a decision.
 *
 *   pnpm decide "MP"            # the latest completed run for the company
 *   pnpm decide 7f1c...         # a specific run id
 *   pnpm decide 7f1c... --again # a new thesis for a run that has one
 *
 * Needs the analytics service for the valuation step (pnpm analytics). Without
 * a full set of approved assumptions it writes the thesis anyway and says why
 * there is no valuation under it -- an unvalued thesis is a real answer, a
 * valuation resting on unapproved numbers is not.
 */
const args = process.argv.slice(2);
const target = args[0];
if (!target || target.startsWith('--')) {
  console.error('usage: pnpm decide "<company>" | pnpm decide <run-id>');
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
    if (!runId) {
      throw new Error(`no completed run for ${outcome.company.legalName}; run pnpm research first`);
    }
  }

  const result = await decide(pool, { runId, again: args.includes('--again') });

  if (result.reused) {
    console.log(`thesis v${result.versionNo} already exists for this run; nothing was written`);
  }
  for (const decision of result.decisions) {
    console.log(`  ${decision.status.padEnd(8)} ${decision.code.padEnd(18)} ${decision.reason}`);
  }
  if (result.valuationSkipped) console.log(`  no valuation: ${result.valuationSkipped}`);
  if (result.calculationRunId) console.log(`  valuation run ${result.calculationRunId}`);

  console.log(
    `\n${result.verdict}  confidence ${result.confidence}  ` +
      `${result.nodeCount} nodes  ${result.edgeCount} edges` +
      `\nthesis v${result.versionNo} ${result.thesisVersionId}  run ${result.runId}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
