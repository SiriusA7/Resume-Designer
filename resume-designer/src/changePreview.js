/**
 * Change preview, done as data — not as DOM surgery.
 *
 * The previous implementation wrote proposed text straight into
 * `element.textContent`. That flattened the renderer's <strong>/<em> markup,
 * displayed literal markdown asterisks, and — because the "original" it saved
 * for restore was itself a textContent snapshot — permanently destroyed the
 * original's emphasis when a change was rejected.
 *
 * Instead: project pending changes onto a COPY of the résumé data, re-render
 * through the normal renderer (so markdown, pagination and every layout work by
 * construction), then mark the changed nodes by path with a data attribute.
 * Nothing here ever writes text into the DOM.
 */

import { DIFF_TYPES, setByPath } from './diffEngine.js';

/**
 * Résumé data with still-pending changes projected in.
 *
 * Projects from `changeSet.changes` — the LEAF paths the diff decomposes each
 * proposal into — because that is the key space the status map, markChangedNodes
 * and applyChangeToStore all share. `proposedChanges` is keyed by whatever
 * container the model sent (e.g. a whole shortened array for a removal), so
 * projecting from it re-applies entire containers regardless of per-leaf
 * decisions.
 *
 * Per leaf: applied paths are skipped (the store already holds them); rejected
 * paths keep their original value; a pending REMOVE also projects nothing — the
 * copy starts from the store data, so the doomed item is already in place, and
 * it must STAY visible so the renderer emits a node for markChangedNodes to tag
 * (data-change-type="remove") and for the hover menu to reject. Splicing it out
 * is applyChangeToStore's job when the removal is accepted.
 */
export function applyPendingToData(data, changeSet, statuses) {
  const next = JSON.parse(JSON.stringify(data));
  if (!changeSet) return next;
  for (const change of changeSet.changes || []) {
    const status = statuses.get(change.path) || 'pending';
    if (status !== 'pending') continue;
    if (change.type === DIFF_TYPES.REMOVE) continue;
    setByPath(next, change.path, change.newValue);
  }
  return next;
}

// CSS.escape isn't available in every test environment; attribute values only
// need quotes and backslashes escaped for a [attr="..."] selector.
function escapeAttr(value) {
  return String(value).replace(/(["\\])/g, '\\$1');
}

/**
 * Tag every node belonging to a changed path with its status, for CSS styling.
 * Marks ALL matches deliberately: pagination clones nodes across pages, so one
 * path legitimately maps to several elements and marking only the first left
 * visible changes unhighlighted.
 */
export function markChangedNodes(rootEl, changeSet, statuses) {
  if (!rootEl || !changeSet) return;
  for (const change of changeSet.changes) {
    const status = statuses.get(change.path) || 'pending';
    const nodes = rootEl.querySelectorAll(`[data-editable="${escapeAttr(change.path)}"]`);
    for (const node of nodes) {
      node.dataset.changeStatus = status;
      node.dataset.changeType = change.type;
    }
  }
}

/** Remove every preview marker — used before PDF capture and on session end. */
export function clearChangeMarks(rootEl) {
  if (!rootEl) return;
  for (const node of rootEl.querySelectorAll('[data-change-status]')) {
    delete node.dataset.changeStatus;
    delete node.dataset.changeType;
  }
}
