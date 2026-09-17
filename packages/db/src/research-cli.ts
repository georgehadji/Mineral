// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { CORE_RECIPE, DEEP_RECIPE } from '@mineral/research';
import { createPool } from './client.ts';
import { runResearch } from './research-repository.ts';

/**
 * One research run from a terminal.
 *
 *   pnpm research "MP"
 *   pnpm research "MP" --as-of 2026-06-30 --cached
 *   pnpm research "MP" --deep
 *
 * --deep runs DEEP_RECIPE: fifteen modules instead of nine, including the
 * ones that only the deep path has. It is the dearer run by some way.
 *
 * The same subject, recipe, date and snapshot make the same run: a second
 * invocation returns the first run untouched rather than writing another.
 */
const args = process.argv.slice(2);
const query = args[0];
if (!query || query.startsWith('--')) {
  console.error('usage: pnpm research "<company>" [--as-of YYYY-MM-DD] [--cached] [--deep]');
  process.exit(2);
}

const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const pool = createPool();
try {
  const result = await runResearch(pool, {
    query,
    recipe: args.includes('--deep') ? DEEP_RECIPE : CORE_RECIPE,
    asOfDate: flag('as-of'),
    cacheOnly: args.includes('--cached'),
  });

  if (result.reused) {
    console.log(`run ${result.runId} already covers this snapshot: ${result.claimCount} claims, nothing rewritten`);
  } else {
    for (const outcome of result.modules) {
      const dropped = outcome.rejected?.length ?? 0;
      console.log(
        `  ${outcome.status === 'completed' ? 'ok  ' : 'fail'} ${outcome.code}  ` +
          `${outcome.claimCount} claims${dropped > 0 ? `, ${dropped} refused` : ''}`,
      );
      // A refused claim is not a silent loss: say what was thrown away and why.
      for (const refusal of outcome.rejected ?? []) {
        console.log(`       refused  ${refusal.reason}`);
      }
    }
    console.log(`\nrun ${result.runId}  ${result.claimCount} claims  snapshot ${result.snapshotHash.slice(0, 12)}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
