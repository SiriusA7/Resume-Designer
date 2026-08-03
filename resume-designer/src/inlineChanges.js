/**
 * Inline Changes Module
 *
 * Previews proposed AI changes directly on the resume. All state lives in
 * changeSession (the shared source of truth also driving DiffDialog and the
 * chat message actions), and the preview itself is produced by re-rendering
 * the resume from data with the pending changes projected in (changePreview's
 * applyPendingToData) — never by writing text into the DOM. The old
 * textContent-snapshot approach flattened the renderer's <strong>/<em> markup
 * and permanently destroyed it on reject; re-rendering from data makes
 * markdown, pagination and every layout work by construction.
 */

import * as session from './changeSession.js';
import { applyChangeToStore, applyChangesToStore } from './changeApply.js';
import { markChangedNodes, clearChangeMarks, isDescendantPath } from './changePreview.js';
import { store } from './store.js';

// Re-render is owned by main.js (it holds the render pipeline); inlineChanges
// only asks for one. Set via initInlineChanges.
let requestRerender = () => {};

// A 'dataLoaded' means a DIFFERENT document now backs the render: variant
// switch, import, backup restore. A session started against the previous
// document must not survive it — renderCurrentResume would project the old
// resume's pending changes onto the new one, and accepting (inline or from a
// still-open DiffDialog, which delegates here) would write the old proposal
// into the new document. store.setData is the one entry point every document
// load goes through, so this hook covers every loadVariant caller centrally.
// No render loop: hideInlineChanges only clears DOM marks, ends the session
// (notifying React listeners that set state) and re-renders — none of which
// call setData. On first load / no session it never fires. Named (not inline)
// so repeated init calls dedupe in the store's listener Set.
function endSessionOnDataLoaded(event) {
  if (event !== 'dataLoaded' || !session.getChangeSet()) return;
  hideInlineChanges();
}

export function initInlineChanges(onRerender) {
  if (typeof onRerender === 'function') requestRerender = onRerender;
  addInlineStyles();
  document.addEventListener('click', handleInlineAction);
  store.subscribe(endSessionOnDataLoaded);
}

/** Begin previewing a change set. Replaces any preview already showing. */
export function showInlineChanges(changeSet) {
  session.startSession(changeSet);
  requestRerender();
}

/** Dismiss the preview and drop every pending decision. */
export function hideInlineChanges() {
  const root = document.getElementById('resume-container');
  clearChangeMarks(root);
  session.endSession();
  requestRerender();
}

export function isInlineChangesActive() {
  return session.getChangeSet() !== null;
}

export function getCurrentChangeSet() {
  return session.getChangeSet();
}

/** Tag the freshly-rendered resume nodes with their change status. */
export function decorateRenderedResume(rootEl) {
  const changeSet = session.getChangeSet();
  if (!changeSet) { clearChangeMarks(rootEl); return; }
  markChangedNodes(rootEl, changeSet, session.statusMap());
}

/**
 * The still-pending change for a path, or null once it is decided (or absent).
 * Drives inlineEditor's hover menu: decided paths fall back to the normal
 * AI-context menu automatically.
 *
 * An exact-path change always wins. When none exists, fall back to a change at
 * an ANCESTOR of the queried path (isDescendantPath's `.`/`[` boundary rule):
 * whole-item adds/removes carry container paths like `experience[1]` that the
 * renderer never emits, so the hover lands on a descendant (`experience[1]
 * .title`) and must still surface Apply/Reject for the container change. The
 * returned change keeps its own container path — callers act on change.path,
 * and its status is tracked under that path too. Deepest ancestor wins so a
 * more specific container is never shadowed by a broader one.
 */
export function getPendingChange(path) {
  const changeSet = session.getChangeSet();
  if (!changeSet) return null;
  const exact = changeSet.changes.find((c) => c.path === path);
  if (exact) return session.getStatus(path) === 'pending' ? exact : null;
  let ancestor = null;
  for (const change of changeSet.changes) {
    if (!isDescendantPath(path, change.path)) continue;
    if (!ancestor || change.path.length > ancestor.path.length) ancestor = change;
  }
  if (!ancestor || session.getStatus(ancestor.path) !== 'pending') return null;
  return ancestor;
}

/**
 * Original (pre-proposal) value of a still-pending path, for the hover menu's
 * "Was:" preview. Read from the change set's data — the rendered DOM now shows
 * the proposed value, so it can no longer be snapshotted from there.
 */
