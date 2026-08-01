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
 * Load all threads and decide which is current. Migrates legacy single-thread
 * history on first run, guarantees at least one thread, and selects the
 * most-recently-updated thread as current. Mirrors the old loadChatHistory().
 */
export function loadThreads() {
  try {
    const saved = appStorage.getItem(THREADS_KEY);
    let threads = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(threads)) threads = [];

    if (threads.length === 0) {
      // Migrate any old single-thread history into a fresh thread — in memory
      // only. An empty/initial READ must never WRITE: if this path ever ran
      // against the wrong store (e.g. a pre-init passthrough on Tauri), a
      // persist here would clobber the real saved threads with an empty one.
      // The first real user action persists via the useChat callers.
      const oldHistory = appStorage.getItem(STORAGE_KEY);
      const oldMessages = oldHistory ? JSON.parse(oldHistory) : [];
      const thread = makeThread('New Chat', Array.isArray(oldMessages) ? oldMessages : []);
      threads = [thread];
      return { threads, currentThreadId: thread.id };
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

// Clear the legacy single-thread history key (used by /clear).
export function clearLegacyHistory() {
  try {
    appStorage.removeItem(STORAGE_KEY);
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
