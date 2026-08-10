import { describe, it, expect } from 'vitest';
import { shouldSpellcheck, shouldAutocorrect, EDITABLE_TEXT_ATTRS } from '../src/spellcheck.js';

describe('shouldSpellcheck', () => {
  it('spellchecks prose and unknown kinds', () => {
    expect(shouldSpellcheck('prose')).toBe(true);
    expect(shouldSpellcheck(undefined)).toBe(true);
  });

  it('does not spellcheck identifiers', () => {
    // Real opt-out sites: API key + bridge token ('identifier', SettingsDialog.jsx),
    // model slug ('slug'), project URL ('url'). Pre-existing coverage — keep it.
    expect(shouldSpellcheck('identifier')).toBe(false);
    expect(shouldSpellcheck('slug')).toBe(false);
    expect(shouldSpellcheck('url')).toBe(false);
  });
});

describe('shouldAutocorrect', () => {
  it('is false for résumé prose — an autocorrection here is persisted silently', () => {
    // Résumé text round-trips through textContent straight into the store, and
    // the live value contains raw markdown markers that smart punctuation eats.
    expect(shouldAutocorrect('prose')).toBe(false);
    expect(shouldAutocorrect(undefined)).toBe(false);
  });

  it('is false for identifiers too', () => {
    expect(shouldAutocorrect('slug')).toBe(false);
  });

  it('is true only where the user is composing free text for a machine to read', () => {
    expect(shouldAutocorrect('chat')).toBe(true);
  });
});

describe('EDITABLE_TEXT_ATTRS', () => {
  it('turns off every WebKit text-substitution behaviour', () => {
    expect(EDITABLE_TEXT_ATTRS).toEqual({
      autocorrect: 'off',
      autocapitalize: 'off',
      autocomplete: 'off',
    });
  });
});