export function getOriginalContent(path) {
  const change = getPendingChange(path);
  if (!change) return undefined;
  if (typeof change.displayOld === 'string' && change.displayOld) return change.displayOld;
  return typeof change.oldValue === 'string' ? change.oldValue : undefined;
}

/**
 * Handle inline action button clicks
 */
function handleInlineAction(e) {
  // Apply single change
  const applyBtn = e.target.closest('.inline-change-apply');
  if (applyBtn) {
    const path = applyBtn.dataset.path;
    applyInlineChange(path);
    return;
  }

  // Reject single change
  const rejectBtn = e.target.closest('.inline-change-reject');
  if (rejectBtn) {
    const path = rejectBtn.dataset.path;
    rejectInlineChange(path);
    return;
  }

  // Apply all
  if (e.target.closest('#inline-apply-all')) {
    applyAllInlineChanges();
    return;
  }

  // Reject all
  if (e.target.closest('#inline-reject-all')) {
    hideInlineChanges();
    return;
  }

  // Open full review
  if (e.target.closest('#inline-open-review')) {
    import('./diffView.js').then(({ showDiffView }) => {
      showDiffView(session.getChangeSet());
    });
    return;
  }
}

export function applyInlineChange(path) {
  const changeSet = session.getChangeSet();
  if (!changeSet || session.getStatus(path) !== 'pending') return;
  const change = changeSet.changes.find((c) => c.path === path);
  if (!change) return;
  applyChangeToStore(change);
  session.setStatus(path, 'applied');
  if (!session.hasPending()) hideInlineChanges(); else requestRerender();
}

export function rejectInlineChange(path) {
  if (!session.getChangeSet()) return;
  session.setStatus(path, 'rejected');
  if (!session.hasPending()) hideInlineChanges(); else requestRerender();
}

export function applyAllInlineChanges() {
  const changeSet = session.getChangeSet();
  if (!changeSet) return;
  // Iterate the change objects (not just paths): applying needs each change's
  // type and newValue — `proposedChanges[path]` is NOT equivalent, since the
  // diff decomposes container proposals into leaf paths absent from that map.
  // applyChangesToStore, not a loop over applyChangeToStore: leaf paths are
  // indexed against the proposed array, so insertions and removals have to land
  // before them or a modify writes against the wrong (or a not-yet-existing)
  // element. diffArray does not emit in that order.
  const pending = new Set(session.pendingPaths());
  applyChangesToStore(changeSet.changes.filter((c) => pending.has(c.path)));
  session.setAllPending('applied');
  hideInlineChanges();
}

/**
 * Add CSS styles for the change markers
 */
function addInlineStyles() {
  if (document.getElementById('inline-changes-styles')) return;

  const style = document.createElement('style');
  style.id = 'inline-changes-styles';
  style.textContent = `
    /* Element with a pending change - visual highlight only. The proposed
       text itself comes from re-rendering the projected data, not DOM edits. */
    [data-change-status="pending"] {
      position: relative;
      transition: all 0.2s;
      border-radius: 4px;
      z-index: 1; /* Lower z-index so popup appears above */
      animation: pulse-highlight 2s ease-in-out infinite;
    }

    [data-change-status="pending"][data-change-type="add"] {
      box-shadow: inset 0 0 0 2px #22c55e;
      background: rgba(34, 197, 94, 0.1) !important;
    }

    [data-change-status="pending"][data-change-type="remove"] {
      box-shadow: inset 0 0 0 2px #ef4444;
      background: rgba(239, 68, 68, 0.1) !important;
    }

    [data-change-status="pending"][data-change-type="modify"] {
      box-shadow: inset 0 0 0 2px #3b82f6;
      background: rgba(59, 130, 246, 0.1) !important;
    }

    /* Pulsing animation to draw attention */
    @keyframes pulse-highlight {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.7; }
    }

    [data-change-status="pending"]:hover {
      animation: none;
      opacity: 1;
    }

    /* data-change-status="applied" / "rejected": no decoration - already decided. */

    /* Never bake preview highlights into a PDF capture: the browser-fallback
       export snapshots the live DOM under html.pdf-export-mode. */
    .pdf-export-mode [data-change-status] {
      box-shadow: none !important;
      background: transparent !important;
      animation: none;
    }
  `;

  document.head.appendChild(style);
}
