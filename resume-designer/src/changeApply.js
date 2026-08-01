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

/** Apply one change object (from a changeSet's `changes[]`) to the store. */
export function applyChangeToStore(change) {
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
