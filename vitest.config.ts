import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@mineral/domain': pkg('domain'),
      '@mineral/events': pkg('events'),
      '@mineral/schemas': pkg('schemas'),
      '@mineral/research': pkg('research'),
      '@mineral/ingest': pkg('ingest'),
      '@mineral/identity': pkg('identity'),
      '@mineral/ai': pkg('ai'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'evals/src/**/*.test.ts', 'tests/**/*.test.ts'],
    // The hermetic tests finish in milliseconds. The integration suites run
    // whole module DAGs against one PostgreSQL in parallel, and the default 5s
    // is a stopwatch on that database rather than a check on anything.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
