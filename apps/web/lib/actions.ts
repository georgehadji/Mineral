'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { CORE_RECIPE } from '@mineral/research';
import { decide, runResearch, verifyRun } from '@mineral/db';
import { auth } from './auth';
import { pool } from './pool';
import { currentViewer } from './session';

/**
 * Start the pipeline for one company: research, then verification, then the
 * decision. Returns as soon as the run row exists so the caller can show a
 * status page; the rest continues in this process.
 *
 * ponytail: in-process background work. It survives `next start` because that
 * is one long-lived node process, and it does not survive a serverless deploy
 * or a restart mid-run -- move it behind the `Step` seam (Inngest, or any
 * queue) when the app is deployed somewhere that recycles.
 */
export async function startRun(formData: FormData): Promise<void> {
  const viewer = await currentViewer();
  if (!viewer) redirect('/sign-in?next=run');

  const companyId = String(formData.get('companyId') ?? '');
  if (!companyId) throw new Error('startRun: no company');

  const runId = await new Promise<string>((resolve, reject) => {
    const pipeline = runResearch(pool, {
      companyId,
      recipe: CORE_RECIPE,
      userId: viewer.userId,
      onStart: resolve,
    }).then(async (result) => {
      if (result.status !== 'completed') return;
      await verifyRun(pool, result.runId);
      await decide(pool, { runId: result.runId });
    });
    // Attached so a failure before the run row exists reaches the operator
    // rather than becoming an unhandled rejection.
    pipeline.then(
      () => {},
      (error: unknown) => {
        console.error('run pipeline failed', error);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });

  redirect(`/run/${runId}`);
}

function back(path: string, message: string): never {
  redirect(`${path}?error=${encodeURIComponent(message)}`);
}

export async function signUp(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const name = String(formData.get('name') ?? '').trim() || email;
  try {
    await auth.api.signUpEmail({ body: { email, password, name }, headers: await headers() });
  } catch (error) {
    back('/sign-in', error instanceof Error ? error.message : 'could not create the account');
  }
  redirect('/');
}

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch {
    // Deliberately not saying which half was wrong.
    back('/sign-in', 'that email and password do not match');
  }
  redirect('/');
}

export async function signOut(): Promise<void> {
  await auth.api.signOut({ headers: await headers() });
  redirect('/');
}
