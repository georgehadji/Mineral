import type { Pool, PoolClient } from 'pg';
import { chunkText, sha256, EDGAR_SOURCE, FACT_DEFINITIONS, type XbrlFactCandidate } from '@mineral/ingest';
import { factEpistemicStatus, type EpistemicStatus } from '@mineral/schemas';
import type { UUID } from '@mineral/domain';
import { inTransaction } from './client.ts';
import {
  currentFactVersion,
  ensureFactDefinitions,
  upsertFact,
} from './facts.ts';

/**
 * Ingestion writes. Documents and their versions are immutable: a second
 * ingest of the same bytes adds nothing, and different bytes add a version
 * rather than overwriting one. Content hash is the only dedupe key.
 */

type SubjectRole = 'subject' | 'issuer' | 'mentioned' | 'counterparty';

export interface IngestDocumentInput {
  /** Stable provider identifier, e.g. an EDGAR accession number. */
  externalId: string;
  canonicalUrl: string;
  documentType: string;
  title: string;
  publishedAt?: string;
  /** Bytes exactly as fetched. Hashed unmodified. */
  content: string;
  mimeType: string;
  /** Searchable text, when it differs from the fetched bytes (HTML -> text). */
  text?: string;
  subjectEntityId?: UUID;
  subjectRole?: SubjectRole;
  chunkTargetChars?: number;
  /** Structured payloads (JSON) hold no prose to quote, so they skip chunking. */
  chunk?: boolean;
}

export interface IngestDocumentResult {
  documentId: UUID;
  documentVersionId: UUID;
  versionNo: number;
  contentHash: string;
  /** False when these exact bytes were already stored. */
  created: boolean;
  chunkCount: number;
}

