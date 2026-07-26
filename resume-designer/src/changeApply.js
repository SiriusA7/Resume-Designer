/**
 * The ONE implementation of "apply a proposed change to the store".
 *
 * Both review surfaces — the inline on-résumé preview (inlineChanges.js) and
 * the diff dialog (DiffDialog.jsx) — route every apply through here. They
 * previously carried separate copies of these semantics and diverged: the
 * inline copy wrote `proposedChanges[path]`, which is undefined for the leaf
 * paths the diff decomposes container proposals into (blanking the field),
 * and it dropped the REMOVE splice (leaving a hole in the array instead of
 * removing the element).
 *
 * Semantics:
 *  - REMOVE on an array-index path (`experience[2]`) splices the element out;
 *  - REMOVE elsewhere clears the field;
 *  - everything else writes the change's own `newValue`.
 */

import { store } from './store.js';
import { DIFF_TYPES } from './diffEngine.js';

/** Apply one change object (from a changeSet's `changes[]`) to the store. */
export function applyChangeToStore(change) {
  if (change.type === DIFF_TYPES.REMOVE) {
    const arrayMatch = change.path.match(/^(.+)\[(\d+)\]$/);
    if (arrayMatch) {
      store.removeFromArray(arrayMatch[1], parseInt(arrayMatch[2], 10));
    } else {
      store.update(change.path, undefined);
    }
    return;
  }
  store.update(change.path, change.newValue);
}
