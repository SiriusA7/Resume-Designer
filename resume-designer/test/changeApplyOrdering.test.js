import { describe, it, expect } from 'vitest';
import {
  applyChangeToStore, applyChangesToStore, resolveAnchoredPath, selectUndecided,
} from '../src/changeApply.js';
import { diffResumeData } from '../src/diffEngine.js';
import { applyPendingToData } from '../src/changePreview.js';
import { store } from '../src/store.js';

// Leaf paths are indexed against the PROPOSED array but applied to the LIVE
// one, so an insertion or removal elsewhere in the same set moves the item a
// path was written against. Ordering the batch fixes apply-all, but the hover
// menu and the dialog's per-change Apply act on one change at a time in
// whatever order the user clicks — nothing can order those.
//
// diffArray therefore stamps an `anchor` (array path, item id, proposed index)
// on every change nested inside an id-matched item, and the apply and preview
// paths re-resolve the index by id. That makes application ORDER-INDEPENDENT,
// which is the property these tests pin.

const clone = (o) => JSON.parse(JSON.stringify(o));

const A = { id: 'a', company: 'Acme', bullets: ['a1'] };
const B = { id: 'b', company: 'Beta', bullets: ['b1', 'b2'] };
const X = { id: 'x', company: 'Xeno', bullets: ['x1'] };

/** Every ordering of `arr`. */
function permutations(arr) {
  if (arr.length <= 1) return [arr];
  const out = [];
  arr.forEach((x, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    permutations(rest).forEach((p) => out.push([x, ...p]));
  });
  return out;
}

const shape = () =>
  store.get('experience').map((e) => `${e.company}:[${(e.bullets || []).join(',')}]`);

describe('anchored change application', () => {
  it('stamps an anchor on changes nested inside an id-matched item', () => {
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, { ...B, company: 'Beta Corp' }] },
    );
    const nested = changes.find((c) => c.path === 'experience[2].company');
    expect(nested).toBeDefined();
    expect(nested.anchor).toEqual({ arrayPath: 'experience', id: 'b', index: 2 });

    // The insertion itself has no anchor — it is not inside an existing item.
    expect(changes.find((c) => c.type === 'add').anchor).toBeUndefined();
  });

  // The property that matters: the user can click Apply on these in any order.
  it('produces the same result for EVERY application order', () => {
    const changes = diffResumeData(
      { experience: [A, B] },
      {
        experience: [
          A,
          X,
          { ...B, company: 'Beta Corp', bullets: ['b1'] },
        ],
      },
    );
    expect(changes.length).toBeGreaterThan(2);

    const orders = permutations(changes);
    const results = new Set();
    for (const order of orders) {
      store.setData({ name: 'Ada', experience: [clone(A), clone(B)] }, true, null);
      order.forEach(applyChangeToStore);
      results.add(JSON.stringify(shape()));
    }

    expect(orders.length).toBeGreaterThanOrEqual(24);
    expect([...results]).toHaveLength(1);
    expect(JSON.parse([...results][0])).toEqual([
      'Acme:[a1]', 'Xeno:[x1]', 'Beta Corp:[b1]',
    ]);
  });

  it('applies one nested change correctly before its sibling insertion exists', () => {
    // The hover-menu case: accept the edit to B, leave the insertion pending.
    store.setData({ name: 'Ada', experience: [clone(A), clone(B)] }, true, null);
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, { ...B, company: 'Beta Corp' }] },
    );
    applyChangeToStore(changes.find((c) => c.path === 'experience[2].company'));

    // Without the anchor this wrote experience[2] on a two-item array and
    // created a phantom third entry.
    const exp = store.get('experience');
    expect(exp).toHaveLength(2);
    expect(exp.map((e) => e.company)).toEqual(['Acme', 'Beta Corp']);
  });

  it('keeps the preview in step with a partially-applied set', () => {
    const data = { name: 'Ada', experience: [clone(A), clone(B)] };
    const changes = diffResumeData(
      { experience: [A, B] },
      { experience: [A, X, { ...B, company: 'Beta Corp' }] },
    );
    store.setData(clone(data), true, null);
    applyChangesToStore(changes);

    const statuses = new Map(changes.map((c) => [c.path, 'applied']));
    const previewed = applyPendingToData(store.getData(), { changes }, statuses);
    expect(previewed.experience.map((e) => e.company))
      .toEqual(store.get('experience').map((e) => e.company));
  });
});

