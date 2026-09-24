import { describe, expect, it } from 'vitest';
import { promptVersionLabel } from './research-repository.ts';

describe('prompt version label', () => {
  // A stored prompt row is never updated, so an edit that keeps the label would
  // leave every later run naming text it was not sent.
  it('changes when the text changes, even if the declared version does not', () => {
    const before = promptVersionLabel('1.1.0', 'Never state a number that is not in the evidence.', '{}');
    const after = promptVersionLabel('1.1.0', "Every number must be in the claim's own evidence.", '{}');
    expect(after).not.toBe(before);
    expect(after.startsWith('1.1.0+')).toBe(true);
  });

  it('is stable for the same text, so a rerun reuses the row', () => {
    expect(promptVersionLabel('1.0.0', 'same', '{}')).toBe(promptVersionLabel('1.0.0', 'same', '{}'));
  });
});
