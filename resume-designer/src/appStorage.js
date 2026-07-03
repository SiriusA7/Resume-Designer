/**
 * appStorage — the single persistence facade for every owned key.
 *
 * Why: webview localStorage has a hard ~5MB per-origin quota (WKWebView /
 * WebView2). At quota, writes silently fail and user data (new resumes, edits)
 * vanished. On desktop we therefore persist to real files via Rust commands
 * (one file per key under <AppData>/storage/, atomic tmp+rename writes) —
 * disk-limited, user-visible, Time-Machine friendly.
 *
 * Modes:
 *  - passthrough (browser build, jsdom tests, and pre-init): direct
 *    localStorage calls, synchronous, flush() is a no-op. Identical to the
 *    pre-rework behavior, so the quota guards in persistence.js still matter.
 *  - cached (Tauri, after initAppStorage()): everything is loaded once into an
 *    in-memory Map; reads are synchronous from the cache; each set/remove
 *    marks the key dirty and a coalesced drain write-behinds it to disk.
 *
 * Contract: on Tauri, `await initAppStorage()` MUST run before any module
 * reads or writes storage — it is the first line of init() in main.js (and of
 * printEntry.js with { readOnly: true }). Boot order is already a fragile
 * contract in this app (see maybeAutoMigrateLegacyData); this extends it.
 */

// Canonical Tauri sniff (same predicate as native.js / the index.html inline
// script). Duplicated here instead of importing native.js to avoid an import
// cycle: native.js itself persists through this facade.
const IS_TAURI =
  typeof window !== 'undefined' &&
  ('isTauri' in window || '__TAURI_INTERNALS__' in window || '__TAURI__' in window);

// Every key this app owns starts with `resume-` (resume-designer-*, resume-zoom,
// resume-edit-hint-dismissed, the per-variant history prefix, the model-catalog
// cache, the electron-migration flag). Used only by the one-time adoption.
const OWNED_PREFIX = 'resume-';

// Written to the DISK store before the one-time adoption copies its first key
// and deleted only after every key landed — so a boot that finds it knows a
// previous adoption was KILLED mid-copy (partial disk snapshot; localStorage
// still intact, since it's cleared only after the marker is gone) and must
// redo the copy. Deliberately outside OWNED_PREFIX so backups never carry it.
const ADOPTION_PENDING_KEY = '__adoption_pending__';

let mode = 'passthrough'; // 'passthrough' | 'cached'
let readOnly = false;
let backendImpl = null;
let cache = new Map();
let dirty = new Map(); // key -> 'write' | 'delete'
let drainScheduled = false;
let chain = Promise.resolve();
let failureToastShown = false;
// Monotonic count of permanently-failed disk writes (after retry). flush()
// compares this before/after awaiting the write chain to tell durability
// callers (backup-restore reload, PDF print window) whether their data
// actually reached disk — see flush().
let writeFailures = 0;

// Readiness signal for the React chrome. App.jsx gates every storage-reading
// child on this so their mount-time facade reads can never execute before the
// BOOT DATA is in place — that means initAppStorage() has picked a mode AND
// the legacy Electron migration (which runs after it in init() and populates
// the store on a first post-Electron boot) has settled. A pre-init read hits
// an EMPTY passthrough localStorage and looks like total data loss; a
// pre-migration mount snapshots emptiness and its next save overwrites the
// migrated data (ChatPanel's thread list was the proven case).
// Resolved exactly once, by main.js init() via markStorageReady() in a
// finally spanning both steps. Deliberately NOT reset by
// __resetAppStorageForTests: re-resolving a settled promise is a no-op.
let resolveStorageReady;
const storageReadyPromise = new Promise((resolve) => { resolveStorageReady = resolve; });
export function whenStorageReady() { return storageReadyPromise; }

/**
 * Open the React mount gate (App.jsx awaits whenStorageReady()). Called by
 * main.js init() AFTER BOTH initAppStorage() and maybeAutoMigrateLegacyData()
 * settle — NOT by initAppStorage itself. Re-resolving a settled promise is a
 * no-op, so calling this from a finally is always safe. The print window
 * never calls it: nothing in its framework-free graph awaits the gate.
 */
export function markStorageReady() { resolveStorageReady(); }

function tauriBackend() {
  return {
    async loadAll() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('storage_load_all');
    },
    async write(key, value) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('storage_write', { key, value });
    },
    async delete(key) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('storage_delete', { key });
    },
    async clear() {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke('storage_clear');
    },
  };
}

/**
 * Surface a storage failure to the user at most once per session. sonner is
 * imported lazily (fire-and-forget) so this module stays importable from the
 * React-free print bundle — a static `import { toast } from 'sonner'` would
 * drag React, ReactDOM and a CSS injection into printEntry.js. The import can
 * fail or land where no Toaster is mounted; callers must console.error FIRST
 * so the failure is recorded regardless.
 */
function showFailureToastOnce(message) {
  if (failureToastShown) return;
  failureToastShown = true;
  import('sonner').then(({ toast }) => toast.error(message)).catch(() => {});
}

