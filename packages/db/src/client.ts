import { Pool } from 'pg';

/**
 * SQL-first data access: queries are written as SQL, not generated. The schema
 * is the contract and its constraints do the enforcing.
 */
export function createPool(connectionString = process.env.DATABASE_URL): Pool {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({ connectionString });
}

export type { Pool } from 'pg';
