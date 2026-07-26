// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import {
  initInlineChanges, showInlineChanges, hideInlineChanges, isInlineChangesActive,
  applyInlineChange, rejectInlineChange, applyAllInlineChanges, getPendingChange,
} from '../src/inlineChanges.js';
import { getStatus, hasPending, setStatus, subscribe } from '../src/changeSession.js';
import { createChangeSet } from '../src/diffEngine.js';
import { store } from '../src/store.js';

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

describe('apply semantics — what applying actually writes to the store', () => {
  // Résumé with id-bearing experience entries so createChangeSet's diff can
  // match array items the way production data does.
  const baseData = () => ({
    summary: 'Old summary',
    name: 'A',
    experience: [
      { id: 'e1', title: 'Dev', company: 'Acme', bullets: ['x'] },
      { id: 'e2', title: 'PM', company: 'Beta', bullets: ['y'] },
    ],
  });

  beforeEach(() => {
    store.setData(baseData(), true, null);
  });

  it('applying a MODIFY writes change.newValue to the store', () => {
    showInlineChanges(makeChangeSet([
      { path: 'summary', type: 'modify', newValue: 'New summary' },
    ]));
    applyInlineChange('summary');
    expect(store.get('summary')).toBe('New summary');
  });

  it('applying a change whose path is absent from proposedChanges still writes the value', () => {
    // A container-path proposal (the whole experience array): the diff
    // decomposes it into leaf changes whose paths are NOT keys of
    // proposedChanges — so `store.update(path, proposedChanges[path])` would
    // write undefined and blank the field.
    const proposed = baseData().experience;
    proposed[0].title = 'Senior Dev';
    const changeSet = createChangeSet(store.getData(), { experience: proposed });

    const change = changeSet.changes.find((c) => c.path === 'experience[0].title');
    expect(change).toBeTruthy();
    expect(change.newValue).toBe('Senior Dev');
    // The finding-1 precondition: this leaf path is absent from proposedChanges.
    expect(changeSet.proposedChanges[change.path]).toBeUndefined();

    showInlineChanges(changeSet);
    applyInlineChange('experience[0].title');
    expect(store.get('experience[0].title')).toBe('Senior Dev');
  });

  it('applying a REMOVE on an array path splices the element out (no hole)', () => {
    // Propose dropping e1: the diff emits a REMOVE change at experience[0].
    const changeSet = createChangeSet(store.getData(), {
      experience: baseData().experience.filter((e) => e.id !== 'e1'),
    });
    const change = changeSet.changes.find((c) => c.path === 'experience[0]');
    expect(change?.type).toBe('remove');

    showInlineChanges(changeSet);
    applyInlineChange('experience[0]');

    const experience = store.get('experience');
    expect(experience).toHaveLength(1);
    expect(experience[0].id).toBe('e2');
    // Writing a value instead of splicing would leave an undefined/null hole.
    expect(experience.every((e) => e != null)).toBe(true);
  });

  it('bulk dismiss from another surface keeps applied writes, drops the rest, and notifies', () => {
    // Task 14 contract: DiffDialog's "Reject All" calls hideInlineChanges() as
    // the bulk-dismiss path. Prior applies must survive in the store, undecided
    // paths must never be written, and subscribers (the chat message's buttons,
    // the dialog itself) must be told so every surface stands down together.
    showInlineChanges(makeChangeSet([
      { path: 'summary', type: 'modify', newValue: 'New summary' },
      { path: 'name', type: 'modify', newValue: 'B' },
    ]));
    applyInlineChange('summary');

    let notified = 0;
    const unsub = subscribe(() => notified++);
    hideInlineChanges();
    unsub();

    expect(notified).toBe(1); // endSession reached every subscriber
    expect(isInlineChangesActive()).toBe(false);
    expect(hasPending()).toBe(false);
    expect(store.get('summary')).toBe('New summary'); // applied before dismiss — kept
    expect(store.get('name')).toBe('A'); // still pending at dismiss — never written
  });

  it('loading a different document ends the in-flight session', () => {
    // A proposal made against résumé A must not survive into résumé B:
    // renderCurrentResume would project A's pending changes onto B's data, and
    // an apply (inline hover, or a still-open DiffDialog delegating here)
    // would write A's proposed value into B. initInlineChanges hooks the
    // store's 'dataLoaded' — the event every document load emits — to end the
    // session centrally.
    initInlineChanges(() => {});
    showInlineChanges(makeChangeSet([
      { path: 'summary', type: 'modify', newValue: 'A improved' },
    ]));
    expect(isInlineChangesActive()).toBe(true);

    // Switch to résumé B (variant switch / import / restore all land here).
    store.setData({ summary: 'Resume B summary', name: 'B' }, true, null);

    expect(isInlineChangesActive()).toBe(false);
    expect(hasPending()).toBe(false);
    // A stale apply — e.g. a click queued against the old preview — must
    // no-op instead of writing A's proposal into B.
    applyInlineChange('summary');
    expect(store.get('summary')).toBe('Resume B summary');
  });

  it('first load with no session in flight is a harmless no-op', () => {
    initInlineChanges(() => {});
    expect(isInlineChangesActive()).toBe(false);
    store.setData(baseData(), true, null);
    expect(isInlineChangesActive()).toBe(false);
    expect(store.get('summary')).toBe('Old summary');
  });

  it('apply-all applies every pending change and skips rejected ones', () => {
    const changeSet = createChangeSet(store.getData(), {
      summary: 'New summary',
      name: 'B',
      experience: baseData().experience.filter((e) => e.id !== 'e1'),
    });

    showInlineChanges(changeSet);
    rejectInlineChange('name');
    applyAllInlineChanges();

    expect(store.get('summary')).toBe('New summary');
    expect(store.get('name')).toBe('A'); // rejected — never written
    const experience = store.get('experience');
    expect(experience).toHaveLength(1);
    expect(experience[0].id).toBe('e2');
    expect(isInlineChangesActive()).toBe(false);
  });
});

