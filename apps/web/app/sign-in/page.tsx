import { redirect } from 'next/navigation';
import { signIn, signUp } from '../../lib/actions';
import { currentViewer } from '../../lib/session';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await currentViewer()) redirect('/');
  const { error, next } = await searchParams;

  return (
    <>
      <h1>Sign in</h1>
      <p className="sub">
        Reading needs no account. An account exists so that starting a run -- which spends money on
        model calls and writes rows -- is not something a passer-by can do.
      </p>
      {next === 'run' && <p className="sub">Sign in first, then start the run.</p>}
      {error && <p className="error">{error}</p>}

      <div className="panel" style={{ maxWidth: 380 }}>
        <form action={signIn}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" required />
          <label htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <p style={{ marginTop: 14 }}>
            <button type="submit">Sign in</button>
          </p>
        </form>
      </div>

      <h2>Or create one</h2>
      <div className="panel" style={{ maxWidth: 380 }}>
        <form action={signUp}>
          <label htmlFor="new-name">Name</label>
          <input id="new-name" name="name" type="text" autoComplete="name" />
          <label htmlFor="new-email">Email</label>
          <input id="new-email" name="email" type="email" autoComplete="email" required />
          <label htmlFor="new-password">Password</label>
          <input
            id="new-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <p style={{ marginTop: 14 }}>
            <button type="submit" className="quiet">
              Create account
            </button>
          </p>
        </form>
      </div>
    </>
  );
}
