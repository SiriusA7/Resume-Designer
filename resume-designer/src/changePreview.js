/**
 * Change preview, done as data — not as DOM surgery.
 *
 * The previous implementation wrote proposed text straight into
 * `element.textContent`. That flattened the renderer's <strong>/<em> markup,
 * displayed literal markdown asterisks, and — because the "original" it saved
 * for restore was itself a textContent snapshot — permanently destroyed the
 * original's emphasis when a change was rejected.
 *
 * Instead: project pending changes onto a COPY of the resume data, re-render
 * through the normal renderer (so markdown, pagination and every layout work by
 * construction), then mark the changed nodes by path with a data attribute.
 * Nothing here ever writes text into the DOM.
 */

import { DIFF_TYPES, setByPath, getByPath } from './diffEngine.js';
// The preview and the apply path must agree on ordering and on what an ADD
// means, or the user reviews something other than what accepting produces.
import { orderChanges, resolveAnchoredPath } from './changeApply.js';

/**
 * Resume data with still-pending changes projected in.
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
  // Same ordering as the apply path, for the same reason: leaf paths are
  // indexed against the PROPOSED array, so an insertion has to land before
  // anything addressing a path inside the item it shifts.
  for (const raw of orderChanges(changeSet.changes || [])) {
    // Status is keyed by the change's ORIGINAL path — that is the key space the
    // session, markChangedNodes and the hover menu all share — so look it up
    // before resolving the anchor against this projection.
    const status = statuses.get(raw.path) || 'pending';
    if (status !== 'pending') continue;
    if (raw.type === DIFF_TYPES.REMOVE) continue;
    const resolvedPath = resolveAnchoredPath(raw, (p) => getByPath(next, p));
    const change = resolvedPath === raw.path ? raw : { ...raw, path: resolvedPath };
    if (change.type === DIFF_TYPES.ADD) {
      // INSERT, matching applyChangeToStore. Writing the path would overwrite
      // whatever currently sits at that index, so `[A,B] -> [A,X,B]` previewed
      // as [A,X] — the user watched B disappear and only saw it return after
      // accepting. The preview must show what accepting actually produces.
      const arrayMatch = change.path.match(/^(.+)\[(\d+)\]$/);
      if (arrayMatch) {
        const arr = getByPath(next, arrayMatch[1]);
        if (Array.isArray(arr)) {
          const at = Math.max(0, Math.min(parseInt(arrayMatch[2], 10), arr.length));
          arr.splice(at, 0, change.newValue);
          continue;
        }
      }
    }
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
 * True when `path` addresses something INSIDE `ancestorPath` — i.e. it
 * continues the ancestor at a segment boundary (`.` or `[`). A bare string
 * prefix is NOT enough, and the boundary must not be relaxed: without it,
 * `experience` would claim a hypothetical `experienceNotes` sibling. (For
 * index paths like `experience[1]` vs `experience[10].title` the trailing `]`
 * happens to break the prefix on its own — do not rely on that accident.)
 * Equal paths are not descendant: exact matches are the callers' primary case
 * and are handled before this fallback.
 */
export function isDescendantPath(path, ancestorPath) {
  if (!path || !ancestorPath || !path.startsWith(ancestorPath)) return false;
  const boundary = path[ancestorPath.length];
  return boundary === '.' || boundary === '[';
}

/**
 * Where each change's path actually ends up in the PROJECTED data, keyed by the
 * change's original path.
 *
 * The two differ whenever an anchor resolves: pending removals deliberately stay
 * visible in the preview, so an item can sit at a different index there than the
 * proposed array gave it. The projection writes to the resolved position and the
 * renderer emits `data-editable` from that, so anything that looks a change up
 * in the DOM — the status markers, the hover menu — has to use the same
 * resolution or it addresses the wrong element.
 *
 * Status stays keyed by the ORIGINAL path throughout: that is the session's key
 * space, and it must not move when the projection shifts.
 */
export function resolvePreviewPaths(changeSet, viewData) {
  const map = new Map();
  if (!changeSet || !viewData) return map;
  for (const change of changeSet.changes || []) {
    map.set(change.path, resolveAnchoredPath(change, (p) => getByPath(viewData, p)));
  }
  return map;
}

/**
 * Tag every node belonging to a changed path with its status, for CSS styling.
 * Marks ALL matches deliberately: pagination clones nodes across pages, so one
 * path legitimately maps to several elements and marking only the first left
 * visible changes unhighlighted.
 *
 * `resolved` maps original paths to where they landed in the projected data —
 * pass the map from resolvePreviewPaths whenever the render came from a preview
 * projection, or omit it for a plain render.
 */
export function markChangedNodes(rootEl, changeSet, statuses, resolved) {
  if (!rootEl || !changeSet) return;
  for (const change of changeSet.changes) {
    // Status by ORIGINAL path (the session's key space); DOM lookup by RESOLVED.
    const status = statuses.get(change.path) || 'pending';
    const domPath = resolved?.get(change.path) || change.path;
    let nodes = rootEl.querySelectorAll(`[data-editable="${escapeAttr(domPath)}"]`);
    if (nodes.length === 0) {
      // Whole-item fallback: for container paths like `experience[1]` or
      // `sections[0]` (whole-item add/remove) the renderer emits no exact
      // node — only descendants (`experience[1].title`, …) carry
      // data-editable. Mark ALL of those so the whole item lights up.
      //
      // This is deliberately NOT the loose `^=` prefix matching that once
      // bound a leaf change to an arbitrary wrong node: it runs only when the
      // exact path matched nothing, it requires a `.`/`[` segment boundary
      // right after the path (isDescendantPath — `experience[1]` never claims
      // `experience[10].title`), and it marks every matching descendant
      // instead of picking one. Keep all three properties.
      nodes = Array.from(rootEl.querySelectorAll('[data-editable]'))
        .filter((el) => isDescendantPath(el.dataset.editable, domPath));
    }
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
