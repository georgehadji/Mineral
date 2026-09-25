import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The database the integration suites may touch, or undefined to skip them.
 *
 * The suites delete what they plant by company, and the companies are real
 * members of the universe. Pointed at the working database they deleted every
 * fact of MP and Energy Fuels, so they never read DATABASE_URL: only
 * TEST_DATABASE_URL, from the environment or .env, and only a database whose
 * name ends in _test.
 */
export function testDatabaseUrl(): string | undefined {
  let url = process.env.TEST_DATABASE_URL;
  if (!url) {
    try {
      url = parseEnv(readFileSync(new URL('../../../.env', import.meta.url), 'utf8')).TEST_DATABASE_URL;
    } catch {
      // No .env: the integration suites skip.
    }
  }
  if (!url) return undefined;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.endsWith('_test')) {
    throw new Error(
      `TEST_DATABASE_URL names the database "${name}"; the integration suites delete data ` +
        'and run only against a database whose name ends in _test',
    );
  }
  return url;
}
