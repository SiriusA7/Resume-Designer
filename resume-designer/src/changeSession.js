/**
 * The ONE source of truth for an in-flight AI change proposal.
 *
 * Previously three surfaces tracked "what is still pending" independently —
 * inlineChanges.js module singletons, DiffDialog.jsx React state, and
 * msg.pendingChanges on chat messages — with no subscription between them, so
 * applying everything in one surface left the others still offering
 * accept/reject. They are now all views over this module.
 *
 * Statuses: 'pending' | 'applied' | 'rejected'. A path with no recorded status
 * is pending; the map only ever records decisions.
 */

const listeners = new Set();

let changeSet = null;
let statuses = new Map();

function notify() {
  for (const cb of listeners) {
    try { cb(); } catch (e) { console.error('[changeSession] listener failed:', e); }
  }
}

/** Subscribe to any session transition. Returns an unsubscribe function. */
export function subscribe(callback) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Begin reviewing a change set. Replaces any session already in flight. */
export function startSession(nextChangeSet) {
  changeSet = nextChangeSet || null;
  statuses = new Map();
  notify();
}

/** Discard the session — nothing is pending afterwards. */
export function endSession() {
  changeSet = null;
  statuses = new Map();
  notify();
}

export function getChangeSet() {
  return changeSet;
}

/** @returns {'pending'|'applied'|'rejected'} */
export function getStatus(path) {
  return statuses.get(path) || 'pending';
}

export function setStatus(path, status) {
  if (!changeSet) return;
  if (statuses.get(path) === status) return;
  statuses.set(path, status);
  notify();
}

/** Decide every still-pending path at once ("apply all" / "reject all"). */
export function setAllPending(status) {
  if (!changeSet) return;
  let changed = false;
  for (const change of changeSet.changes) {
    if (!statuses.has(change.path)) {
      statuses.set(change.path, status);
      changed = true;
    }
  }
  if (changed) notify();
}

export function pendingPaths() {
  if (!changeSet) return [];
  return changeSet.changes.map((c) => c.path).filter((p) => !statuses.has(p));
}

export function hasPending() {
  return pendingPaths().length > 0;
}

/** Snapshot of every recorded decision, for DOM marking. */
export function statusMap() {
  return new Map(statuses);
}
