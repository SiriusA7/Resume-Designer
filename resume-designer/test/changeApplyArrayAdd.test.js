import { describe, it, expect, beforeEach } from 'vitest';
import { applyChangeToStore } from '../src/changeApply.js';
import { diffResumeData } from '../src/diffEngine.js';
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

  it('is a no-op when the item is already present (re-apply)', () => {
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
