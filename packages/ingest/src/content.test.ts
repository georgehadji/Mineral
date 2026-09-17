import { describe, expect, it } from 'vitest';
import { chunkText, htmlToText, sha256 } from './content.ts';

describe('sha256', () => {
  it('is stable and changes with the bytes', () => {
    expect(sha256('abc')).toBe(sha256('abc'));
    expect(sha256('abc')).not.toBe(sha256('abd'));
    expect(sha256('abc')).toHaveLength(64);
  });
});

describe('htmlToText', () => {
  it('drops script and style content instead of storing it as prose', () => {
    const text = htmlToText('<p>Revenue</p><script>var x = "hidden";</script><style>p{}</style>');
    expect(text).toBe('Revenue');
  });

  it('decodes named and numeric entities', () => {
    expect(htmlToText('<p>R&amp;D rose 5&#37; in Q1&#x2019;s quarter</p>')).toBe(
      "R&D rose 5% in Q1’s quarter",
    );
  });

  it('drops the page furniture SEC leaves at every page break', () => {
    // Once the tags are gone, the page number and the running link land in the
    // middle of whatever sentence spanned the break.
    const paged =
      '<p>the latest technical reports, the</p><p>6</p><p>Table of Contents</p>' +
      '<p>mine contains both light and heavy elements</p>';
    expect(htmlToText(paged)).toBe(
      'the latest technical reports, the\nmine contains both light and heavy elements',
    );
  });

  it("keeps the filing's own contents heading, which is real content", () => {
    expect(htmlToText('<p>TABLE OF CONTENTS</p><p>Item 1.</p>')).toBe('TABLE OF CONTENTS\nItem 1.');
  });

  it('keeps a lone number that is not sitting on a page break', () => {
    expect(htmlToText('<p>Revenue</p><p>2024</p><p>Total</p>')).toBe('Revenue\n2024\nTotal');
  });

  it('drops zero-width characters that would break a quote invisibly', () => {
    expect(htmlToText('<p>rare​earth</p>')).toBe('rareearth');
  });

  it('turns block boundaries into line breaks and collapses the rest', () => {
    expect(htmlToText('<div>Item 1.</div><div>Business</div>')).toBe('Item 1.\nBusiness');
    expect(htmlToText('<p>a   b</p>')).toBe('a b');
  });
});

describe('chunkText', () => {
  const text = ['alpha', 'beta', 'gamma'].join('\n\n');

  it('packs paragraphs up to the target and keeps them whole', () => {
    expect(chunkText(text, { targetChars: 12 })).toEqual(['alpha\nbeta', 'gamma']);
  });

  it('is deterministic, which is what makes re-ingest a no-op', () => {
    expect(chunkText(text, { targetChars: 12 })).toEqual(chunkText(text, { targetChars: 12 }));
  });

  it('hard-splits a paragraph longer than the target', () => {
    expect(chunkText('abcdefg', { targetChars: 3 })).toEqual(['abc', 'def', 'g']);
  });

  it('never exceeds the target and loses no content', () => {
    const long = Array.from({ length: 50 }, (_, i) => `paragraph number ${i}`).join('\n');
    const chunks = chunkText(long, { targetChars: 40 });
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThanOrEqual(40);
    expect(chunks.join('\n')).toBe(long);
  });

  it('returns nothing for empty text', () => {
    expect(chunkText('   \n\n  ')).toEqual([]);
  });
});