function reportWriteFailure(key, err) {
  writeFailures += 1;
  console.error(`[appStorage] disk write failed for "${key}":`, err);
  showFailureToastOnce(
    'Some changes could not be saved to disk — check free disk space. '
    + 'Your edits are kept in memory for this session; export a backup via '
    + 'Settings → Data → Export Backup.',
  );
}

function scheduleDrain() {
  if (drainScheduled || readOnly) return;
  drainScheduled = true;
  setTimeout(drain, 0);
}

function drain() {
  drainScheduled = false;
  const batch = [...dirty.entries()];
  dirty.clear();
  for (const [key, op] of batch) {
    // Value is read from the cache at write time, so a set that happened
    // after this key was marked dirty still writes the latest value. If a
    // removeItem landed after this write op was snapshotted, the key is gone
    // from the cache and a delete op is guaranteed queued behind us — skip
    // the write rather than materialize a spurious '' file (which a crash
    // before that delete would leave on disk).
    chain = chain.then(async () => {
      try {
        if (op === 'delete') await backendImpl.delete(key);
        else if (cache.has(key)) await backendImpl.write(key, cache.get(key));
      } catch {
        try {
          if (op === 'delete') await backendImpl.delete(key);
          else if (cache.has(key)) await backendImpl.write(key, cache.get(key));
        } catch (err2) {
          // The write failed twice. Keep the value in cache (the session keeps
          // working) AND re-mark the key dirty so the NEXT drain/flush retries
          // it. Without re-queueing, a failed write is dropped from `dirty`
          // forever: once the disk frees up, a later flush() finds no dirty
          // work and reports durable === true while the cache value never
          // reached disk — so the print/reload/relaunch paths would proceed
          // against stale files (the exact durability signal flush() exists to
          // give). Guards: don't clobber a newer op already queued for this key
          // (a later delete/write wins), and skip a stale write whose value has
          // since left the cache. Deliberately DON'T scheduleDrain() here — a
          // permanently full disk must not busy-loop; the retry rides the next
          // user-triggered drain or the next flush() (which drains first).
          if (!dirty.has(key) && (op === 'delete' || cache.has(key))) {
            dirty.set(key, op);
          }
          reportWriteFailure(key, err2);
        }
      }
    });
  }
}

export const appStorage = {
  getItem(key) {
    if (mode === 'passthrough') return localStorage.getItem(key);
    return cache.has(key) ? cache.get(key) : null;
  },

  setItem(key, value) {
    const v = String(value);
    if (mode === 'passthrough') {
      // readOnly passthrough (print window whose disk load failed): there is
      // no separate cache here, and it must never touch localStorage — no-op.
      if (readOnly) return;
      localStorage.setItem(key, v); // may throw on quota — callers guard
      return;
    }
    cache.set(key, v);
    if (readOnly) return; // print window: cache-only, never queued to disk
    dirty.set(key, 'write');
    scheduleDrain();
  },

  removeItem(key) {
    if (mode === 'passthrough') {
      if (readOnly) return; // see setItem: readOnly passthrough never writes
      localStorage.removeItem(key);
      return;
    }
    cache.delete(key);
    if (readOnly) return; // print window: cache-only, never queued to disk
    dirty.set(key, 'delete');
    scheduleDrain();
  },

  /** Remove every stored key (backup "Replace" import path). */
  clear() {
    if (mode === 'passthrough') {
      if (readOnly) return; // see setItem: readOnly passthrough never writes
      localStorage.clear();
      return;
    }
    cache.clear();
    dirty.clear();
    if (!readOnly) {
      // Failure mode: if backendImpl.clear() rejects, the cache is already
      // empty but the old files survive until the next boot. For the backup
      // "Replace" flow that's benign — the envelope writes that follow
      // overwrite every key that matters, so the residue is orphan files,
      // not resurrected data.
      chain = chain.then(() => backendImpl.clear()).catch((e) => reportWriteFailure('<clear>', e));
    }
  },

  /** Snapshot of all stored keys (replaces localStorage index iteration). */
  keys() {
    if (mode === 'passthrough') {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) out.push(localStorage.key(i));
      return out;
    }
    return [...cache.keys()];
  },

  /**
   * Wait for every pending disk write to settle, then report DURABILITY:
   * resolves `true` if all awaited writes reached disk, `false` if any failed
   * (disk full / permissions — the value stays in the in-memory cache and the
   * failure toast fires, but it is NOT on disk). Callers that act on disk
   * state from outside this cache — the backup-restore reload (boots from
   * disk) and PDF export (a separate read-only print webview reads only disk)
   * — MUST check this and not proceed against stale files on `false`.
   * Passthrough (browser localStorage) is synchronous, so it is always durable.
   */
  async flush() {
    if (mode === 'passthrough') return true;
    const before = writeFailures;
    if (dirty.size) drain();
    await chain;
    return writeFailures === before;
  },
};

