import { testDatabaseUrl } from './packages/db/src/test-database.ts';

// Every suite reads DATABASE_URL. Whatever the shell exported, it becomes the
// test database or nothing, so no suite can reach the working one.
const url = testDatabaseUrl();
if (url) process.env.DATABASE_URL = url;
else delete process.env.DATABASE_URL;