/** Registers EDGAR once; the unique source name makes repeat calls no-ops. */
export async function ensureEdgarSource(client: PoolClient | Pool): Promise<UUID> {
  await client.query(
    `insert into evidence.sources (source_name, source_type, source_tier, publisher, base_url)
     values ($1, $2, $3, $4, $5)
     on conflict (source_name) do nothing`,
    [
      EDGAR_SOURCE.sourceName,
      EDGAR_SOURCE.sourceType,
      EDGAR_SOURCE.sourceTier,
      EDGAR_SOURCE.publisher,
      EDGAR_SOURCE.baseUrl,
    ],
  );
  const { rows } = await client.query<{ id: string }>(
    `select id from evidence.sources where source_name = $1`,
    [EDGAR_SOURCE.sourceName],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('failed to register the EDGAR source');
  return id;
}

export async function ingestDocument(
  pool: Pool,
  input: IngestDocumentInput,
): Promise<IngestDocumentResult> {
  const contentHash = sha256(input.content);
  return inTransaction(pool, async (client) => {
    const sourceId = await ensureEdgarSource(client);

    const documentId = await firstOrExisting(
      client,
      `insert into evidence.documents
         (source_id, canonical_url, external_id, document_type, title, publisher, published_at)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (source_id, external_id) do nothing
       returning id`,
      [
        sourceId,
        input.canonicalUrl,
        input.externalId,
        input.documentType,
        input.title,
        EDGAR_SOURCE.publisher,
        input.publishedAt ?? null,
      ],
      `select id from evidence.documents where source_id = $1 and external_id = $2`,
      [sourceId, input.externalId],
    );

    if (input.subjectEntityId) {
      await client.query(
        `insert into evidence.document_subjects (document_id, entity_id, role)
         values ($1, $2, $3) on conflict do nothing`,
        [documentId, input.subjectEntityId, input.subjectRole ?? 'issuer'],
      );
    }

    const text = input.text ?? input.content;
    const inserted = await client.query<{ id: string; version_no: number }>(
      `insert into evidence.document_versions
         (document_id, content_hash, storage_uri, mime_type, byte_size, raw_text)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (document_id, content_hash) do nothing
       returning id, version_no`,
      [
        documentId,
        contentHash,
        input.canonicalUrl,
        input.mimeType,
        Buffer.byteLength(input.content),
        text,
      ],
    );

    const fresh = inserted.rows[0];
    if (fresh) {
      const chunks =
        input.chunk === false ? [] : chunkText(text, { targetChars: input.chunkTargetChars ?? 2000 });
      if (chunks.length > 0) {
        await client.query(
          `insert into evidence.document_chunks (document_version_id, chunk_index, text_content)
           select $1, ordinality - 1, value
             from unnest($2::text[]) with ordinality as t(value, ordinality)`,
          [fresh.id, chunks],
        );
      }
      return {
        documentId,
        documentVersionId: fresh.id,
        versionNo: fresh.version_no,
        contentHash,
        created: true,
        chunkCount: chunks.length,
      };
    }

    const { rows } = await client.query<{ id: string; version_no: number; chunk_count: string }>(
      `select dv.id, dv.version_no, count(dc.id)::text as chunk_count
         from evidence.document_versions dv
         left join evidence.document_chunks dc on dc.document_version_id = dv.id
        where dv.document_id = $1 and dv.content_hash = $2
        group by dv.id, dv.version_no`,
      [documentId, contentHash],
    );
    const existing = rows[0];
    if (!existing) throw new Error('document version vanished between insert and read');
    return {
      documentId,
      documentVersionId: existing.id,
      versionNo: existing.version_no,
      contentHash,
      created: false,
      chunkCount: Number(existing.chunk_count),
    };
  });
}

/** `insert ... on conflict do nothing returning id` yields no row on conflict. */
async function firstOrExisting(
  client: PoolClient,
  insertSql: string,
  insertParams: unknown[],
  selectSql: string,
  selectParams: unknown[],
): Promise<UUID> {
  const inserted = await client.query<{ id: string }>(insertSql, insertParams);
  const id = inserted.rows[0]?.id ?? (await client.query<{ id: string }>(selectSql, selectParams)).rows[0]?.id;
  if (!id) throw new Error('row could not be inserted or found');
  return id;
}

export interface IngestXbrlFactsInput {
  /** core.entities id of the company the filing reports on. */
  companyEntityId: UUID;
  candidates: readonly XbrlFactCandidate[];
  /**
   * Provenance for a value whose reporting filing is not stored yet: the
   * companyfacts document version it was actually read from.
   */
  fallbackDocumentVersionId: UUID;
}

export interface IngestXbrlFactsResult {
  /** New revisions written and promoted. */
  promoted: number;
  /** Values already current, so nothing was written. */
  unchanged: number;
  /** Previously current revisions displaced by a restatement. */
  superseded: number;
  /** What the promoted revisions are entitled to be called. */
  epistemicStatus: EpistemicStatus;
}

/**
 * XBRL numbers go straight to promoted: they are the filer's own structured
 * submission, read deterministically, so no model proposes and no validator
 * is needed. A value that already matches the current revision writes nothing,
 * which is what makes re-ingestion idempotent; a value that differs supersedes
 * rather than overwrites.
 */
export async function ingestXbrlFacts(
  pool: Pool,
  input: IngestXbrlFactsInput,
): Promise<IngestXbrlFactsResult> {
  return inTransaction(pool, async (client) => {
    const sourceId = await ensureEdgarSource(client);
    const definitionIds = await ensureFactDefinitions(client, FACT_DEFINITIONS);
    const filingVersions = await filingVersionsByAccession(
      client,
      sourceId,
      input.candidates.map((c) => c.accession),
    );

    let promoted = 0;
    let unchanged = 0;
    let superseded = 0;

    for (const candidate of input.candidates) {
      const definitionId = definitionIds.get(candidate.code);
      if (!definitionId) throw new Error(`no fact definition for code ${candidate.code}`);

      const factId = await upsertFact(client, input.companyEntityId, definitionId, candidate);
      const current = await currentFactVersion(client, factId, candidate.value);
      if (current?.same) {
        unchanged += 1;
        continue;
      }

      const { rows } = await client.query<{ id: string }>(
        `insert into evidence.fact_versions
           (fact_id, numeric_value, unit, currency, observed_at,
            source_document_version_id, extraction_method)
         values ($1, $2::numeric, $3, $4, now(), $5, 'xbrl')
         returning id`,
        [
          factId,
          String(candidate.value),
          candidate.unit,
          candidate.currency ?? null,
          filingVersions.get(candidate.accession) ?? input.fallbackDocumentVersionId,
        ],
      );
      const versionId = rows[0]?.id;
      if (!versionId) throw new Error(`could not write a revision for fact ${factId}`);

      await client.query(`select evidence.promote_fact_version($1, 'system')`, [versionId]);
      promoted += 1;
      if (current) superseded += 1;
    }

    return {
      promoted,
      unchanged,
      superseded,
      epistemicStatus: factEpistemicStatus({
        extractionMethod: 'xbrl',
        sourceTier: EDGAR_SOURCE.sourceTier,
        status: 'promoted',
      }),
    };
  });
}

/** Newest stored version of each filing, so a fact cites the filing itself. */
async function filingVersionsByAccession(
  client: PoolClient,
  sourceId: UUID,
  accessions: readonly string[],
): Promise<Map<string, UUID>> {
  if (accessions.length === 0) return new Map();
  const { rows } = await client.query<{ external_id: string; id: string }>(
    `select distinct on (d.external_id) d.external_id, dv.id
       from evidence.documents d
       join evidence.document_versions dv on dv.document_id = d.id
      where d.source_id = $1 and d.external_id = any($2::text[])
      order by d.external_id, dv.version_no desc`,
    [sourceId, [...new Set(accessions)]],
  );
  return new Map(rows.map((r) => [r.external_id, r.id]));
}
