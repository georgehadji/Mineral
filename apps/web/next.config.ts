import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * The CLIs load the repository's .env themselves (`node --env-file-if-exists`)
 * and Next only looks beside itself, so the web app used to be the one thing
 * in the repo that could not see the database URL. It reads the same file
 * rather than keeping a second copy, because two .env files disagree the day
 * one of them is edited. Node 22 supplies the reader, so no dependency is
 * added, and a missing file is not an error: the environment may carry the
 * variables already.
 */
try {
  process.loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch {
  // No .env, or unreadable. Whatever is already in the environment stands.
}

/**
 * The workspace packages export TypeScript source with no build step (see
 * docs/architecture/01-repository-layout.md), so Next compiles them itself.
 */
const config: NextConfig = {
  transpilePackages: [
    '@mineral/ai',
    '@mineral/db',
    '@mineral/domain',
    '@mineral/events',
    '@mineral/identity',
    '@mineral/ingest',
    '@mineral/research',
    '@mineral/schemas',
  ],
  serverExternalPackages: ['pg'],
  typedRoutes: false,
};

export default config;