describe('container-path changes resolve from descendant paths', () => {
  // Whole-item adds/removes carry container paths (`experience[1]`) the
  // renderer never emits — the hover always lands on a descendant node, and
  // the menu must still surface Apply/Reject for the container change.
  const baseData = () => ({
    experience: [
      { id: 'e1', title: 'Dev', company: 'Acme', bullets: ['x'] },
      { id: 'e2', title: 'PM', company: 'Beta', bullets: ['y'] },
    ],
  });

  beforeEach(() => {
    store.setData(baseData(), true, null);
  });

  it('resolves a pending container change from any descendant path', () => {
    const change = {
      path: 'experience[1]', type: 'add',
      newValue: { title: 'New role', company: 'C', bullets: ['z'] },
    };
    showInlineChanges(makeChangeSet([change]));
    expect(getPendingChange('experience[1].title')).toBe(change);
    expect(getPendingChange('experience[1].bullets[0]')).toBe(change);
    // The resolved change keeps its own container path — that is what the
    // menu's Apply/Reject buttons must act on.
    expect(getPendingChange('experience[1].title').path).toBe('experience[1]');
  });

  it('boundary rule: experience[10].title never resolves experience[1]', () => {
    showInlineChanges(makeChangeSet([
      { path: 'experience[1]', type: 'remove', newValue: null },
    ]));
    expect(getPendingChange('experience[10].title')).toBeNull();
  });

  it('an exact-path change wins over an ancestor, and stops resolving once decided', () => {
    const leaf = { path: 'experience[1].title', type: 'modify', newValue: 'T' };
    const container = { path: 'experience[1]', type: 'add', newValue: {} };
    showInlineChanges(makeChangeSet([container, leaf]));
    expect(getPendingChange('experience[1].title')).toBe(leaf);

    // Once the container change is decided, its descendants must fall back to
    // the normal AI-context menu — not keep offering a dead Apply/Reject.
    showInlineChanges(makeChangeSet([container]));
    rejectInlineChange('experience[1]');
    expect(getPendingChange('experience[1].bullets[0]')).toBeNull();
  });

  it('applying the resolved container change removes the whole item (splice)', () => {
    // Real diff: dropping e1 emits a whole-item REMOVE at experience[0].
    const changeSet = createChangeSet(store.getData(), {
      experience: baseData().experience.filter((e) => e.id !== 'e1'),
    });
    showInlineChanges(changeSet);

    // Hover lands on a rendered descendant of the doomed item.
    const resolved = getPendingChange('experience[0].title');
    expect(resolved?.path).toBe('experience[0]');
    expect(resolved?.type).toBe('remove');

    applyInlineChange(resolved.path);
    const experience = store.get('experience');
    expect(experience).toHaveLength(1);
    expect(experience[0].id).toBe('e2');
    expect(experience.every((e) => e != null)).toBe(true);
  });
});
