// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { showInlineChanges, hideInlineChanges } from '../src/inlineChanges.js';

// Regression for the Codex finding on the next→main flow: requesting a second
// AI change set while one is still pending clobbered the only references to the
// first set's highlighted elements without restoring them — the old proposed
// text and data-has-change markers leaked into the resume with no way to
// dismiss them.

function makeChangeSet(changes) {
  return {
    changes,
    getSummary: () => ({
      added: changes.filter((c) => c.type === 'add').length,
      removed: changes.filter((c) => c.type === 'remove').length,
      modified: changes.filter((c) => c.type === 'modify').length,
    }),
  };
}

function makeEditable(path, text) {
  const el = document.createElement('p');
  el.dataset.editable = path;
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

describe('showInlineChanges — replacing a pending change set', () => {
  let summaryEl;
  let nameEl;

  beforeEach(() => {
    document.body.replaceChildren();
    const preview = document.createElement('div');
    preview.className = 'preview-area';
    document.body.appendChild(preview);
    summaryEl = makeEditable('summary', 'original summary');
    nameEl = makeEditable('name', 'original name');
  });

  it('restores the previous set\'s elements before highlighting the new set', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'AI summary A' }]));
    expect(summaryEl.textContent).toBe('AI summary A');
    expect(summaryEl.dataset.hasChange).toBe('modify');

    showInlineChanges(makeChangeSet([{ path: 'name', type: 'modify', newValue: 'AI name B' }]));

    // The first set must be fully unwound…
    expect(summaryEl.textContent).toBe('original summary');
    expect(summaryEl.dataset.hasChange).toBeUndefined();
    expect(summaryEl.dataset.changePath).toBeUndefined();
    // …and the new set active.
    expect(nameEl.textContent).toBe('AI name B');
    expect(nameEl.dataset.hasChange).toBe('modify');

    hideInlineChanges();
    expect(nameEl.textContent).toBe('original name');
  });

  it('dismissing after a replacement clears everything', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'AI summary A' }]));
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'AI summary B' }]));
    hideInlineChanges();
    expect(summaryEl.textContent).toBe('original summary');
    expect(summaryEl.dataset.hasChange).toBeUndefined();
    expect(document.getElementById('inline-changes-banner')).toBeNull();
  });
});
