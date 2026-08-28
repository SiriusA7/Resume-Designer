import { describe, it, expect, vi } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
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

  it('uses camelCase keys, the spellings React recognizes as DOM props', () => {
    // ProfileTabs.jsx spreads this object into JSX (`{...EDITABLE_TEXT_ATTRS}`).
    // React only recognizes camelCase `autoCorrect`/`autoCapitalize` as valid DOM
    // props — the lowercase HTML attribute spellings log an "Invalid DOM
    // property" warning once per prop, per render. Lock in the camelCase keys so
    // nobody "tidies" them back to lowercase.
    expect(Object.keys(EDITABLE_TEXT_ATTRS).sort()).toEqual(['autoCapitalize', 'autoCorrect']);
  });

  it('renders the correct lowercase DOM attributes with no React warning when spread as JSX props', () => {
    const container = document.createElement('div');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const root = createRoot(container);
    try {
      flushSync(() => {
        root.render(createElement('input', { ...EDITABLE_TEXT_ATTRS }));
      });

      const input = container.querySelector('input');
      expect(input.getAttribute('autocorrect')).toBe('off');
      expect(input.getAttribute('autocapitalize')).toBe('off');
      // The bug this locks in: lowercase keys ('autocorrect'/'autocapitalize')
      // are not valid React DOM props and trigger a console.error per prop.
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      root.unmount();
      consoleError.mockRestore();
    }
  });
});
