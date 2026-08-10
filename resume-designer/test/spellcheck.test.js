import { describe, it, expect } from 'vitest';
import { shouldSpellcheck, EDITABLE_TEXT_ATTRS } from '../src/spellcheck.js';

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

describe('EDITABLE_TEXT_ATTRS', () => {
  it('round-trips onto a real element the way inlineEditor applies and removes it', () => {
    const element = document.createElement('div');

    for (const [attr, value] of Object.entries(EDITABLE_TEXT_ATTRS)) {
      element.setAttribute(attr, value);
    }
    expect(element.getAttribute('autocorrect')).toBe('off');
    expect(element.getAttribute('autocapitalize')).toBe('off');

    for (const attr of Object.keys(EDITABLE_TEXT_ATTRS)) element.removeAttribute(attr);
    expect(element.hasAttribute('autocorrect')).toBe(false);
    expect(element.hasAttribute('autocapitalize')).toBe(false);
  });
});
