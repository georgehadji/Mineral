import type { ReactNode } from 'react';
import Link from 'next/link';
import { signOut } from '../lib/actions';
import { currentViewer } from '../lib/session';
import './globals.css';

export const metadata = {
  title: 'Mineral',
  description: 'Versioned, evidence-backed investment theses.',
};

/** Nothing is cached: every page is a read model over rows that a run can
 *  change at any moment, and a stale thesis is the one thing this must not
 *  show. */
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  return (
    <html lang="en">
      <body>
        <header className="top">
          <Link href="/" className="brand">
            Mineral
          </Link>
          <span className="spacer" />
          {viewer ? (
            <>
              <span className="who">{viewer.email}</span>
              <form action={signOut} className="inline">
                <button type="submit" className="quiet">
                  Sign out
                </button>
              </form>
            </>
          ) : (
            <Link href="/sign-in">Sign in</Link>
          )}
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
