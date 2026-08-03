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
 * Whether this ADD has already been applied, so re-applying is a no-op rather
 * than a duplicate. Both review surfaces route through here, apply-all can
 * follow a one-off apply, and a reopened standalone dialog starts with empty
 * applied-state — so the same change genuinely does arrive twice.
 *
 * Two different questions, because the evidence differs:
 *
 *  - With an `id`, search the whole array. Ids are unique, so a match anywhere
 *    means this entry is already present however it has since been reordered.
 *  - Without one, ask only whether this change's OWN recorded slot already
 *    holds its value. A global value search cannot tell a re-application from
 *    a legitimate duplicate and drops real content: `['JS','CSS'] ->
 *    ['JS','CSS','JS']` emits `add skills[2]`, and a global search finds the
 *    first 'JS' and discards the addition. The slot check gets both right —
 *    on the first apply `skills[2]` is empty so the insert happens, and on the
 *    second it already holds 'JS' so it does not. Two intentional duplicates
 *    (`add skills[2]` and `add skills[3]`) each own a distinct slot and both
 *    land.
 */
function alreadyApplied(arr, index, item) {
  if (item && typeof item === 'object' && item.id != null) {
    return arr.some((el) => el && typeof el === 'object' && el.id === item.id);
  }
  return index >= 0 && index < arr.length && sameValue(arr[index], item);
}

/**
 * Re-point a change's path at where its item actually lives right now.
 *
 * diffArray stamps an `anchor` on every change nested inside an id-matched
 * array item: the array's path, the item's `id`, and the index the path was
 * written against (a position in the PROPOSED array). If an insertion or
 * removal elsewhere in the same set has since moved that item, the recorded
 * index addresses the wrong element — so resolve the id against the LIVE array
 * and rewrite just that segment.
 *
 * This is what makes application order-independent: the hover menu and the
 * dialog's per-change Apply act on one change at a time in whatever order the
 * user clicks, and ordering the batch cannot help them.
 *
 * Falls back to the literal path whenever the anchor cannot be trusted — no
 * anchor (an older persisted change set), the array is gone, or the id is no
 * longer present — which is exactly the previous behaviour.
 */
export function resolveAnchoredPath(change, readArray) {
  const a = change && change.anchor;
  if (!a || typeof a.arrayPath !== 'string' || a.id == null) return change.path;
  const prefix = `${a.arrayPath}[${a.index}]`;
  if (!change.path.startsWith(prefix)) return change.path;

  const arr = readArray(a.arrayPath);
  if (!Array.isArray(arr)) return change.path;
  const live = arr.findIndex((el) => el && typeof el === 'object' && el.id === a.id);
  if (live === -1 || live === a.index) return change.path;
  return `${a.arrayPath}[${live}]${change.path.slice(prefix.length)}`;
}

/** Apply one change object (from a changeSet's `changes[]`) to the store. */
export function applyChangeToStore(rawChange) {
  // Everything below works on the resolved path, so a stale proposed-array
  // index can never address the wrong item.
  const resolved = resolveAnchoredPath(rawChange, (p) => store.get(p));
  const change = resolved === rawChange.path ? rawChange : { ...rawChange, path: resolved };
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
        const index = parseInt(arrayMatch[2], 10);
        if (!alreadyApplied(arr, index, change.newValue)) {
          store.insertIntoArray(arrayMatch[1], index, change.newValue);
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
 * How deeply nested a path's array index is: `experience[1]` is 1,
 * `experience[2].bullets[1]` is 2. Structural ops must run outermost-first,
 * because a nested path addresses an element INSIDE a parent that an outer
 * insertion has not created yet.
 */
function arrayDepth(change) {
  return (change.path.match(/\[\d+\]/g) || []).length;
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
 * Ordering is by DEPENDENCY, not by type: outermost array index first, so a
 * parent insertion lands before anything addressing a path inside the item it
 * shifts. Within one level, removals precede insertions (removals resolve by
 * identity and are safe anywhere; insertion indices assume the shrink has
 * happened), and insertions run in ascending index order.
 *
 * `orderChanges` is exported because the inline PREVIEW has to project changes
 * in the same order for the same reason — see changePreview.applyPendingToData.
 *
 * Single-change application (the hover menu, per-change Apply in the dialog)
 * stays index-ordered by whatever the user clicks. Making that fully safe needs
 * leaf changes to carry their item's identity rather than an index, which is a
 * larger change to the diff format.
 */
export function orderChanges(changes) {
  const list = Array.isArray(changes) ? changes : [];
  const structural = list.filter(isStructural).sort((a, b) => {
    // Outermost first. A nested op addresses an element inside a parent that an
    // outer insertion has not created yet: `[A,B] -> [A,X,B']` where B' also
    // drops a bullet emits `remove experience[2].bullets[1]` alongside
    // `add experience[1]`, and running the removal first targets an
    // experience[2] that does not exist — a silent no-op that leaves the
    // rejected bullet in place.
    if (arrayDepth(a) !== arrayDepth(b)) return arrayDepth(a) - arrayDepth(b);
    // Within a level, shrink before growing: removals resolve by identity and
    // are safe anywhere, while insertion indices assume the shrink has already
    // happened. Then insert in ascending index order, each landing against the
    // prefix its predecessors completed.
    if (a.type !== b.type) return a.type === DIFF_TYPES.REMOVE ? -1 : 1;
    return indexOf(a) - indexOf(b);
  });
  return [...structural, ...list.filter((c) => !isStructural(c))];
}

export function applyChangesToStore(changes) {
  orderChanges(changes).forEach(applyChangeToStore);
}

/**
 * The changes an "Apply all" should act on: everything the user has not already
 * applied or rejected.
 *
 * Extracted from DiffDialog's standalone branch so it is reachable from tests —
 * the component itself is not, since the project has no React Testing Library
 * and `npm run test` covers service modules only. Skipping rejected paths is
 * what makes "reject one, apply the rest" safe, and skipping applied ones keeps
 * Apply-all after a one-off apply from doing the work twice.
 *
 * `applied` and `rejected` are anything with a `.has(path)` — a Set in the
 * dialog's standalone mode, and the session's status lookup in owned mode.
 */
export function selectUndecided(changes, applied, rejected) {
  return (changes || []).filter(
    (c) => c && !applied.has(c.path) && !rejected.has(c.path),
  );
}
