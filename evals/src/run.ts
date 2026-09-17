// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { fileURLToPath } from 'node:url';
import { createPool } from '@mineral/db';
import { runExtraction, runVerification, type SuiteResult } from './suites.ts';

/**
 * Run the eval suites (report J.12).
 *
 *   pnpm eval            # score every suite, fail below its threshold
 *   pnpm eval --json     # the same, as JSON
 *
 * This is the gate. Each dataset carries the accuracy its target has to reach,
 * and a run below it exits non-zero, so a change to a verification rule or to
 * the XBRL concept map cannot land while it makes either worse. The threshold
 * lives in the dataset rather than in a second baselines file, because two
 * places to record the same number is one place to forget.
 *
 * Scores are stored in `research.evaluation_runs` when DATABASE_URL is set, and
 * the run still prints and still gates when it is not. CI has a database for
 * the integration job and none for the eval job, and an eval that could only
 * run where there is a database would not be an eval that runs on every pull
 * request.
 */
const datasets = fileURLToPath(new URL('../datasets/', import.meta.url));
const asJson = process.argv.includes('--json');

const results: SuiteResult[] = [
  runVerification(`${datasets}verification-v1.json`),
  runExtraction(`${datasets}extraction-v1.json`),
];

function pct(value: number | null): string {
  return value === null ? '   --' : `${(value * 100).toFixed(1).padStart(5)}%`;
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) {
    console.log(
      `\n${result.dataset}@${result.version}  ${result.target}\n` +
        `  ${result.score.correct}/${result.score.cases} cases  ` +
        `accuracy ${pct(result.score.accuracy)}  threshold ${pct(result.minAccuracy)}  ` +
        `${result.passed ? 'ok' : 'BELOW THRESHOLD'}`,
    );
    console.log(`  ${'rule'.padEnd(20)} cases  accuracy  precision  recall`);
    for (const group of result.score.groups) {
      console.log(
        `  ${group.group.padEnd(20)} ${String(group.cases).padStart(5)}  ` +
          `${pct(group.accuracy)}    ${pct(group.precision)}  ${pct(group.recall)}`,
      );
    }
    for (const miss of result.score.misses) {
      console.log(`  miss  ${miss.id}: expected ${miss.expected}, got ${miss.actual}`);
    }
  }
}

if (process.env.DATABASE_URL) {
  const pool = createPool();
  try {
    for (const result of results) {
      await pool.query(
        `insert into research.evaluation_runs (run_type, dataset_version, score, metrics)
         values ($1, $2, $3::numeric, $4::jsonb)`,
        [
          `eval:${result.dataset}`,
          `${result.dataset}@${result.version}`,
          result.score.accuracy,
          JSON.stringify({
            target: result.target,
            minAccuracy: result.minAccuracy,
            cases: result.score.cases,
            correct: result.score.correct,
            groups: result.score.groups,
            misses: result.score.misses,
          }),
        ],
      );
    }
  } finally {
    await pool.end();
  }
}

const failed = results.filter((result) => !result.passed);
if (failed.length > 0) {
  console.error(
    `\n${failed.length} suite${failed.length === 1 ? '' : 's'} below threshold: ` +
      failed.map((result) => result.dataset).join(', '),
  );
  process.exitCode = 1;
}
