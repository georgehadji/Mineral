// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { z } from 'zod';
import { createPool } from './client.ts';
import { callModel } from './model-repository.ts';

/**
 * One model call through the gateway, so the cache is visible from a terminal.
 * Run it twice with the same question: the first call reaches the provider,
 * the second reports `cached` and costs nothing.
 *
 *   pnpm ask "What does MP Materials mine?" --task extraction
 *
 * Nothing this writes is canonical state. It exists to prove the gateway, not
 * to put a model answer anywhere a thesis can read it.
 */
const args = process.argv.slice(2);
const question = args[0];
if (!question || question.startsWith('--')) {
  console.error('usage: pnpm ask "<question>" [--task extraction|classification|synthesis|verification]');
  process.exit(2);
}

const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const TASKS = ['extraction', 'classification', 'synthesis', 'verification'] as const;
const task = (flag('task') ?? 'extraction') as (typeof TASKS)[number];
if (!TASKS.includes(task)) {
  console.error(`unknown task ${task}; known tasks are ${TASKS.join(', ')}`);
  process.exit(2);
}

/** Deliberately small. A real module brings its own schema and prompt version. */
const AnswerSchema = z.object({
  answer: z.string().describe('a direct answer, one or two sentences'),
  assumptions: z.array(z.string()).describe('anything assumed that the question did not state'),
});

const pool = createPool();
try {
  const result = await callModel(pool, {
    task,
    system:
      'You answer questions about companies and commodity supply chains. ' +
      'State what you do not know rather than filling it in.',
    user: question,
    schema: AnswerSchema,
    cacheOnly: args.includes('--cached'),
  });

  console.log(result.value.answer);
  for (const assumption of result.value.assumptions) console.log(`  assumed: ${assumption}`);
  const cost = result.costUsd === null ? 'unpriced' : `$${result.costUsd.toFixed(6)}`;
  console.log(
    `\n  ${result.cached ? 'cached' : 'live'}  ${result.inputTokens} in / ${result.outputTokens} out  ${cost}` +
      `\n  request ${result.requestHash.slice(0, 12)}  model run ${result.modelRunId}`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await pool.end();
}
