import { describe, it, expect, beforeEach } from 'vitest';
import { applyChangeToStore, applyChangesToStore } from '../src/changeApply.js';
import { diffResumeData } from '../src/diffEngine.js';
import { applyPendingToData } from '../src/changePreview.js';
import { store } from '../src/store.js';

// Applying an ADD on an array-index path used to go through the generic
// path-write, which ASSIGNS (`arr[1] = X`) instead of inserting — so accepting
// a proposal that inserted an entry before an existing one silently deleted the
// entry that followed it.
//
// Only reachable when items carry `id`s: diffArray matches those by id, leaves
// the new item unmatched, and emits a bare ADD at its proposed index. Without
// ids it falls back to positional matching and emits MODIFY + a trailing ADD,
// which was already correct — so both paths are pinned here.

const A = { id: 'a', company: 'Acme', title: 'Engineer' };
const B = { id: 'b', company: 'Beta', title: 'Developer' };
const X = { id: 'x', company: 'Xeno', title: 'Lead' };

const companies = () => store.get('experience').map((e) => e.company);

describe('applyChangeToStore — ADD on an array index', () => {
  beforeEach(() => {
    store.setData({ name: 'Ada', experience: [{ ...A }, { ...B }] }, true, null);
  });

  it('inserts before an existing item instead of overwriting it', () => {
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, B] },
    );
    const add = changes.find((c) => c.type === 'add');
    expect(add, 'diffArray should emit an ADD for the inserted item').toBeDefined();
    expect(add.path).toBe('experience[1]');

    applyChangeToStore(add);

    expect(companies()).toEqual(['Acme', 'Xeno', 'Beta']);
  });

  it('appends when the index is past the current end', () => {
    // Additions are numbered against the proposed array, so an index can sit
    // beyond the live array rather than being invalid.
    applyChangeToStore({ type: 'add', path: 'experience[9]', oldValue: null, newValue: { ...X } });
    expect(companies()).toEqual(['Acme', 'Beta', 'Xeno']);
  });

  it('is a no-op when an item with the same id is already present (re-apply)', () => {
    const add = { type: 'add', path: 'experience[1]', oldValue: null, newValue: { ...X } };
    applyChangeToStore(add);
    applyChangeToStore(add);
    expect(companies()).toEqual(['Acme', 'Xeno', 'Beta']);
  });

  it('matches an existing item by id, not by value, when re-applying', () => {
    applyChangeToStore({ type: 'add', path: 'experience[1]', oldValue: null, newValue: { ...X } });
    // Same id, content edited during review — still the same entry.
    applyChangeToStore({
      type: 'add', path: 'experience[1]', oldValue: null,
      newValue: { ...X, title: 'Principal' },
    });
    expect(companies()).toEqual(['Acme', 'Xeno', 'Beta']);
  });

  // Idempotence and legitimate duplicates are BOTH required, and a global value
  // search can only deliver one of them. The guard asks whether this change's
  // own recorded slot already holds its value: empty on the first apply so the
  // insert happens, occupied on the second so it does not.
  it('preserves a legitimate duplicate value in an id-less array', () => {
    store.setData({ name: 'Ada', skills: ['JS', 'CSS'] }, true, null);
    applyChangesToStore(
      diffResumeData({ skills: ['JS', 'CSS'] }, { skills: ['JS', 'CSS', 'JS'] }),
    );
    expect(store.get('skills')).toEqual(['JS', 'CSS', 'JS']);
  });

  // Reachable for real: a reopened standalone review starts with empty
  // applied-state, so Apply All replays every change.
  it('is a no-op when an id-less addition is applied twice', () => {
    store.setData({ name: 'Ada', skills: ['JS', 'CSS'] }, true, null);
    const add = { type: 'add', path: 'skills[2]', oldValue: null, newValue: 'JS' };
    applyChangeToStore(add);
    applyChangeToStore(add);
    expect(store.get('skills')).toEqual(['JS', 'CSS', 'JS']);
  });

  it('lands two intentional duplicates and stays idempotent on replay', () => {
    store.setData({ name: 'Ada', skills: ['JS', 'CSS'] }, true, null);
    const changes = diffResumeData(
      { skills: ['JS', 'CSS'] },
      { skills: ['JS', 'CSS', 'JS', 'JS'] },
    );
    applyChangesToStore(changes);
    expect(store.get('skills')).toEqual(['JS', 'CSS', 'JS', 'JS']);
    // Each addition owns a distinct slot, so replaying the whole set adds nothing.
    applyChangesToStore(changes);
    expect(store.get('skills')).toEqual(['JS', 'CSS', 'JS', 'JS']);
  });

  it('applies several insertions in order without losing entries', () => {
    const Y = { id: 'y', company: 'Yotta', title: 'Staff' };
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, B, Y] },
    );
    changes.filter((c) => c.type === 'add').forEach(applyChangeToStore);
    expect(companies()).toEqual(['Acme', 'Xeno', 'Beta', 'Yotta']);
  });

  it('still writes through when the path holds no array yet', () => {
    store.setData({ name: 'Ada' }, true, null);
    applyChangeToStore({ type: 'add', path: 'summary', oldValue: null, newValue: 'Hello' });
    expect(store.get('summary')).toBe('Hello');
  });

  // Leaf paths are indexed against the PROPOSED array but written to the LIVE
  // one, and diffArray emits id-matched content edits (first pass) BEFORE
  // additions (last loop). Applied in emitted order, the modify writes past the
  // end of a two-item array — setByPath creates a third entry to hold it — and
  // the insert then makes four, with B never modified.
  it('applies an insertion before an edit to an item the insertion shifts', () => {
    const Bmod = { ...B, title: 'Senior Developer' };
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, Bmod] },
    );
    // Pin the hazard itself: the modify really does come first.
    expect(changes.map((c) => c.type)).toEqual(['modify', 'add']);

    applyChangesToStore(changes);

    const exp = store.get('experience');
    expect(exp).toHaveLength(3);
    expect(exp.map((e) => e.company)).toEqual(['Acme', 'Xeno', 'Beta']);
    expect(exp[2].title).toBe('Senior Developer');
  });

  // Same root cause, mirrored: a removal shifts later items down, so a modify
  // indexed against the proposed array must not run first.
  it('applies a removal before an edit to an item the removal shifts', () => {
    const C = { id: 'c', company: 'Ceta', title: 'Architect' };
    store.setData({ name: 'Ada', experience: [{ ...A }, { ...B }, { ...C }] }, true, null);
    applyChangesToStore(diffResumeData(
      { experience: [A, B, C] },
      { experience: [A, { ...C, title: 'Principal' }] },
    ));
    const exp = store.get('experience');
    expect(exp.map((e) => e.company)).toEqual(['Acme', 'Ceta']);
    expect(exp[1].title).toBe('Principal');
  });

  // Ordering is by DEPENDENCY, not type. A nested structural op addresses an
  // element inside a parent the outer insertion has not created yet, so
  // "all removals, then all additions" runs the nested removal against an
  // experience[2] that does not exist — a silent no-op leaving the bullet in.
  it('applies a parent insertion before a nested structural edit', () => {
    const withBullets = (o, b) => ({ ...o, bullets: b });
    const a = withBullets(A, ['a1']);
    const b = withBullets(B, ['b1', 'b2']);
    const x = withBullets(X, ['x1']);
    store.setData({ name: 'Ada', experience: [{ ...a }, { ...b }] }, true, null);

    const changes = diffResumeData(
      { experience: [a, b] },
      { experience: [a, x, withBullets(B, ['b1'])] },
    );
    // Pin the hazard: the nested removal really is emitted before the insertion.
    expect(changes.map((c) => c.path)).toContain('experience[2].bullets[1]');

    applyChangesToStore(changes);

    const exp = store.get('experience');
    expect(exp.map((e) => e.company)).toEqual(['Acme', 'Xeno', 'Beta']);
    expect(exp[2].bullets).toEqual(['b1']);
  });

  // The preview and the apply path must agree, or the user reviews something
  // other than what accepting produces. Previously the preview projected an ADD
  // with setByPath, so [A,B] -> [A,X,B] previewed as [A,X]: B vanished during
  // review and only came back after accepting.
  it('previews an insertion exactly as applying it will resolve', () => {
    const data = { name: 'Ada', experience: [{ ...A }, { ...B }] };
    const changes = diffResumeData({ experience: [A, B] }, { experience: [A, X, B] });

    const previewed = applyPendingToData(data, { changes }, new Map());

    store.setData(JSON.parse(JSON.stringify(data)), true, null);
    applyChangesToStore(changes);

    expect(previewed.experience.map((e) => e.company)).toEqual(['Acme', 'Xeno', 'Beta']);
    expect(previewed.experience.map((e) => e.company)).toEqual(companies());
  });

  // The id-less path was never broken; pin it so a future refactor of the ADD
  // branch can't regress it into the insertion logic.
  it('leaves the id-less positional path intact', () => {
    const strip = (o) => ({ company: o.company, title: o.title });
    store.setData({ name: 'Ada', experience: [strip(A), strip(B)] }, true, null);
    const changes = diffResumeData(
      { experience: [strip(A), strip(B)] },
      { experience: [strip(A), strip(X), strip(B)] },
    );
    changes.forEach(applyChangeToStore);
    expect(companies()).toEqual(['Acme', 'Xeno', 'Beta']);
  });
});
