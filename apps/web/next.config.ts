import type { NextConfig } from 'next';

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
