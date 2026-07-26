// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { applyPendingToData, markChangedNodes, clearChangeMarks } from '../src/changePreview.js';

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
    const next = applyPendingToData({ summary: 'New **bold**', name: 'A' }, changeSet,
      new Map([['summary', 'applied']]));
    expect(next.summary).toBe('New **bold**');
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

  it('clearChangeMarks removes every marker', () => {
    document.body.innerHTML = '<div id="root"><p data-editable="summary">x</p></div>';
    const root = document.getElementById('root');
    markChangedNodes(root, changeSet, new Map());
    clearChangeMarks(root);
    expect(root.querySelector('p').dataset.changeStatus).toBeUndefined();
  });
});
