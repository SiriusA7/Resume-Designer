// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { showInlineChanges, hideInlineChanges, isInlineChangesActive } from '../src/inlineChanges.js';
import { getStatus, hasPending, setStatus } from '../src/changeSession.js';

function makeChangeSet(changes) {
  return {
    changes,
    proposedChanges: Object.fromEntries(changes.map((c) => [c.path, c.newValue])),
    getSummary: () => ({
      added: 0, removed: 0, modified: changes.length, total: changes.length,
    }),
  };
}

beforeEach(() => {
  document.body.innerHTML = '';
  hideInlineChanges();
});

describe('inlineChanges → changeSession', () => {
  it('starting a preview makes every change pending in the session', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'New' }]));
    expect(isInlineChangesActive()).toBe(true);
    expect(getStatus('summary')).toBe('pending');
  });

  it('a decision made elsewhere is visible here — surfaces converge', () => {
    showInlineChanges(makeChangeSet([
      { path: 'summary', type: 'modify', newValue: 'New' },
      { path: 'name', type: 'modify', newValue: 'B' },
    ]));
    // Simulates DiffDialog applying one change.
    setStatus('summary', 'applied');
    expect(getStatus('summary')).toBe('applied');
    expect(hasPending()).toBe(true);
    setStatus('name', 'applied');
    expect(hasPending()).toBe(false);
  });

  it('a second preview replaces the first rather than leaking its state', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'One' }]));
    setStatus('summary', 'applied');
    showInlineChanges(makeChangeSet([{ path: 'name', type: 'modify', newValue: 'Two' }]));
    expect(getStatus('summary')).toBe('pending');
    expect(getStatus('name')).toBe('pending');
  });

  it('hiding ends the session', () => {
    showInlineChanges(makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'New' }]));
    hideInlineChanges();
    expect(isInlineChangesActive()).toBe(false);
    expect(hasPending()).toBe(false);
  });
});
