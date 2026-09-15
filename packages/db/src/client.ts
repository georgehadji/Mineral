import { Pool } from 'pg';
import type { PoolClient } from 'pg';

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

export async function inTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
