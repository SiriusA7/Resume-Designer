// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyPendingToData, markChangedNodes, clearChangeMarks, isDescendantPath,
} from '../src/changePreview.js';
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

// The preview must show what accepting produces — this module's own contract.
// Two experience writes touch more than the leaf they name, so projecting them
// as plain scalars showed something the apply path would never produce.
describe('applyPendingToData — writes that touch more than their leaf', () => {
  const run = (company) => ([
    { id: 'a', company, title: 'Senior Engineer', dates: 'Mar 2022 – Present', _groupId: 'g1', bullets: [] },
    { id: 'b', company, title: 'Engineer', dates: 'Jan 2020 – Mar 2022', _groupId: 'g1', bullets: [] },
  ]);

  it('previews a grouped rename across the whole run, not a split one', () => {
    const next = applyPendingToData(
      { experience: run('Acme') },
      { changes: [{ path: 'experience[0].company', type: 'modify', oldValue: 'Acme', newValue: 'Acme Corp' }] },
      new Map(),
    );

    // A plain setByPath left this as ['Acme Corp', 'Acme'] — the user reviewed a
    // run split down the middle that accepting would never produce.
    expect(next.experience.map((e) => e.company)).toEqual(['Acme Corp', 'Acme Corp']);
  });

  it('previews the R2 clear beside a dates edit', () => {
    const next = applyPendingToData(
      { experience: [{ id: 'a', company: 'Acme', dates: 'Jan 2020 – Mar 2022', startDate: '2020-01', endDate: '2022-03', bullets: [] }] },
      { changes: [{ path: 'experience[0].dates', type: 'modify', oldValue: 'Jan 2020 – Mar 2022', newValue: '2019 – 2024' }] },
      new Map(),
    );

    expect(next.experience[0].dates).toBe('2019 – 2024');
    expect(next.experience[0].startDate).toBe('');
    expect(next.experience[0].endDate).toBe('');
  });

  it('leaves a rejected grouped rename entirely alone', () => {
    const next = applyPendingToData(
      { experience: run('Acme') },
      { changes: [{ path: 'experience[0].company', type: 'modify', oldValue: 'Acme', newValue: 'Acme Corp' }] },
      new Map([['experience[0].company', 'rejected']]),
    );

    expect(next.experience.map((e) => e.company)).toEqual(['Acme', 'Acme']);
  });

  it('does not fan a solo employer out over its neighbours', () => {
    const next = applyPendingToData(
      { experience: [...run('Acme'), { id: 'c', company: 'Globex', title: 'Analyst', dates: '2018 – 2020', bullets: [] }] },
      { changes: [{ path: 'experience[2].company', type: 'modify', oldValue: 'Globex', newValue: 'Globex Inc' }] },
      new Map(),
    );

    expect(next.experience.map((e) => e.company)).toEqual(['Acme', 'Acme', 'Globex Inc']);
  });

  it('does not mutate the caller\'s data', () => {
    const data = { experience: run('Acme') };
    applyPendingToData(
      data,
      { changes: [{ path: 'experience[0].company', type: 'modify', oldValue: 'Acme', newValue: 'Acme Corp' }] },
      new Map(),
    );

    expect(data.experience.map((e) => e.company)).toEqual(['Acme', 'Acme']);
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
    // re-applied proposal there would read as accepted resume text.
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

describe('markChangedNodes — whole-item container changes', () => {
  // Whole-item adds/removes carry container paths (`experience[1]`) that the
  // renderer never emits: only descendants (`experience[1].title`, …) carry
  // data-editable. Without the descendant fallback those changes were
  // invisible — nothing highlighted, nothing hoverable.
  beforeEach(() => { document.body.innerHTML = ''; });

  const containerSet = (path, type) => ({ changes: [{ path, type }], proposedChanges: {} });

  it('a container-path change marks all of its rendered descendants', () => {
    document.body.innerHTML = `
      <div id="root">
        <p data-editable="experience[1].title">t</p>
        <p data-editable="experience[1].bullets[0]">b0</p>
        <p data-editable="experience[1].bullets[1]">b1</p>
        <p data-editable="experience[0].title">other item</p>
        <p data-editable="summary">unrelated</p>
      </div>`;
    const root = document.getElementById('root');
    markChangedNodes(root, containerSet('experience[1]', 'add'), new Map());
    const marked = Array.from(root.querySelectorAll('[data-change-status="pending"]'))
      .map((el) => el.dataset.editable).sort();
    expect(marked).toEqual([
      'experience[1].bullets[0]', 'experience[1].bullets[1]', 'experience[1].title',
    ]);
    expect(root.querySelector('[data-editable="experience[1].title"]').dataset.changeType)
      .toBe('add');
  });

  it('boundary rule: experience[1] never marks experience[10].title', () => {
    document.body.innerHTML = `
      <div id="root">
        <p data-editable="experience[10].title">tenth item</p>
        <p data-editable="experience[1].title">first item</p>
      </div>`;
    const root = document.getElementById('root');
    markChangedNodes(root, containerSet('experience[1]', 'remove'), new Map());
    expect(root.querySelector('[data-editable="experience[10].title"]').dataset.changeStatus)
      .toBeUndefined();
    expect(root.querySelector('[data-editable="experience[1].title"]').dataset.changeStatus)
      .toBe('pending');
  });

  it('an exact-match change marks only its own node, never descendants', () => {
    // The fallback must be a FALLBACK: when the exact path matches, prefix
    // matching must not run — that loose `^=` behaviour is the old bug where a
    // leaf change grabbed an arbitrary wrong node.
    document.body.innerHTML = `
      <div id="root">
        <p data-editable="sections[1]">exact</p>
        <p data-editable="sections[1].title">descendant</p>
      </div>`;
    const root = document.getElementById('root');
    markChangedNodes(root, containerSet('sections[1]', 'modify'), new Map());
    expect(root.querySelector('[data-editable="sections[1]"]').dataset.changeStatus)
      .toBe('pending');
    expect(root.querySelector('[data-editable="sections[1].title"]').dataset.changeStatus)
      .toBeUndefined();
  });
});

describe('isDescendantPath — the segment-boundary rule', () => {
  it('requires a `.` or `[` boundary right after the ancestor', () => {
    expect(isDescendantPath('experience[1].title', 'experience[1]')).toBe(true);
    expect(isDescendantPath('experience[1].bullets[0]', 'experience[1]')).toBe(true);
    expect(isDescendantPath('experience[0].title', 'experience')).toBe(true);
    expect(isDescendantPath('sections[1].content[0]', 'sections[1]')).toBe(true);
    // Not descendants: sibling indices, equal paths, reversed direction.
    expect(isDescendantPath('experience[10].title', 'experience[1]')).toBe(false);
    expect(isDescendantPath('experience[1]', 'experience[1]')).toBe(false);
    expect(isDescendantPath('experience[1]', 'experience[1].title')).toBe(false);
  });

  it('rejects bare prefixes a naive startsWith would admit (the proof)', () => {
    const naive = (path, ancestor) => path.startsWith(ancestor);
    // The headline pair happens to be rejected by naive startsWith too — the
    // ancestor's trailing `]` breaks the prefix against `[10` by accident:
    expect(naive('experience[10].title', 'experience[1]')).toBe(false);
    // …but for an ancestor NOT ending in `]` the accident evaporates: naive
    // startsWith claims a same-prefix SIBLING field, the boundary rule
    // doesn't. This is what makes the explicit boundary load-bearing rather
    // than a restatement of startsWith.
    expect(naive('experienceNotes', 'experience')).toBe(true);
    expect(isDescendantPath('experienceNotes', 'experience')).toBe(false);
  });
});
