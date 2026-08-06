// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { isSupersededSession } from '../src/changeSessionGuard.js';
import {
  showInlineChanges, hideInlineChanges, applyInlineChange, applyAllInlineChanges,
} from '../src/inlineChanges.js';
import { getChangeSet } from '../src/changeSession.js';
import { store } from '../src/store.js';

// DiffDialog cannot be mounted here (no component test infrastructure), so the
// guard's decision logic is extracted as the pure isSupersededSession and
// tested against the real session + delegates + store. The scenario: an owned
// dialog latches set A at open; the user's follow-up request finishes
// streaming behind the modal and showInlineChanges(B) replaces the session
// WITHOUT ending it; the dialog's delegates now resolve against B. DiffDialog
// gates every owned action (buttons and the A / R / Enter keyboard paths route
// through the same handlers) on this predicate.

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
  store.setData({ summary: 'Old summary', name: 'A' }, true, null);
});

describe('isSupersededSession — the predicate owned actions are gated on', () => {
  const setA = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From A' }]);
  const setB = makeChangeSet([{ path: 'name', type: 'modify', newValue: 'From B' }]);

  it('trips only for an owned dialog whose displayed set differs from a live one', () => {
    expect(isSupersededSession(setA, setB, true)).toBe(true);
  });

  it('a dialog still displaying the live set is not superseded', () => {
    expect(isSupersededSession(setA, setA, true)).toBe(false);
  });

  it('an ended session (null live set) is not supersession — the auto-close grace stays', () => {
    expect(isSupersededSession(setA, null, true)).toBe(false);
  });

  it('standalone dialogs (Jobs / History) are never superseded by session churn', () => {
    expect(isSupersededSession(setA, setB, false)).toBe(false);
  });

  it('nothing displayed, nothing to supersede', () => {
    expect(isSupersededSession(null, setB, true)).toBe(false);
  });
});

describe('a superseded owned dialog cannot apply the replacement set', () => {
  it('startSession replaces without ending — getChangeSet() identity is the signal', () => {
    const setA = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From A' }]);
    const setB = makeChangeSet([{ path: 'name', type: 'modify', newValue: 'From B' }]);
    showInlineChanges(setA); // dialog opens owned, latching setA
    expect(isSupersededSession(setA, getChangeSet(), true)).toBe(false);
    showInlineChanges(setB); // follow-up stream lands behind the open dialog
    expect(getChangeSet()).toBe(setB); // replaced, NOT ended (non-null)…
    expect(isSupersededSession(setA, getChangeSet(), true)).toBe(true); // …so the guard trips
  });

  it('gated Apply All never writes the never-displayed set', () => {
    const setA = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From A' }]);
    const setB = makeChangeSet([{ path: 'name', type: 'modify', newValue: 'From B' }]);
    showInlineChanges(setA);
    showInlineChanges(setB);
    // DiffDialog's applyAll in owned mode: gate, then delegate.
    if (!isSupersededSession(setA, getChangeSet(), true)) applyAllInlineChanges();
    expect(store.get('name')).toBe('A'); // B's changes were not applied
    expect(store.get('summary')).toBe('Old summary'); // and nothing of A either — no write at all
    // The gate is load-bearing: the raw delegate resolves against the LIVE
    // session and would have written B's never-displayed change.
    applyAllInlineChanges();
    expect(store.get('name')).toBe('From B');
  });

  it('gated per-path Apply skips a path both sets share instead of writing the live value', () => {
    const setA = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From A' }]);
    const setB = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From B' }]);
    showInlineChanges(setA);
    showInlineChanges(setB);
    if (!isSupersededSession(setA, getChangeSet(), true)) applyInlineChange('summary');
    expect(store.get('summary')).toBe('Old summary'); // displayed "From A", would write "From B" — blocked
    applyInlineChange('summary'); // the raw delegate writes the live set's value
    expect(store.get('summary')).toBe('From B');
  });

  it('an owned dialog outliving its ended session stays safe without the guard tripping', () => {
    const setA = makeChangeSet([{ path: 'summary', type: 'modify', newValue: 'From A' }]);
    showInlineChanges(setA);
    applyInlineChange('summary'); // last pending decided → session ends
    expect(getChangeSet()).toBe(null);
    expect(isSupersededSession(setA, getChangeSet(), true)).toBe(false); // grace window, not supersession
    applyAllInlineChanges(); // delegates are null-safe no-ops during the grace
    expect(store.get('summary')).toBe('From A');
  });
});
