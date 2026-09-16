// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { createPool } from './client.ts';
import { resolveCompany } from './identity-repository.ts';
import { ensureAlertRules, monitor } from './monitoring-repository.ts';

/**
 * Watch a company for drift against its latest thesis.
 *
 *   pnpm monitor "MP"                          # the only user, if there is one
 *   pnpm monitor "MP" --user alice@example.com
 *
 * Deterministic and idempotent: the second run over unchanged data prints the
 * same drift and writes no alerts, because every alert is keyed by its cause.
 */
const args = process.argv.slice(2);
const target = args[0];
const userFlag = args.indexOf('--user');
const email = userFlag === -1 ? null : args[userFlag + 1];

if (!target || target.startsWith('--')) {
  console.error('usage: pnpm monitor "<company>" [--user <email>]');
  process.exit(2);
}

const pool = createPool();
try {
  const outcome = await resolveCompany(pool, target);
  if (outcome.status !== 'resolved') {
    throw new Error(
      outcome.status === 'ambiguous'
        ? `"${target}" matches ${outcome.candidates.length} companies; name one exactly`
        : `no company matches "${target}"`,
    );
  }
  const companyId = outcome.company.companyId;

  // Alerts belong to someone: the rule row carries the user who asked to be
  // told. With one account there is no question who that is, and with several
  // guessing would send another person's alerts to whoever ran the command.
  const users = await pool.query<{ id: string; email: string }>(
    email
      ? `select id, email from core.users where email = $1`
      : `select id, email from core.users order by created_at limit 2`,
    email ? [email] : [],
  );
  if (users.rows.length === 0) {
    throw new Error(
      email ? `no user with email ${email}` : 'no users yet; sign up in the web app first',
    );
  }
  if (users.rows.length > 1) throw new Error('several users exist; name one with --user <email>');
  const user = users.rows[0]!;

  await ensureAlertRules(pool, { userId: user.id, companyId });
  const { report, created } = await monitor(pool, companyId);

  if (!report.thesis) {
    console.log(`${outcome.company.legalName}: no thesis yet, so nothing to drift from`);
  } else {
    console.log(
      `${outcome.company.legalName}  thesis v${report.thesis.versionNo} (${report.thesis.verdict})`,
    );
    for (const source of report.newSources) {
      console.log(`  new      ${source.documentType.padEnd(8)} ${source.title}`);
    }
    for (const node of report.affected) {
      const label = node.assumptionCode ?? node.nodeType.toLowerCase();
      for (const reason of node.reasons) {
        console.log(`  moved    ${label.padEnd(8)} ${reason.kind} -> ${reason.triggerRefId}`);
      }
    }
    for (const move of report.valuation?.moves ?? []) {
      const pct = move.changePct === null ? 'n/a' : `${(move.changePct * 100).toFixed(1)}%`;
      console.log(`  valued   ${move.code.padEnd(8)} ${move.from} -> ${move.to} (${pct})`);
    }
  }

  for (const { alertEventId, finding } of created) {
    console.log(
      `\n${finding.severity.padEnd(8)} ${finding.eventType}` +
        `\n  ${String(finding.payload.message ?? '')}` +
        `\n  ${finding.triggerRefType} ${finding.triggerRefId}  alert ${alertEventId}`,
    );
  }
  console.log(`\n${created.length} new alert${created.length === 1 ? '' : 's'} for ${user.email}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
