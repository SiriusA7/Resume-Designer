/**
 * Chat thread persistence — framework-agnostic helpers extracted from the former
 * chatPanel.js so the React `useChat` hook (and unit tests) can own thread state
 * without the panel's heavy import graph. Pure functions over plain thread
 * objects + appStorage; no module-level mutable state.
 *
 * Thread shape: { id, name, messages, createdAt, updatedAt }
 * Only the last 50 messages of a thread are persisted (see MAX_PERSISTED).
 */

import { appStorage } from './appStorage.js';

const STORAGE_KEY = 'resume-designer-chat-history'; // legacy single-thread history
const THREADS_KEY = 'resume-designer-chat-threads';
const MAX_PERSISTED = 50;
const MAX_PERSISTED_REASONING = 8000; // chars; full reasoning stays in-memory only

// Short random suffix so two threads created in the same millisecond can't
// collide. crypto.getRandomValues (not Math.random — CodeQL's
// js/insecure-randomness rule, and store.js's convention) has no secure-context
// requirement, so it's available in both the Tauri webview and the browser.
function randomSuffix() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0].toString(36);
}

export function makeThread(name = 'New Chat', initialMessages = [], homeVariantId = null) {
  const now = new Date().toISOString();
  return {
    id: `thread-${Date.now()}-${randomSuffix()}`,
    name,
    messages: Array.isArray(initialMessages) ? initialMessages : [],
    createdAt: now,
    updatedAt: now,
    homeVariantId,
  };
}

// Ensure every thread carries homeVariantId (legacy threads predate the field).
// Missing/undefined → null (the "General" group). Pure; callers persist.
export function migrateThreads(threads) {
  if (!Array.isArray(threads)) return [];
  return threads.map((t) => (t && t.homeVariantId === undefined ? { ...t, homeVariantId: null } : t));
}

// Newest-first by updatedAt (stable for equal timestamps).
function byUpdatedDesc(a, b) {
  return new Date(b.updatedAt) - new Date(a.updatedAt);
}

/**
 * Split threads for the selector, relative to the active variant.
 * A thread whose homeVariantId is null OR points at a variant not in `variants`
 * falls into `general`. `variants` is [{ id, name }] (useVariants().list).
 * @returns {{ current: Thread[], general: Thread[],
 *            others: { variantId, variantName, threads: Thread[] }[] }}
 */
export function groupThreadsByHome(threads, currentVariantId, variants = []) {
  const known = new Map(variants.map((v) => [v.id, v.name]));
  const current = [];
  const general = [];
  const othersByVariant = new Map();
  for (const t of Array.isArray(threads) ? threads : []) {
    const home = t.homeVariantId ?? null;
    if (home === currentVariantId) current.push(t);
    else if (home === null || !known.has(home)) general.push(t);
    else {
      if (!othersByVariant.has(home)) othersByVariant.set(home, []);
      othersByVariant.get(home).push(t);
    }
  }
  current.sort(byUpdatedDesc);
  general.sort(byUpdatedDesc);
  const others = [...othersByVariant.entries()].map(([variantId, ts]) => ({
    variantId, variantName: known.get(variantId), threads: ts.sort(byUpdatedDesc),
  }));
  return { current, general, others };
}

/** Id of the most-recently-updated thread homed to the active variant, or null. */
export function pickCurrentThreadId(threads, currentVariantId) {
  const homed = (Array.isArray(threads) ? threads : [])
    .filter((t) => (t.homeVariantId ?? null) === currentVariantId)
    .sort(byUpdatedDesc);
  return homed.length ? homed[0].id : null;
}

/**
 * Decide the thread list + selection after the CURRENT thread is deleted.
 * Keeps selection within the active resume: opens its most-recent remaining thread,
 * or creates a fresh homed one when it has none — never an unrelated General/other-
 * resume thread, and never an empty selection.
 * @returns {{ threads: Thread[], currentThreadId: string, created: Thread|null }}
 */
export function chooseThreadAfterDelete(threads, deletedId, activeVariantId) {
  const next = (Array.isArray(threads) ? threads : []).filter((t) => t.id !== deletedId);
  let currentThreadId = pickCurrentThreadId(next, activeVariantId);
  let created = null;
  if (!currentThreadId) {
    created = makeThread('New Chat', [], activeVariantId || null);
    next.unshift(created);
    currentThreadId = created.id;
  }
  return { threads: next, currentThreadId, created };
}

/** variantId of the last non-context message (the "current context"), or null. */
export function lastTurnVariantId(messages) {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role !== 'context') return messages[i].variantId ?? null;
  }
  return null;
}

