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
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts'],
  },
});
