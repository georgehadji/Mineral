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
}

/**
 * The signed-in viewer, or null. Reading is public, so every page calls this
 * and renders either way; only the run trigger insists on a result.
 */
export async function currentViewer(): Promise<Viewer | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.email) return null;

  // One domain row per email, created on first sight. Better Auth's table and
  // core.users are kept apart on purpose (see lib/auth.ts); this is the join.
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.users (email) values ($1)
     on conflict (email) do update set updated_at = now()
     returning id`,
    [session.user.email],
  );
  const userId = rows[0]?.id;
  if (!userId) return null;

  return {
    authUserId: session.user.id,
    email: session.user.email,
    name: session.user.name ?? session.user.email,
    userId,
  };
}
