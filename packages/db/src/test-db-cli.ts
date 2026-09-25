// Node's type stripper does not rewrite specifiers, so relative imports carry
// their real .ts extension (tsconfig: allowImportingTsExtensions).
import { readdirSync, readFileSync } from 'node:fs';
import { Client } from 'pg';
import { testDatabaseUrl } from './test-database.ts';

/**
 * Build the database the integration suites run against, from nothing: every
 * migration's up half, then the seeds, the way CI builds its own. Rebuilt on
 * each call, so a suite never inherits what a crashed run left behind.
 *
 *   pnpm test:db
 */
const url = testDatabaseUrl();
if (!url) {
  console.error('set TEST_DATABASE_URL (in .env) to a database whose name ends in _test');
  process.exit(2);
}
const name = decodeURIComponent(new URL(url).pathname.slice(1));
const maintenance = new URL(url);
maintenance.pathname = '/postgres';

const dir = (path: string) => new URL(`../${path}/`, import.meta.url);
const sqlFiles = (path: string) =>
  readdirSync(dir(path))
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: readFileSync(new URL(file, dir(path)), 'utf8') }));

const admin = new Client({ connectionString: maintenance.toString() });
await admin.connect();
try {
  // The name was checked to end in _test above; nothing else is ever dropped here.
  await admin.query(`drop database if exists "${name}" with (force)`);
  await admin.query(`create database "${name}"`);
} finally {
  await admin.end();
}

const db = new Client({ connectionString: url });
await db.connect();
try {
  for (const { file, sql } of sqlFiles('migrations')) {
    const up = sql.split('-- migrate:down')[0]!;
    await db.query(up).catch((error: Error) => {
      throw new Error(`${file}: ${error.message}`);
    });
  }
  for (const { file, sql } of sqlFiles('seeds')) {
    // psql settings such as \set ON_ERROR_STOP are not SQL; a failure here stops anyway.
    const body = sql.replace(/^\s*\\.*$/gm, '');
    await db.query(body).catch((error: Error) => {
      throw new Error(`${file}: ${error.message}`);
    });
  }
  const { rows } = await db.query<{ count: string }>('select count(*)::text as count from core.entities');
  console.log(`${name} rebuilt: ${rows[0]!.count} entities seeded`);
} finally {
  await db.end();
}
