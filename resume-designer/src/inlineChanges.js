/**
 * Inline Changes Module
 *
 * Previews proposed AI changes directly on the resume. All state lives in
 * changeSession (the shared source of truth also driving DiffDialog and the
 * chat message actions), and the preview itself is produced by re-rendering
 * the résumé from data with the pending changes projected in (changePreview's
 * applyPendingToData) — never by writing text into the DOM. The old
 * textContent-snapshot approach flattened the renderer's <strong>/<em> markup
 * and permanently destroyed it on reject; re-rendering from data makes
 * markdown, pagination and every layout work by construction.
 */

import * as session from './changeSession.js';
import { applyChangeToStore } from './changeApply.js';
import { markChangedNodes, clearChangeMarks } from './changePreview.js';

// Re-render is owned by main.js (it holds the render pipeline); inlineChanges
// only asks for one. Set via initInlineChanges.
let requestRerender = () => {};

export function initInlineChanges(onRerender) {
  if (typeof onRerender === 'function') requestRerender = onRerender;
  addInlineStyles();
  document.addEventListener('click', handleInlineAction);
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

/** Tag the freshly-rendered résumé nodes with their change status. */
export function decorateRenderedResume(rootEl) {
  const changeSet = session.getChangeSet();
  if (!changeSet) { clearChangeMarks(rootEl); return; }
  markChangedNodes(rootEl, changeSet, session.statusMap());
}

/**
 * The still-pending change for a path, or null once it is decided (or absent).
 * Drives inlineEditor's hover menu: decided paths fall back to the normal
 * AI-context menu automatically.
 */
export function getPendingChange(path) {
  const changeSet = session.getChangeSet();
  if (!changeSet || session.getStatus(path) !== 'pending') return null;
  return changeSet.changes.find((c) => c.path === path) || null;
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
  const pending = new Set(session.pendingPaths());
  for (const change of changeSet.changes) {
    if (pending.has(change.path)) applyChangeToStore(change);
  }
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
