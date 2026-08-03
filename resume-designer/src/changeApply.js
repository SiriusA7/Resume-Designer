/**
 * The ONE implementation of "apply a proposed change to the store".
 *
 * Both review surfaces — the inline on-resume preview (inlineChanges.js) and
 * the diff dialog (DiffDialog.jsx) — route every apply through here. They
 * previously carried separate copies of these semantics and diverged: the
 * inline copy wrote `proposedChanges[path]`, which is undefined for the leaf
 * paths the diff decomposes container proposals into (blanking the field),
 * and it dropped the REMOVE splice (leaving a hole in the array instead of
 * removing the element).
 *
 * Semantics:
 *  - REMOVE on an array-index path (`experience[2]`) splices the element out.
 *    The element is resolved by IDENTITY (the change's own `oldValue` — by
 *    `id` when it has one, else by value), not by the recorded index: a
 *    change set with several removals on one array numbers them all against
 *    the ORIGINAL array, so once the first splice shifts the survivors down a
 *    stale index deletes the wrong item — or, out of range, silently nothing.
 *    Identity resolution stays correct in any application order (apply-all,
 *    one at a time from the hover menu, or interleaved across surfaces), and
 *    re-applying an already-removed item is a no-op instead of a mis-splice;
 *  - REMOVE elsewhere clears the field;
 *  - ADD on an array-index path (`experience[1]`) INSERTS at that index. The
 *    index is a position in the PROPOSED array, so writing the path instead
 *    would assign over whatever currently sits there: `[A,B]` -> `[A,X,B]`
 *    emits `add experience[1]` and a write would replace B, losing it. Like
 *    REMOVE, the operation is identity-guarded so re-applying is a no-op
 *    rather than a duplicate;
 *  - everything else writes the change's own `newValue`.
 */

import { store } from './store.js';
import { DIFF_TYPES } from './diffEngine.js';

// The diff engine's own equality idiom (it detects change the same way).
function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Current index of the element a REMOVE change targets, or -1 if it is gone.
 * Mirrors diffArray's matching hierarchy: `id` first (it survives content
 * edits made during review), then value. The recorded index is preferred when
 * its element still matches, so with duplicate values each removal consumes
 * the occurrence it originally pointed at.
 */
function findRemovalIndex(arr, oldValue, recordedIndex) {
  if (oldValue && typeof oldValue === 'object' && oldValue.id != null) {
    return arr.findIndex((item) => item && typeof item === 'object' && item.id === oldValue.id);
  }
  if (recordedIndex < arr.length && sameValue(arr[recordedIndex], oldValue)) {
    return recordedIndex;
  }
  return arr.findIndex((item) => sameValue(item, oldValue));
}

/**
 * Whether an ADD's item is already in the array, by `id` ONLY.
 *
 * Deliberately not a value comparison. Duplicate values are legitimate content
 * — `skills: ['JS','CSS'] -> ['JS','CSS','JS']` emits `add skills[2]`, and a
 * value check finds the first 'JS' and drops the requested addition. Ids are
 * unique, so an id match really is the same entry arriving twice; equal values
 * are not evidence of anything.
 *
 * The cost is that re-applying an ADD for an id-less item duplicates it. That
 * is inherent: without an id there is nothing to distinguish "this change was
 * already applied" from "the user wants two of these", and silently discarding
 * real content is the worse failure.
 */
function hasSameId(arr, item) {
  if (!item || typeof item !== 'object' || item.id == null) return false;
  return arr.some((el) => el && typeof el === 'object' && el.id === item.id);
}

/** Apply one change object (from a changeSet's `changes[]`) to the store. */
export function applyChangeToStore(change) {
  if (change.type === DIFF_TYPES.ADD) {
    // An ADD on an array-index path is an INSERTION, not an assignment.
    // diffArray numbers additions against the PROPOSED array, so `[A,B]` ->
    // `[A,X,B]` emits `add experience[1]`; writing that path would overwrite B
    // and silently drop it. Only reachable when items carry `id`s — without
    // them diffArray positionally matches instead and emits MODIFY + a
    // trailing ADD, which was already correct.
    const arrayMatch = change.path.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const arr = store.get(arrayMatch[1]);
      if (Array.isArray(arr)) {
        if (!hasSameId(arr, change.newValue)) {
          store.insertIntoArray(arrayMatch[1], parseInt(arrayMatch[2], 10), change.newValue);
        }
        return;
      }
      // No array at that path yet — fall through so the generic write creates it.
    }
    store.update(change.path, change.newValue);
    return;
  }

  if (change.type === DIFF_TYPES.REMOVE) {
    const arrayMatch = change.path.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      const arr = store.get(arrayMatch[1]);
      if (!Array.isArray(arr)) return;
      const index = findRemovalIndex(arr, change.oldValue, parseInt(arrayMatch[2], 10));
      if (index !== -1) store.removeFromArray(arrayMatch[1], index);
      return;
    }
    store.update(change.path, undefined);
    return;
  }
  store.update(change.path, change.newValue);
}

/** Array-index structural op (`experience[2]`), i.e. one that shifts indices. */
function isStructural(change) {
  return (change.type === DIFF_TYPES.ADD || change.type === DIFF_TYPES.REMOVE)
    && /^(.+)\[(\d+)\]$/.test(change.path);
}

function indexOf(change) {
  const m = change.path.match(/^(.+)\[(\d+)\]$/);
  return m ? parseInt(m[2], 10) : -1;
}

/**
 * Apply a batch of changes, structural ones first.
 *
 * Every leaf path a change set carries is indexed against the PROPOSED array,
 * but each write lands on the LIVE one — so the array has to reach its proposed
 * shape before any `experience[2].title` is written. diffArray emits in neither
 * order: id-matched content edits come out of its first pass, additions out of
 * its last, so `[A,B] -> [A,X,B']` yields `modify experience[2].title` BEFORE
 * `add experience[1]`. Applied in that order the modify writes past the end of a
 * two-item array, setByPath creates a third entry to hold it, and the insert
 * then makes four — with B never modified.
 *
 * Removals run before insertions: both bring the array toward its proposed
 * shape, and removals resolve by identity so they are safe at any point, while
 * insertion indices assume the shrink has already happened. Insertions then run
 * in ascending index order, each one landing against the prefix the previous
 * ones completed.
 *
 * Single-change application (the hover menu, per-change Apply in the dialog)
 * stays index-ordered by whatever the user clicks. Making that fully safe needs
 * leaf changes to carry their item's identity rather than an index, which is a
 * larger change to the diff format.
 */
export function applyChangesToStore(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const removals = list.filter((c) => isStructural(c) && c.type === DIFF_TYPES.REMOVE);
  const additions = list.filter((c) => isStructural(c) && c.type === DIFF_TYPES.ADD)
    .sort((a, b) => indexOf(a) - indexOf(b));
  const rest = list.filter((c) => !isStructural(c));

  [...removals, ...additions, ...rest].forEach(applyChangeToStore);
}
