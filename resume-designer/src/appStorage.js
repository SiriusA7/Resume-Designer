import { mapKey } from './profileKeys.js';

// Active profile for key namespacing. Null until profiles.js resolves the
// active profile at boot (ensureProfilesInitialized / the print window's
// activateProfileMappingForPrint) — identity mapping until then, which is
// exactly what the pre-profile boot steps (Electron migration, adoption)
// rely on to see unprefixed keys.
let activeProfileId = null;

export function setProfileMapping(profileId) {
  activeProfileId = profileId || null;
}

/**
 * The profile every owned read and write is currently namespaced to, or null
 * while mapping is inactive.
 *
 * For the one kind of caller whose ANSWER depends on which namespace it read
 * from: `isUntouchedWorkspace` (profiles.js) discards a workspace when its keys
 * read back empty, and mapping-off is a state where EVERY key reads back empty
 * — a degraded init runs exactly like that. The active-profile POINTER cannot
 * answer this; it says which workspace the app is in, not whether reads are
 * resolving into it.
 */
export function getProfileMapping() {
  return activeProfileId;
}

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
let drainTimer = null; // handle for the pending coalescing setTimeout; cleared whenever a drain runs
let chain = Promise.resolve();
// Write-behind coalescing window. setItem updates the cache synchronously
// (close-safe) and marks the key dirty; the disk write is deferred this long so
// a burst of rapid writes — e.g. typing into the application-notes field, which
// calls setItem on every keystroke — collapses into ONE backend write of the
// latest value instead of one write per keystroke. The drainScheduled guard
// makes this a throttle, not a debounce: a drain always lands within this window
// of the first dirty write even during continuous typing (bounded durability
// lag), and flush() still forces an immediate synchronous drain for every
// durability barrier (close, visibilitychange, import, print, profile ops).
const DRAIN_COALESCE_MS = 250;
let failureToastShown = false;
// Monotonic count of permanently-failed disk writes (after retry). flush()
// compares this before/after awaiting the write chain to tell durability
// callers (backup-restore reload, PDF print window) whether their data
// actually reached disk — see flush().
let writeFailures = 0;

// Restore guard: for a caller-bounded window during a destructive backup restore,
// appStorage BLOCKS every other ("external") writer so a late async completion (a
// chat/AI reply, a tailor draft, a design-setting edit) can't serialize a
// pre-import snapshot over the just-restored keys. The import arms the guard AFTER
// its synchronous restore writes (single-threaded, so its own writes are already
// applied — no bypass needed) and RELEASES it on success; the interactive reload
// funnel re-arms it across the modal + reload. A non-reloading caller (the boot
// migration) relies on that release, or every subsequent write would be deferred.
// Skipped writes are recorded (latest op per key) so a FAILED restore can replay
// them after its rollback instead of silently dropping them.
let restoreGuardActive = false;
const deferredDuringRestore = new Map(); // mapped key -> { op: 'write'|'delete', value? }
// Pre-restore values (mapped key -> value) served for READS while the guard is
// armed, so a read-modify-write writer (e.g. token tracking) sees the pre-restore
// state — snapshot isolation — and its deferred write stays replay-safe if the
// restore rolls back. Null for the interactive modal re-arm (the import already
// committed; reads should see the restored cache and no rollback follows).
let preRestoreSnapshot = null;

// ── the sync stamping seam ─────────────────────────────────────────────────
//
// A write to a key the sync layer syncs has to mark that unit locally modified,
// or the unit is uploaded once by the full sweep that runs when sync is first
// switched on and NEVER again. The hook lives here, at the one function every
// owned write already funnels through, rather than at the ~14 call sites that
// write a synced key: the list of synced keys is `classifyKey`'s
// (src/sync/syncKeys.js), an interceptor that asks it cannot drift from it, and
// a call site added later is simply forgotten — which is exactly how the gap
// this closes opened in the first place.
//
// This file cannot import the sync layer (the sync layer imports THIS file), so
// main.js installs the observer, the same graph edge it already owns for
// registerPersistedSaveHandler.
//
// `onWrite(logicalKey, value, previous)` is handed the LOGICAL key, because
// that is what `classifyKey` takes — a physical, profile-namespaced key comes
// back 'unknown' there and would sync nothing. `previous` is the value the
// write replaced, and it is what lets the observer tell a `resume-designer-data`
// write that changed `settings` from one that only touched a résumé.
//
// `onFlush()` is called from the write-behind drain — the coalescing window
// this file already runs on, and the one every durability barrier forces
// through flush(). The observer accumulates ids in onWrite and notifies ONCE
// per window there. That matters: the application-notes field writes on every
// keystroke ON PURPOSE (see DetailPane.jsx), on the understanding that this
// layer collapses the burst into one write — a sync notification per character
// would be a CloudKit send per character.
let writeObserver = null;

/** Install (or, with null, remove) the sync stamping observer. */
export function setStorageWriteObserver(observer) {
  writeObserver = observer && typeof observer.onWrite === 'function' ? observer : null;
}