/**
 * Append a `context` divider marker iff the active variant differs from the
 * thread's last turn AND the thread is non-empty. Returns the SAME array
 * reference when no marker is needed (cheap no-op for the common case).
 */
export function withContextMarker(messages, activeVariantId, activeVariantName) {
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) return messages;
  if (lastTurnVariantId(list) === activeVariantId) return messages;
  const marker = {
    id: `ctx-${Date.now()}-${randomSuffix()}`,
    role: 'context',
    variantId: activeVariantId,
    variantName: activeVariantName,
    timestamp: new Date().toISOString(),
  };
  return [...list, marker];
}

/**
 * The thread list inside a stored or fetched value, or `null` when it is not
 * one. A list is the only shape this module reads back; anything else is a
 * value it has nothing to say about, which the two callers below answer
 * differently — see landsAsThreads.
 */
function threadsIn(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    console.error('Failed to read chat threads:', e);
    return null;
  }
}

/**
 * Whether a fetched payload is one the holder could adopt — asked by the sync
 * layer BEFORE it writes the key (src/sync/syncModel.js, KEY_OWNERS).
 *
 * The same reader `loadThreads` uses, so the write and the adoption cannot
 * disagree about what "readable" means. That agreement matters more here than
 * anywhere else on this key: `loadThreads` does not merely fall back to an
 * empty list on garbage, it MANUFACTURES a single fresh 'New Chat' thread — so
 * a payload allowed onto disk would be adopted as, and then persisted and
 * pushed up as, an empty conversation history. Refusing before the write is
 * what keeps absence from becoming deletion.
 */
export function landsAsThreads(payload) {
  return threadsIn(payload) !== null;
}

/**
 * Load all threads and decide which is current. Migrates legacy single-thread
 * history on first run, guarantees at least one thread, and selects the
 * most-recently-updated thread as current. Mirrors the old loadChatHistory().
 */
export function loadThreads() {
  try {
    const threads = threadsIn(appStorage.getItem(THREADS_KEY)) ?? [];

    if (threads.length === 0) {
      // Migrate any old single-thread history into a fresh thread — in memory
      // only. An empty/initial READ must never WRITE: if this path ever ran
      // against the wrong store (e.g. a pre-init passthrough on Tauri), a
      // persist here would clobber the real saved threads with an empty one.
      // The first real user action persists via the useChat callers.
      const oldHistory = appStorage.getItem(STORAGE_KEY);
      const oldMessages = oldHistory ? JSON.parse(oldHistory) : [];
      const thread = makeThread('New Chat', Array.isArray(oldMessages) ? oldMessages : []);
      return { threads: [thread], currentThreadId: thread.id };
    }

    const mostRecent = [...threads].sort(
      (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)
    )[0];
    return { threads, currentThreadId: mostRecent.id };
  } catch (e) {
    console.error('Failed to load chat history:', e);
    const thread = makeThread('New Chat');
    return { threads: [thread], currentThreadId: thread.id };
  }
}

/**
 * When a variant is deleted, either move its threads to General
 * (mode 'general') or drop them (mode 'delete'). Pure; caller persists.
 */
export function reassignThreadsForDeletedVariant(threads, deletedVariantId, mode) {
  const list = Array.isArray(threads) ? threads : [];
  if (mode === 'delete') return list.filter((t) => (t.homeVariantId ?? null) !== deletedVariantId);
  return list.map((t) =>
    (t.homeVariantId ?? null) === deletedVariantId ? { ...t, homeVariantId: null } : t);
}

/** Ids of the threads homed to a given variant (what a 'delete' reassign drops). */
export function threadIdsForVariant(threads, variantId) {
  return (Array.isArray(threads) ? threads : [])
    .filter((t) => (t.homeVariantId ?? null) === variantId)
    .map((t) => t.id);
}

/** Count threads homed to a given variant (for the delete prompt). */
export function countThreadsForVariant(threads, variantId) {
  return threadIdsForVariant(threads, variantId).length;
}

export function persistThreads(threads) {
  // Writes during a destructive backup import are blocked centrally by
  // appStorage's restore guard (which also replays this write if the restore
  // fails), so there is no per-writer suspension check here.
  try {
    appStorage.setItem(THREADS_KEY, JSON.stringify(threads));
  } catch (e) {
    console.error('Failed to save threads:', e);
  }
}

