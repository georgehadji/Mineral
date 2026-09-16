import Link from 'next/link';
import { notFound } from 'next/navigation';
import { claimDetail } from '@mineral/db';
import { pool } from '../../../lib/pool';
import { day, exact, pct, stamp } from '../../../lib/format';
import { Status, Tier } from '../../ui';

export default async function ClaimPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const claim = await claimDetail(pool, id);
  if (!claim) notFound();

  return (
    <>
      <p className="crumbs">
        <Link href={`/company/${claim.companyId}`}>{claim.companyName}</Link> · claim
      </p>
      <h1>{claim.statement}</h1>
      <p className="sub">
        <Status status={claim.status} /> · confidence {pct(claim.confidence)} · {claim.claimType} ·
        key <code>{claim.claimKey}</code>
      </p>
      <p className="sub">
        Written by {claim.createdBy}
        {claim.moduleCode ? ` in ${claim.moduleCode}` : ''} · {stamp(claim.createdAt)}
        {claim.runId ? (
          <>
            {' · '}
            <Link href={`/run/${claim.runId}`}>run {claim.runId.slice(0, 8)}</Link>
            {claim.asOfDate ? ` as of ${day(claim.asOfDate)}` : ''}
          </>
        ) : null}
      </p>

      <h2>Evidence</h2>
      {claim.evidence.length === 0 ? (
        <p className="sub">
          None cited. Only INFERRED, HYPOTHESIS and UNKNOWN claims are allowed to stand without
          evidence (invariant C.7).
        </p>
      ) : (
        claim.evidence.map((citation) => (
          <div className="panel" key={citation.evidenceId}>
            <p>
              <span className="tag">{citation.role}</span>{' '}
              {citation.sourceTier !== null && <Tier tier={citation.sourceTier} />}{' '}
              <span className="sub">
                strength {pct(citation.strength)}
                {citation.sourceName ? ` · ${citation.sourceName}` : ''}
              </span>
            </p>

            {citation.quote && <blockquote>{citation.quote}</blockquote>}

            {citation.factVersionId && (
              <p className="sub">
                Figure {citation.factCode} = {exact(citation.factValue)} {citation.factUnit ?? ''}
              </p>
            )}

            {citation.documentVersionId && (
              <p className="sub" style={{ marginTop: 8 }}>
                <Link
                  href={`/document/${citation.documentVersionId}${
                    citation.chunkId ? `?chunk=${citation.chunkId}` : ''
                  }`}
                >
                  {citation.documentTitle ?? 'the filing'}
                </Link>
                {citation.documentType ? ` · ${citation.documentType}` : ''}
                {citation.externalId ? ` · ${citation.externalId}` : ''}
                {citation.publishedAt ? ` · filed ${day(citation.publishedAt)}` : ''}
                {citation.sectionPath ? ` · ${citation.sectionPath}` : ''}
                {citation.pageNo !== null ? ` · page ${citation.pageNo}` : ''}
              </p>
            )}
          </div>
        ))
      )}

      {claim.checks.length > 0 && (
        <>
          <h2>Verification</h2>
          <table>
            <thead>
              <tr>
                <th>Check</th>
                <th>Result</th>
                <th>Message</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {claim.checks.map((check, index) => (
                <tr key={`${check.checkType}-${check.checkedAt}-${index}`}>
                  <td>{check.checkType}</td>
                  <td>
                    <Status status={check.status} />
                  </td>
                  <td className="sub">{check.message ?? '--'}</td>
                  <td className="num sub">{stamp(check.checkedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {claim.otherVersions.length > 0 && (
        <>
          <h2>The same question, other runs</h2>
          <p className="sub">
            Disagreement is kept rather than averaged away (invariant C.13), so both answers stay
            readable.
          </p>
          <table>
            <tbody>
              {claim.otherVersions.map((other) => (
                <tr key={other.claimId}>
                  <td className="num sub">{day(other.asOfDate)}</td>
                  <td>
                    <Status status={other.status} />
                  </td>
                  <td>
                    <Link href={`/claim/${other.claimId}`}>{other.statement}</Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