/** The stored value for a MAPPED key, read the same way getItem's tail does. */
function readStored(mappedKey) {
  if (mode === 'passthrough') return localStorage.getItem(mappedKey);
  return cache.has(mappedKey) ? cache.get(mappedKey) : null;
}

/**
 * Both observer calls swallow and log a throw, deliberately: the bytes are
 * already stored by the time either runs, and letting a bookkeeping failure
 * propagate would surface at whichever call site happened to be writing and
 * read there as a lost edit. persistence.js guards its own stamping the same
 * way, for the same reason.
 */
function observeWrite(logicalKey, value, previous) {
  if (!writeObserver) return;
  try {
    writeObserver.onWrite(logicalKey, value, previous);
  } catch (err) {
    console.error(`[appStorage] sync stamping failed for "${logicalKey}":`, err);
  }
}

function observeFlush() {
  if (!writeObserver?.onFlush) return;
  try {
    writeObserver.onFlush();
  } catch (err) {
    console.error('[appStorage] sync notification failed:', err);
  }
}

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
  drainTimer = setTimeout(drain, DRAIN_COALESCE_MS);
}

function drain() {
  drainScheduled = false;
  // Disarm the coalescing timer. flush() calls drain() directly (bypassing the
  // timer) at every durability barrier; without this the timer stays armed and
  // later fires a spurious drain that clears drainScheduled while a newer timer
  // is already pending — cascading overlapping timers back toward one write per
  // keystroke. When the timer itself fires drain(), clearTimeout on the
  // just-fired id is a harmless no-op.
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
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
  // The coalescing window just closed: one sync notification for everything
  // stamped since the last drain (see setStorageWriteObserver). Outside the
  // per-key chain on purpose — the notification says WHAT changed, and the
  // transport decides when it goes up; making it wait on the disk chain would
  // hold it behind an unrelated key's retry.
  observeFlush();
}