// ── the live thread list ───────────────────────────────────────────────────
//
// This module is stateless on purpose — every function above takes threads and
// hands threads back — but the APP holds exactly one live copy of the list:
// useChat's React state, which `persistThreads` writes straight back over the
// key. So a thread list `applyUnits` landed in storage lasted only until the
// next send, which wrote the stale in-memory list over it, stamped the unit,
// and — the transport legitimately holding the record's change tag, because the
// page had confirmed the apply — pushed the revert up as a clean, uncontested
// update. No conflict was raised and the other device's threads were gone.
//
// Same trap store.adoptDocument answers for the résumé, and the same answer:
// ask the holder to adopt rather than writing behind its back. The holder is
// asked rather than told for the same reason too — only it knows whether it can
// take a replacement right now.
//
// Every OTHER reader of this key (deleteVariantThreadsFlow, LibraryDialog,
// DetailPane) calls loadThreads(), which reads storage each time and therefore
// holds nothing that could go stale.
let holder = null;

/**
 * Install (or, with null, remove) the live thread-list holder — `{ isBusy(),
 * adopt() }`. useChat registers itself while mounted; ChatPanel drives both the
 * desktop panel and the native iOS chat sheet from it, so this is one holder on
 * both platforms.
 *
 * Returns a deregistration that clears the slot ONLY while this holder is still
 * the one in it. There is a single call site today, so the unconditional clear
 * it replaces was correct today — and silently stopped being correct the moment
 * a second holder registered: React mounts the replacement before unmounting the
 * old one, so the departing holder's cleanup would deregister the SURVIVOR and
 * leave the live copy unreachable, which is the revert bug back with no symptom
 * until another device's threads went missing.
 */
export function registerThreadHolder(next) {
  const installed = next && typeof next.adopt === 'function' ? next : null;
  holder = installed;
  return () => {
    if (holder === installed) holder = null;
  };
}

/**
 * Whether replacing the thread list right now would destroy work in flight.
 *
 * A streamed reply lives ONLY in the hook's state until it commits, and it
 * commits by mapping over the thread list — so a list replaced mid-stream takes
 * the reply with it, with no history and nothing else holding it. Exactly the
 * exposure store.isBusyEditing covers for the résumé's inline edit, and it is
 * answered from the same place the chat's own flows read it: the hook's
 * existing `loading` / in-flight-stream refs, not a new flag invented for sync.
 *
 * The caller REFUSES on a true rather than deferring — see
 * src/sync/syncModel.js, where refusing shortens the applied count, the
 * transport forfeits the record's change tag, and the unit is re-offered.
 */
export function threadHolderBusy() {
  return holder?.isBusy?.() === true;
}

/**
 * Ask the holder to take the thread list now in storage. A no-op when nothing
 * holds one, which is the honest answer: loadThreads() re-reads storage.
 */
export function adoptStoredThreads() {
  holder?.adopt();
}

// Clear the legacy single-thread history key (used by /clear).
//
// EMPTIED, not removed. The key is synced and `removeItem` announces nothing,
// so a clear left the old messages on the server. Nothing reads them again on
// THIS device — the migration above runs only when there are no threads at all
// — but a device joining the workspace later starts with none, reads the key
// that was never cleared for it, and resurrects a conversation the person
// explicitly deleted. An empty array is what the migration already treats as
// "nothing to carry over", so this is the same state, said out loud.
export function clearLegacyHistory() {
  try {
    appStorage.setItem(STORAGE_KEY, '[]');
  } catch {
    /* ignore */
  }
}

// Strip heavy/in-memory-only fields before persisting to storage (quota-bound in the browser):
// drop reasoning_details (can carry large encrypted blobs) and cap the reasoning
// string. annotations + run are small and kept as-is. Full reasoning_details stay
// on the live in-memory message so Anthropic continuity holds within the session.
export function sanitizeForPersist(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    const { reasoningDetails, ...rest } = m;
    void reasoningDetails;
    if (typeof rest.reasoning === 'string' && rest.reasoning.length > MAX_PERSISTED_REASONING) {
      rest.reasoning = `${rest.reasoning.slice(0, MAX_PERSISTED_REASONING)}…`;
    }
    return rest;
  });
}

// Trim a message list to the persisted tail (and sanitize heavy fields).
export function trimMessages(messages) {
  return sanitizeForPersist(Array.isArray(messages) ? messages.slice(-MAX_PERSISTED) : []);
}

/**
 * Display name for a thread: an explicit name if the user set one, otherwise a
 * truncated preview of the first user message, falling back to "New Chat".
 */
export function getThreadDisplayName(thread) {
  if (!thread) return 'New Chat';
  if (thread.name && thread.name !== 'New Chat') return thread.name;

  const firstUserMsg = thread.messages?.find((m) => m.role === 'user');
  if (firstUserMsg) {
    const text = firstUserMsg.content || '';
    return text.length > 30 ? `${text.substring(0, 30)}...` : text;
  }
  return thread.name || 'New Chat';
}
