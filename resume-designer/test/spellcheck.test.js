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
});