export const appStorage = {
  getItem(key) {
    key = mapKey(activeProfileId, key);
    // Isolated-read window ONLY — a durable import's flush await, where the
    // snapshot is present: serve the writer's own in-flight deferred write (so
    // successive read-modify-writes accumulate) then the PRE-restore value, so
    // writers compute against pre-restore rather than the uncommitted restored
    // value a failed restore would roll back. Once the snapshot is cleared (the
    // success modal, or a stay-put final-flush failure), reads return the
    // committed cache — a recovery export must serialize THAT, not a deferred
    // stale value from a post-alert write.
    if (restoreGuardActive && preRestoreSnapshot) {
      const pending = deferredDuringRestore.get(key);
      if (pending) return pending.op === 'delete' ? null : pending.value;
      if (preRestoreSnapshot.has(key)) return preRestoreSnapshot.get(key);
    }
    if (mode === 'passthrough') return localStorage.getItem(key);
    return cache.has(key) ? cache.get(key) : null;
  },

  setItem(key, value) {
    // Kept before the mapping: `classifyKey` — the sync layer's authority on
    // which keys travel — is defined over LOGICAL keys (see setStorageWriteObserver).
    const logicalKey = key;
    key = mapKey(activeProfileId, key);
    const v = String(value);
    // Blocked mid-restore: record the latest write and skip cache+disk (see the
    // restoreGuardActive note). The import's own writes ran before the guard armed.
    // No observer call either — nothing was stored, so nothing changed yet.
    if (restoreGuardActive) { deferredDuringRestore.set(key, { op: 'write', value: v }); return; }
    // Read BEFORE the write lands, and only when someone is listening. In cached
    // mode — every shipped desktop and iOS build — this is a Map lookup.
    const previous = writeObserver ? readStored(key) : null;
    if (mode === 'passthrough') {
      // readOnly passthrough (print window whose disk load failed): there is
      // no separate cache here, and it must never touch localStorage — no-op.
      if (readOnly) return;
      localStorage.setItem(key, v); // may throw on quota — callers guard
      // AFTER the store, so a quota throw above leaves no unit claiming a
      // change that never landed.
      observeWrite(logicalKey, v, previous);
      // Passthrough has no drain to coalesce on — this call IS the durable
      // write, so the notification window opens and closes with it.
      observeFlush();
      return;
    }
    cache.set(key, v);
    if (readOnly) return; // print window: cache-only, never queued to disk
    dirty.set(key, 'write');
    scheduleDrain();
    observeWrite(logicalKey, v, previous);
  },

  // Deliberately NOT observed. `collectKeyUnit` (syncModel.js) answers null for
  // an absent key — "absent is not empty", since an empty payload would CLEAR
  // that key on every receiving device — so a stamped removal names a unit the
  // model would then decline to build. Deletion does not propagate in this
  // design; nothing here is a tombstone.
  removeItem(key) {
    key = mapKey(activeProfileId, key);
    if (restoreGuardActive) { deferredDuringRestore.set(key, { op: 'delete' }); return; }
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

  /**
   * Arm the restore guard: while armed, every external setItem/removeItem is
   * recorded (latest op per key) and skipped instead of touching cache/disk, and
   * READS are served from `preRestore` (a mapped-key -> value snapshot of the
   * pre-restore state) so read-modify-write writers compute against pre-restore.
   * The caller MUST later release it — endRestoreGuard() + flushDeferredWrites()
   * on a failed restore, or endRestoreGuard() + discardDeferredWrites() on success
   * — or a non-reloading caller would defer every subsequent write. The import's
   * own writes ran synchronously BEFORE this, so they are already applied. The
   * interactive modal re-arm passes no snapshot (the import committed; reads
   * should see the restored cache, and no rollback follows).
   */
  beginRestoreGuard(preRestore = null, writtenKeys = null) {
    restoreGuardActive = true;
    deferredDuringRestore.clear();
    if (!preRestore) { preRestoreSnapshot = null; return; }
    // Normalize snapshot keys to the PHYSICAL form getItem() reads by — a format-1
    // restore passes logical written keys while profile mapping is active, so an
    // unmapped snapshot key would never match the mapped read. Then mark keys the
    // backup ADDED (written but absent pre-restore) as null, so their writers read
    // "absent" instead of the uncommitted imported value.
    preRestoreSnapshot = new Map();
    for (const [k, v] of preRestore) preRestoreSnapshot.set(mapKey(activeProfileId, k), v);
    if (writtenKeys) {
      for (const k of writtenKeys) {
        const mk = mapKey(activeProfileId, k);
        if (!preRestoreSnapshot.has(mk)) preRestoreSnapshot.set(mk, null);
      }
    }
  },

  /**
   * Disarm WITHOUT replaying — the restore failed and is about to roll back,
   * whose writes must reach storage. The recorded writes are kept so
   * flushDeferredWrites() can replay them on top of the restored snapshot.
   */
  endRestoreGuard() {
    restoreGuardActive = false;
    preRestoreSnapshot = null;
  },

  /**
   * Drop the pre-restore snapshot while KEEPING the guard armed. Called on a
   * successful durable import: the restore committed (no rollback can follow), so
   * reads should now return the restored cache, but the guard stays armed for the
   * interactive caller's continuous ownership through its modal + reload.
   */
  clearPreRestoreSnapshot() {
    preRestoreSnapshot = null;
  },

  /**
   * Replay the external writes skipped during the guard window (latest per key),
   * then clear them. Called on a FAILED restore AFTER endRestoreGuard() and the
   * rollback, so an in-flight completion the user paid for lands on top of the
   * rolled-back data instead of being lost. Never called on success — the reload
   * discards the guard state.
   */
  flushDeferredWrites() {
    // Only reached in CACHED mode — importFullBackupDurably's failure path, which
    // can't trigger in passthrough (its flush() is always durable). Guard so a
    // stray passthrough call is a clean no-op rather than a null-backend drain.
    if (mode !== 'cached') {
      deferredDuringRestore.clear();
      preRestoreSnapshot = null;
      return;
    }
    // Replay ALL deferred writes. The snapshot already made writers read the
    // pre-restore value (null for keys the backup added), so a replayed write
    // carries the writer's OWN new activity — e.g. a paid AI request's first
    // token-usage record — NOT the discarded imported value. Dropping writes to
    // previously-absent keys would lose real work done during the window.
    let applied = false;
    for (const [key, entry] of deferredDuringRestore) {
      if (entry.op === 'delete') {
        cache.delete(key);
        dirty.set(key, 'delete');
      } else {
        cache.set(key, entry.value);
        dirty.set(key, 'write');
      }
      applied = true;
    }
    deferredDuringRestore.clear();
    preRestoreSnapshot = null;
    if (applied) scheduleDrain();
  },

  /**
   * Drop the writes skipped during the guard window WITHOUT applying them — the
   * success path, where the reload boots from the (canonical) restored data.
   */
  discardDeferredWrites() {
    deferredDuringRestore.clear();
    preRestoreSnapshot = null;
  },

  /**
   * Whether a restore guard is currently armed. Import entry points check this to
   * SERIALIZE: a second restore started while one is mid-flight (the first is
   * awaiting its flush, or its success modal is open) must bail — otherwise its
   * synchronous writes are silently deferred by the active guard and its own
   * beginRestoreGuard() then clears them, reporting a success that never applied.
   */
  isRestoreGuardActive() {
    return restoreGuardActive;
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
  activeProfileId = null;
  mode = 'passthrough';
  readOnly = false;
  backendImpl = null;
  cache = new Map();
  dirty = new Map();
  drainScheduled = false;
  if (drainTimer) {
    clearTimeout(drainTimer);
    drainTimer = null;
  }
  chain = Promise.resolve();
  failureToastShown = false;
  writeFailures = 0;
  writeObserver = null;
  restoreGuardActive = false;
  deferredDuringRestore.clear();
  preRestoreSnapshot = null;
}