/**
 * Pick the backend and load the boot snapshot. Browser → stays passthrough.
 * Tauri (or an injected test backend) → cached mode + one-time adoption of
 * localStorage `resume-*` keys when the disk store is empty.
 *
 * Does NOT open the whenStorageReady() gate — the legacy Electron migration
 * still runs after this in init() and populates the store on a first
 * post-Electron boot, so main.js calls markStorageReady() only once BOTH have
 * settled (in a finally spanning the two, so the gate still can't deadlock).
 */
export async function initAppStorage({ backend = null, readOnly: ro = false } = {}) {
  if (!backend && !IS_TAURI) return; // browser/jsdom: passthrough forever

  backendImpl = backend || tauriBackend();
  readOnly = ro;

  let loaded;
  try {
    loaded = await backendImpl.loadAll();
  } catch (err) {
    console.error('[appStorage] loadAll failed:', err);
    backendImpl = null;
    if (readOnly) {
      // Print window: do NOT degrade to passthrough localStorage. After the
      // one-time adoption the resume lives ONLY in the disk store (localStorage
      // was emptied), so a fallback here would render an empty/stale resume and
      // let the main window capture a wrong PDF. Re-throw so printEntry.js can
      // emit `print-error` and abort the export instead of silently succeeding.
      throw err;
    }
    // Main window (the sole writer): degrade to passthrough localStorage rather
    // than booting with an empty store (which would look like total data loss),
    // and warn the user that this session's changes may not persist.
    showFailureToastOnce(
      'Stored data could not be loaded from disk — running on a fallback '
      + 'store, and changes made this session may not persist. Check the '
      + 'app data folder, then restart.',
    );
    return;
  }
  cache = new Map(Object.entries(loaded));
  mode = 'cached';

  // One-time adoption: disk empty + localStorage has owned keys. A surviving
  // ADOPTION_PENDING_KEY means a previous adoption was KILLED mid-copy — the
  // disk holds a partial snapshot while localStorage still has the complete
  // set (it's cleared only after the marker is deleted) — so redo the copy;
  // localStorage stays authoritative until the marker is gone.
  const adoptionPending = cache.has(ADOPTION_PENDING_KEY);
  if (!readOnly && (cache.size === 0 || adoptionPending)) {
    const owned = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(OWNED_PREFIX)) owned.push(k);
    }
    if (owned.length) {
      try {
        // Marker FIRST: if this boot dies mid-copy, the next one sees it and
        // redoes the copy from the still-intact localStorage.
        await backendImpl.write(ADOPTION_PENDING_KEY, '1');
        cache.set(ADOPTION_PENDING_KEY, '1');
        for (const k of owned) {
          const v = localStorage.getItem(k);
          if (v === null) continue;
          await backendImpl.write(k, v); // sequential; throw aborts adoption
          cache.set(k, v);
        }
        // Every write landed — retire the marker, THEN hand over: localStorage
        // is no longer the source of truth.
        await backendImpl.delete(ADOPTION_PENDING_KEY);
        cache.delete(ADOPTION_PENDING_KEY);
        for (const k of owned) localStorage.removeItem(k);
        console.log(`[appStorage] adopted ${owned.length} keys from localStorage to disk`);
      } catch (err) {
        // Abort cleanly: fall back to passthrough so the app keeps running
        // off the still-intact localStorage. Nothing was removed from it.
        console.error('[appStorage] adoption failed — staying on localStorage:', err);
        // Best-effort: wipe whatever partial copy landed before the failure.
        // Leaving even one file behind would make the next boot see a
        // non-empty store, skip adoption forever, and silently shadow the
        // newer localStorage data. Safe: everything on disk at this point is a
        // shadow copy of keys still present in localStorage (empty-store
        // precondition, or a partial copy from the interrupted run being
        // redone), so clear() cannot destroy the only copy of anything.
        try {
          await backendImpl.clear();
        } catch (clearErr) {
          console.error(
            '[appStorage] cleanup after failed adoption also failed — the disk '
            + 'store may contain a partial copy that will shadow localStorage '
            + 'on the next boot:',
            clearErr,
          );
        }
        cache = new Map();
        dirty = new Map();
        mode = 'passthrough';
        backendImpl = null;
      }
    } else if (adoptionPending) {
      // Marker with nothing left to adopt (shouldn't happen given the write
      // ordering) — drop it best-effort; a failure just retries next boot.
      try {
        await backendImpl.delete(ADOPTION_PENDING_KEY);
        cache.delete(ADOPTION_PENDING_KEY);
      } catch (err) {
        console.error('[appStorage] could not clear a stale adoption marker:', err);
      }
    }
  }
}

/** Test-only: reset module state between tests. */
export function __resetAppStorageForTests() {
  mode = 'passthrough';
  readOnly = false;
  backendImpl = null;
  cache = new Map();
  dirty = new Map();
  drainScheduled = false;
  chain = Promise.resolve();
  failureToastShown = false;
  writeFailures = 0;
}
