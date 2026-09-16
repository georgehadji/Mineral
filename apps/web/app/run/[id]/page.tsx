import Link from 'next/link';
import { notFound } from 'next/navigation';
import { runStatus } from '@mineral/db';
import { pool } from '../../../lib/pool';
import { day, stamp } from '../../../lib/format';
import { Status } from '../../ui';

const FINISHED = new Set(['completed', 'failed', 'cancelled']);

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const run = await runStatus(pool, id);
  if (!run) notFound();

  const running = !FINISHED.has(run.status);

  return (
    <>
      {/* A running pipeline writes module rows as it goes, so the cheapest
          honest progress indicator is to fetch the page again. */}
      {running && <meta httpEquiv="refresh" content="4" />}
      <p className="crumbs">
        <Link href={`/company/${run.companyId}`}>back to the company</Link> · run
      </p>
      <h1>Run {run.runId.slice(0, 8)}</h1>
      <p className="sub">
        <Status status={run.status} /> · as of {day(run.asOfDate)} · {run.depthMode} ·{' '}
        {run.claims} claim{run.claims === 1 ? '' : 's'}
      </p>
      <p className="sub">
        Requested {stamp(run.requestedAt)}
        {run.startedAt ? ` · started ${stamp(run.startedAt)}` : ''}
        {run.completedAt ? ` · finished ${stamp(run.completedAt)}` : ''}
      </p>
      {running && <p className="sub">Refreshing every few seconds.</p>}

      {run.thesisVersionId && (
        <p>
          <Link href={`/company/${run.companyId}`}>This run has a thesis. Read it.</Link>
        </p>
      )}

      {run.error ? (
        <div className="panel">
          <p className="error">The run failed.</p>
          <pre className="sub" style={{ whiteSpace: 'pre-wrap' }}>
            {JSON.stringify(run.error, null, 2)}
          </pre>
        </div>
      ) : null}

      <h2>Modules</h2>
      <table>
        <thead>
          <tr>
            <th>Module</th>
            <th>Status</th>
            <th>Attempt</th>
            <th>Started</th>
          </tr>
        </thead>
        <tbody>
          {run.modules.map((module) => (
            <tr key={`${module.code}-${module.attempt}`}>
              <td>{module.code}</td>
              <td>
                <Status status={module.status} />
              </td>
              <td className="num">{module.attempt}</td>
              <td className="num sub">{stamp(module.startedAt)}</td>
            </tr>
          ))}
          {run.modules.length === 0 && (
            <tr>
              <td colSpan={4} className="sub">
                No module has started yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
