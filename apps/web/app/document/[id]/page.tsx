import { notFound } from 'next/navigation';
import { documentPage } from '@mineral/db';
import { pool } from '../../../lib/pool';
import { bytes, day, stamp } from '../../../lib/format';
import { Tier } from '../../ui';

/**
 * The filing, as stored. This is where a number ends up: the chunks are the
 * exact segmentation every citation points into, so the text here is the text
 * a claim quoted, not a re-fetch of the page it came from.
 */
export default async function DocumentVersionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ chunk?: string }>;
}) {
  const { id } = await params;
  const { chunk: citedChunkId } = await searchParams;
  const filing = await documentPage(pool, id);
  if (!filing) notFound();

  return (
    <>
      <p className="crumbs">filing</p>
      <h1>{filing.title}</h1>
      <p className="sub">
        {filing.documentType} · {filing.sourceName} <Tier tier={filing.sourceTier} />
        {filing.publisher ? ` · ${filing.publisher}` : ''}
        {filing.externalId ? ` · ${filing.externalId}` : ''}
      </p>
      <p className="sub">
        Version {filing.versionNo} · filed {day(filing.publishedAt)} · captured{' '}
        {stamp(filing.capturedAt)} · {bytes(filing.byteSize)} · {filing.rawTextLength} characters
        stored · {filing.citations} citation{filing.citations === 1 ? '' : 's'}
      </p>
      <p className="sub">
        Content hash <code>{filing.contentHash}</code>. Raw documents are immutable; a correction
        arrives as a new version, never as an edit (invariant C.3).
      </p>
      {filing.canonicalUrl && (
        <p className="sub">
          {/* The stored copy is what the claims cite; the original is context. */}
          <a href={filing.canonicalUrl} rel="noreferrer noopener nofollow" target="_blank">
            The original at the publisher
          </a>
        </p>
      )}

      <h2>Text</h2>
      {filing.chunks.length === 0 ? (
        <p className="sub">No chunks stored for this version.</p>
      ) : (
        filing.chunks.map((chunk) => (
          <div
            key={chunk.chunkId}
            id={`chunk-${chunk.chunkId}`}
            className={`chunk${chunk.chunkId === citedChunkId ? ' cited' : ''}`}
          >
            <div className="sub">
              chunk {chunk.chunkIndex}
              {chunk.sectionPath ? ` · ${chunk.sectionPath}` : ''}
              {chunk.pageNo !== null ? ` · page ${chunk.pageNo}` : ''}
              {chunk.chunkId === citedChunkId ? ' · cited' : ''}
            </div>
            {chunk.text}
          </div>
        ))
      )}
    </>
  );
}
