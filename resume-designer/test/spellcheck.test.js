import { describe, it, expect } from 'vitest';
import { shouldSpellcheck } from '../src/spellcheck.js';

describe('shouldSpellcheck', () => {
  it('enables spellcheck for prose fields', () => {
    expect(shouldSpellcheck('prose')).toBe(true);
    expect(shouldSpellcheck(undefined)).toBe(true);
  });

  it('disables spellcheck for identifier fields', () => {
    expect(shouldSpellcheck('identifier')).toBe(false);
  });

  it('disables spellcheck for every kind the opt-out sites use', () => {
    // The shipped opt-outs: API key + bridge token ('identifier'), model slug
    // ('slug'), project URL ('url'). Each must keep resolving to false, i.e.
    // the exact spellCheck={false} behaviour the literals had.
    expect(shouldSpellcheck('slug')).toBe(false);
    expect(shouldSpellcheck('url')).toBe(false);
  });
});
