// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyPendingToData, markChangedNodes, clearChangeMarks } from '../src/changePreview.js';
import { createChangeSet } from '../src/diffEngine.js';

const changeSet = {
  changes: [
    { path: 'summary', type: 'modify', oldValue: 'Old', newValue: 'New **bold**' },
    { path: 'name', type: 'modify', oldValue: 'A', newValue: 'B' },
  ],
  proposedChanges: { summary: 'New **bold**', name: 'B' },
};

describe('applyPendingToData', () => {
  it('projects pending changes without mutating the original', () => {
    const data = { summary: 'Old', name: 'A' };
    const next = applyPendingToData(data, changeSet, new Map());
    expect(next.summary).toBe('New **bold**');
    expect(data.summary).toBe('Old');
  });

  it('leaves rejected paths at their original value', () => {
    const next = applyPendingToData({ summary: 'Old', name: 'A' }, changeSet,
      new Map([['summary', 'rejected']]));
    expect(next.summary).toBe('Old');
    expect(next.name).toBe('B');
  });

  it('leaves applied paths alone — the store already holds them', () => {
    // The store value has diverged from the proposal (the user edited it after
    // applying). Re-projecting an applied path would clobber that edit, so the
    // diverged value must survive projection untouched.
    const next = applyPendingToData({ summary: 'New **bold** (edited by user)', name: 'A' },
      changeSet, new Map([['summary', 'applied']]));
    expect(next.summary).toBe('New **bold** (edited by user)');
  });
});

describe('applyPendingToData with container-keyed proposals', () => {
  // The model has no leaf "delete" syntax: a removal arrives as the whole
  // shortened array (proposedChanges keyed by the CONTAINER path). The diff
  // decomposes that into leaf changes — the same key space as the status map,
  // markChangedNodes and applyChangeToStore — so the projection must work at
  // leaf granularity too, not re-apply whole containers.

  it('keeps a pending REMOVE visible and markable instead of vanishing it', () => {
    const data = {
      experience: [{ id: 'e1', title: 'T', company: 'C', bullets: ['keep me', 'drop me'] }],
    };
    const cs = createChangeSet(data, { 'experience[0].bullets': ['keep me'] });
    // Sanity: the diff really decomposed the container into a leaf REMOVE.
    expect(cs.changes.some(
      (c) => c.path === 'experience[0].bullets[1]' && c.type === 'remove'
    )).toBe(true);

    // The doomed bullet must survive projection: it needs a rendered node to
    // carry the "to be removed" highlight and the inline reject control.
    const next = applyPendingToData(data, cs, new Map());
    expect(next.experience[0].bullets).toEqual(['keep me', 'drop me']);

    // And that node gets tagged as a pending removal.
    document.body.innerHTML =
      '<div id="root"><p data-editable="experience[0].bullets[1]">drop me</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, cs, new Map());
    expect(root.querySelector('p').dataset.changeStatus).toBe('pending');
    expect(root.querySelector('p').dataset.changeType).toBe('remove');
  });

  it('shows the ORIGINAL value for a rejected leaf while a sibling stays pending', () => {
    const data = { skills: ['JS', 'CSS'] };
    const cs = createChangeSet(data, { skills: ['TypeScript', 'Tailwind'] });
    expect(cs.changes.map((c) => c.path).sort()).toEqual(['skills[0]', 'skills[1]']);

    // Rejecting skills[1] while skills[0] is still pending: the rejected leaf
    // must show its original value — a rejected leaf gets no highlight, so a
    // re-applied proposal there would read as accepted résumé text.
    const next = applyPendingToData(data, cs, new Map([['skills[1]', 'rejected']]));
    expect(next.skills[0]).toBe('TypeScript');
    expect(next.skills[1]).toBe('CSS');
  });
});

describe('markChangedNodes', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('marks EVERY node for a path, not just the first', () => {
    // Pagination clones nodes across pages, so a path legitimately matches more
    // than one element. The old code took querySelector's first hit and often
    // marked an off-screen clone.
    document.body.innerHTML = `
      <div id="root">
        <p data-editable="summary">x</p>
        <p data-editable="summary">x</p>
      </div>`;
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    const marked = root.querySelectorAll('[data-change-status="pending"]');
    expect(marked).toHaveLength(2);
  });

  it('does not touch node text', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="summary">original</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    expect(root.querySelector('p').textContent).toBe('original');
  });

  it('escapes paths containing brackets', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="experience[0].bullets[1]">x</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, {
      changes: [{ path: 'experience[0].bullets[1]', type: 'modify' }],
      proposedChanges: {},
    }, new Map());
    expect(root.querySelector('p').dataset.changeStatus).toBe('pending');
  });

  it('escapes quotes and backslashes in paths', () => {
    // Brackets and dots are literal inside a quoted attribute selector — the
    // characters escapeAttr actually exists for are `"` and `\`.
    document.body.innerHTML = '<div id="root"><p>x</p></div>';
    const root = document.getElementById('root');
    const path = 'sections["Awards"].note\\alt';
    root.querySelector('p').setAttribute('data-editable', path);
    markChangedNodes(root, {
      changes: [{ path, type: 'modify' }],
      proposedChanges: {},
    }, new Map());
    expect(root.querySelector('p').dataset.changeStatus).toBe('pending');
  });

  it('clearChangeMarks removes every marker', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="summary">x</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    clearChangeMarks(root);
    expect(root.querySelector('p').dataset.changeStatus).toBeUndefined();
  });
});