// DiffDialog's standalone Apply All decides WHICH changes to act on, then hands
// them to applyChangesToStore. The component itself is out of vitest's reach
// (no React Testing Library), so the decision is extracted here and pinned —
// leaving only trivial glue in the component.
describe('selectUndecided', () => {
  const changes = [
    { path: 'a', type: 'modify' },
    { path: 'b', type: 'modify' },
    { path: 'c', type: 'modify' },
  ];

  it('returns everything when nothing has been decided', () => {
    expect(selectUndecided(changes, new Set(), new Set()).map((c) => c.path))
      .toEqual(['a', 'b', 'c']);
  });

  it('skips rejected paths — this is what makes "reject one, apply the rest" safe', () => {
    expect(selectUndecided(changes, new Set(), new Set(['b'])).map((c) => c.path))
      .toEqual(['a', 'c']);
  });

  it('skips already-applied paths so Apply All cannot double-apply', () => {
    expect(selectUndecided(changes, new Set(['a']), new Set()).map((c) => c.path))
      .toEqual(['b', 'c']);
  });

  it('returns nothing when every change is decided', () => {
    expect(selectUndecided(changes, new Set(['a', 'c']), new Set(['b']))).toEqual([]);
  });

  it('tolerates a missing or empty change list', () => {
    expect(selectUndecided(undefined, new Set(), new Set())).toEqual([]);
    expect(selectUndecided([], new Set(), new Set())).toEqual([]);
  });
});

describe('resolveAnchoredPath', () => {
  const read = (arr) => (p) => (p === 'experience' ? arr : undefined);

  it('re-points the index at the item’s live position', () => {
    const change = {
      path: 'experience[2].company',
      anchor: { arrayPath: 'experience', id: 'b', index: 2 },
    };
    // B currently sits at index 1, not the proposed 2.
    expect(resolveAnchoredPath(change, read([{ id: 'a' }, { id: 'b' }])))
      .toBe('experience[1].company');
  });

  it('leaves the path alone when the index is already right', () => {
    const change = {
      path: 'experience[1].company',
      anchor: { arrayPath: 'experience', id: 'b', index: 1 },
    };
    expect(resolveAnchoredPath(change, read([{ id: 'a' }, { id: 'b' }])))
      .toBe('experience[1].company');
  });

  // Every fallback reproduces the pre-anchor behaviour exactly, so an older
  // persisted change set and a vanished item both stay safe.
  it('falls back to the literal path when the anchor cannot be trusted', () => {
    const arr = [{ id: 'a' }, { id: 'b' }];
    expect(resolveAnchoredPath({ path: 'experience[2].company' }, read(arr)))
      .toBe('experience[2].company');
    expect(resolveAnchoredPath(
      { path: 'experience[2].company', anchor: { arrayPath: 'experience', id: 'gone', index: 2 } },
      read(arr),
    )).toBe('experience[2].company');
    expect(resolveAnchoredPath(
      { path: 'experience[2].company', anchor: { arrayPath: 'experience', id: 'b', index: 2 } },
      () => undefined,
    )).toBe('experience[2].company');
  });

  it('does not rewrite a path that does not sit under the anchor', () => {
    const change = {
      path: 'education[0].school',
      anchor: { arrayPath: 'experience', id: 'b', index: 2 },
    };
    expect(resolveAnchoredPath(change, read([{ id: 'b' }])))
      .toBe('education[0].school');
  });
});
