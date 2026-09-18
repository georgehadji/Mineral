import { headers } from 'next/headers';
import { auth } from './auth';
import { pool } from './pool';

export interface Viewer {
  /** Better Auth's own id. Not a domain id. */
  authUserId: string;
  email: string;
  name: string;
  /** The `core.users` row, which is what `research.runs.user_id` refers to. */
  userId: string;
  /** True when MINERAL_LOCAL_OPERATOR granted this, not a signed-in session. */
  local: boolean;
}

/**
 * The signed-in viewer, or null. Reading is public, so every page calls this
 * and renders either way; only the run trigger insists on a result.
 *
 * MINERAL_LOCAL_OPERATOR disconnects the sign-in instead of removing it. On a
 * single machine there is nobody to tell apart: the account exists to stop an
 * anonymous visitor spending money on model calls (see lib/auth.ts), and a
 * localhost app with one person at it has no anonymous visitor. Setting it
 * names that person, so runs are still attributed to a real core.users row
 * rather than to nobody. Better Auth stays wired and takes the session path
 * back the moment the variable is unset -- so this is opt-in, and an
 * environment that forgets to set it is guarded, not open.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const operator = process.env.MINERAL_LOCAL_OPERATOR?.trim();
  const session = operator ? null : await auth.api.getSession({ headers: await headers() });
  const email = operator || session?.user?.email;
  if (!email) return null;

  // One domain row per email, created on first sight. Better Auth's table and
  // core.users are kept apart on purpose (see lib/auth.ts); this is the join.
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.users (email) values ($1)
     on conflict (email) do update set updated_at = now()
     returning id`,
    [email],
  );
  const userId = rows[0]?.id;
  if (!userId) return null;

  return {
    authUserId: session?.user.id ?? 'local-operator',
    email,
    name: session?.user.name ?? email,
    userId,
    local: session === null,
  };
}
