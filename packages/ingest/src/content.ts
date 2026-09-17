import { createHash } from 'node:crypto';

/**
 * Content address for a stored document version. Identical bytes must produce
 * an identical hash: re-ingestion is deduped on this value alone, so it is the
 * whole immutability guarantee for evidence.document_versions.
 */
export function sha256(bytes: string | Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const DROPPED_BLOCKS = /<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi;
const BLOCK_TAGS = /<\/?(p|div|br|tr|table|section|article|h[1-6]|li|ul|ol)\b[^>]*>/gi;
const REMAINING_TAGS = /<[^>]*>/g;

/**
 * SEC paginates the HTML, and every page break leaves two artefacts behind: the
 * page number and the running "Table of Contents" link. Once the tags are gone
 * those land in the middle of whatever sentence spanned the break. One Ramaco
 * 10-K spliced "the 6 Table of Contents mine contains" into a sentence no
 * reader ever saw that way, and a model that quoted the sentence faithfully was
 * then told its quote was not in the document.
 *
 * Case-sensitive on purpose: the running link reads "Table of Contents", and
 * the document's own heading reads "TABLE OF CONTENTS", which is real content.
 * The page number is only removed when it sits directly above that link, so a
 * lone number in a table stays where it is.
 */
const PAGE_FURNITURE = /^(?:\d{1,4}\n)?Table of Contents$/gm;

/** Invisible, survives entity decoding, and breaks a quote for no visible reason. */
const ZERO_WIDTH = /[​‌‍﻿]/g;
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X'
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * ponytail: tag-stripping, not HTML parsing. Good enough to store and search
 * filing text; swap in a real parser when table structure or section paths
 * start to matter (phase 6 context building).
 */
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(DROPPED_BLOCKS, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(BLOCK_TAGS, '\n')
      .replace(REMAINING_TAGS, ' '),
  )
    .replace(/\u00a0/g, ' ')
    .replace(ZERO_WIDTH, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    // Blank lines are collapsed first: a closing and an opening tag leave two
    // newlines between the page number and the link, and the rule below wants
    // them on consecutive lines.
    .replace(/\n+/g, '\n')
    .replace(PAGE_FURNITURE, '')
    .replace(/\n+/g, '\n')
    .trim();
}

export interface ChunkOptions {
  /** Upper bound on characters per chunk. Paragraphs are kept whole below it. */
  targetChars?: number;
}

/**
 * Deterministic paragraph packing: the same text always yields the same chunks,
 * which is what makes a re-ingest of unchanged bytes a no-op rather than a
 * second set of rows.
 */
export function chunkText(text: string, options: ChunkOptions = {}): string[] {
  const target = options.targetChars ?? 2000;
  if (target < 1) throw new Error('targetChars must be positive');

  const chunks: string[] = [];
  let current = '';
  for (const paragraph of splitParagraphs(text, target)) {
    if (current === '') {
      current = paragraph;
    } else if (current.length + 1 + paragraph.length <= target) {
      current = `${current}\n${paragraph}`;
    } else {
      chunks.push(current);
      current = paragraph;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

function splitParagraphs(text: string, target: number): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\n+/)) {
    const paragraph = raw.trim();
    if (paragraph === '') continue;
    for (let i = 0; i < paragraph.length; i += target) {
      out.push(paragraph.slice(i, i + target));
    }
  }
  return out;
}
