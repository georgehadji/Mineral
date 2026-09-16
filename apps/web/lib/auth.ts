import { betterAuth } from 'better-auth';
import { nextCookies } from 'better-auth/next-js';
import { pool } from './pool';

/**
 * Better Auth, minimal (report J.9): email and password, nothing else.
 *
 * Research state is global -- every claim, thesis and valuation is shared, and
 * reading one needs no account. What an account is for here is the one thing a
 * visitor must not be able to do anonymously: start a run, which spends money
 * on model calls and writes rows. So the session guards the write and nothing
 * else, and the read models stay public.
 *
 * Its tables are prefixed and separate from `core.users`. Better Auth owns the
 * shape of its own tables and migrates them on its own schedule; `core.users`
 * is the domain's row, referenced by `research.runs.user_id`. They are joined
 * on email by `currentUser` below rather than by a foreign key, so an upgrade
 * of one cannot force a migration of the other.
 */
export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  user: { modelName: 'auth_users' },
  session: { modelName: 'auth_sessions' },
  account: { modelName: 'auth_accounts' },
  verification: { modelName: 'auth_verifications' },
  plugins: [nextCookies()],
});
