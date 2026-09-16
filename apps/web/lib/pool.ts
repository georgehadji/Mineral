import { createPool, type Pool } from '@mineral/db';

/**
 * One pool for the process. Next reloads modules in development, so the pool
 * is parked on globalThis; without that every edit leaks a set of connections
 * and the database runs out of slots long before the page stops rendering.
 */
const held = globalThis as unknown as { mineralPool?: Pool };

export const pool: Pool = held.mineralPool ?? createPool();
if (process.env.NODE_ENV !== 'production') held.mineralPool = pool;
