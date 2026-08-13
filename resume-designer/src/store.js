/**
 * Resume Store - Reactive state management for resume data
 * Handles state updates, change events, and coordinates with persistence
 */

import { appStorage } from './appStorage.js';
// The ONE guarded path-write primitive. store.update is reachable with
// AI-supplied paths (applyChangeToStore routes every accepted change here), so
// the __proto__/constructor/prototype segment guard must hold at this layer
// too — not only in createChangeSet's pre-filter. diffEngine imports nothing
// from this module (only the npm `diff` package), so sharing creates no cycle.
import { setByPath } from './diffEngine.js';
import { BACKUP_HISTORY_PREFIX, SYNC_STATE_KEY } from './profileKeys.js';
// The history bound, from a leaf module both this store and the sync layer can
// import — see historyLimits.js for why neither of them may own it.
import { MAX_HISTORY } from './historyLimits.js';
// The union rule, which this store and the sync layer have to agree on to the
// letter. syncMerge.js is pure — no storage, no DOM, no app imports — so
// importing it here cannot close a cycle with syncModel.js's import of this
// file. See adoptHistory below.
import { mergeHistory, entryIdentity } from './sync/syncMerge.js';

// Cryptographically-secure random suffix (replaces Math.random; getRandomValues
// has no secure-context requirement, so it works in the Tauri custom-scheme
// webview and the browser build alike).
export function randomSuffix() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36);
}

// Generate unique IDs for new items
export function generateId(prefix = 'item') {
  return `${prefix}-${Date.now()}-${randomSuffix()}`;
}

// This device's identity, stamped as `origin` on every history entry this store
// writes.
//
// Version history syncs, so a merged timeline holds entries this user never
// stepped through on this machine. Undo is a record of steps taken HERE (see
// isOwnStep below), and telling the two apart needs a name for "here".
//
// It lives in `resume-designer-sync-state`, the device-local key the sync layer
// already keeps its bookkeeping in — classified `local` in src/sync/syncKeys.js,
// so it never leaves the machine — rather than in a key of its own: a new key is
// a new file in the disk store and a new section in every backup, for one
// string. It sits ALONGSIDE that key's `{ unitId: { modifiedAt } }` entries and
// cannot collide with one, because every unit id carries a prefix (`resume:`,
// `key:`, `data:`), and touchUnit's read-modify-write preserves it.
//
// Generated once and then reused, because it has to be STABLE: an id that
// changed between sessions would make this user's own earlier entries look
// foreign and strand their whole history behind their own undo. Memoised for
// the process, which is enough — switching profiles reloads the window, so the
// cached id can never outlive the profile whose key it came from.
let originId = null;
function deviceOrigin() {
  if (originId) return originId;

  let recorded = {};
  try {
    const raw = appStorage.getItem(SYNC_STATE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') recorded = parsed;
  } catch {
    // Unreadable bookkeeping. A fresh id is written over it below; the
    // timestamps in it were this device's own view of sync and are recoverable.
  }

  if (typeof recorded.deviceId === 'string' && recorded.deviceId) {
    originId = recorded.deviceId;
    return originId;
  }

  originId = `device-${randomSuffix()}`;
  try {
    appStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ ...recorded, deviceId: originId }));
  } catch (e) {
    // Quota, or a browser passthrough refusing the write. The id still holds
    // for this session, so undo behaves; the next boot generates another one.
    console.warn('Failed to record this device id:', e);
  }
  return originId;
}

// Comparable sort key for an experience entry: higher = more recent. Drives the
// chronological (newest-first) default order and the "Date" sort button.
// Prefers the human-readable `dates` string — the field the structure panel
// exposes for editing — so the sort stays in sync when the user edits it; falls
// back to the machine-readable endDate. An ongoing role ("Present"/"Current"/
// "Currently"/"to date"/etc.) sorts newest; an entry with no parseable date
// sorts oldest. Finite values only (no Infinity) so two
// equal keys subtract to 0, never NaN. (#7)
export function experienceSortValue(exp) {
  if (!exp) return 0;
  const raw = String(exp.dates || exp.endDate || '').trim();
  if (!raw) return 0;
  if (/\b(present|current|currently|ongoing|now|to date|till date)\b/i.test(raw)) return 9999 * 12;
  const years = raw.match(/\d{4}/g);
  if (!years || years.length === 0) return 0;
  const year = parseInt(years[years.length - 1], 10);
  // Month precision for same-year ordering. Prefer a "YYYY-MM" in the visible
  // dates; if absent, borrow the month from the machine-readable endDate, but
  // only when endDate refers to the same end year — so a later edit to the
  // visible year still wins (a changed year de-syncs endDate and we ignore it).
  // (#7, PR#13)
  const ym = raw.match(/(\d{4})-(\d{1,2})/g);
  let month = 0;
  if (ym && ym.length) {
    month = parseInt(ym[ym.length - 1].split('-')[1], 10) || 0;
  } else if (exp.endDate) {
    const em = String(exp.endDate).match(/(\d{4})-(\d{1,2})/);
    if (em && parseInt(em[1], 10) === year) month = parseInt(em[2], 10) || 0;
  }
  month = Math.min(12, Math.max(0, month));
  return year * 12 + month;
}

// Deep clone utility
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Get nested value by path (e.g., "contact.email")
function getByPath(obj, path) {
  return path.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    // Handle array index notation like "experience[0]"
    const match = key.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      return current[match[1]]?.[parseInt(match[2])];
    }
    return current[key];
  }, obj);
}

// History persistence key prefix. Re-exported from profileKeys.js rather than
// re-declared: isOwnedKey() keys off the same constant, so a second literal
// here would have to stay byte-identical with nothing enforcing it.
const HISTORY_KEY_PREFIX = BACKUP_HISTORY_PREFIX;

// Change type constants
export const CHANGE_TYPES = {
  INITIAL: 'initial',
  EDIT: 'edit',
  AI: 'ai',
  IMPORT: 'import',
  REORDER: 'reorder',
  ADD: 'add',
  REMOVE: 'remove',
  // Not a change this user made: the LOSING side of a sync conflict, parked in
  // history by src/sync/syncModel.js so "newer wins" destroys nothing. Named
  // here because two places have to agree on the string — the park that writes
  // it and the undo/redo traversal that steps over it.
  SYNC_CONFLICT: 'sync-conflict'
};

// Sections gained an `area` in 2026-07. Every pre-existing section is a sidebar
// section by definition, so stamping 'sidebar' keeps rendered output identical.
// Additive on purpose: the array, its indices and every sections[i].content[j]
// path are untouched, so AI change paths, data-editable attributes, saved
// variants and backups keep working without their own migration.
const SECTION_AREAS = new Set(['main', 'sidebar']);

export function migrateSectionAreas(data) {
  if (!data || !Array.isArray(data.sections)) return data;
  return {
    ...data,
    sections: data.sections.map((section) => ({
      ...section,
      area: SECTION_AREAS.has(section && section.area) ? section.area : 'sidebar',
    })),
  };
}

// Create the store
function createStore() {
  let data = null;
  let isDirty = false;
  const listeners = new Set();
  let saveCallback = null;
  let saveTimeout = null;
  // Latched off before a destructive restore reloads the window. Between the
  // restore writing appStorage and the reload booting from it, the in-memory
  // `data` is the STALE pre-import resume; a save in that window (the
  // visibilitychange/close handlers call saveNow) would write it back into the
  // freshly-restored profile — corrupting the backup. Once suspended it stays
  // suspended: the only path forward from a restore is the reload.
  let savesSuspended = false;
  const SAVE_DEBOUNCE_MS = 500;
  
  // Undo/redo history with metadata
  // Each entry: { data, timestamp, description, changeType, path? }
  let history = [];
  let historyIndex = -1;
  let isUndoRedoAction = false;
  let currentVariantId = null;
  let pendingChangeDescription = null;
  let pendingChangeType = CHANGE_TYPES.EDIT;

  // The undo timeline is a record of the steps THIS USER TOOK ON THIS DEVICE,
  // and since version history syncs, a merged timeline holds entries that are
  // neither. The traversal below steps over every one of them: no Cmd+Z, and no
  // Cmd+Shift+Z, ever lands on an entry the user did not make here.
  //
  // Two kinds reach the array, and they are ONE rule, not two:
  //
  // - A parked sync conflict — another device's REJECTED résumé, the losing
  //   side of "newer wins", archived by src/sync/syncModel.js so nothing is
  //   destroyed. Never a step anyone took here.
  // - An ordinary entry another device wrote, brought in by the union merge
  //   (adoptHistory). Edit on the phone, open the Mac, press Cmd+Z, and undo
  //   would hand back the phone's document rather than your own last state.
  //   Nothing is lost, but it reads as loss.
  //
  // An entry with NO `origin` is this device's. History was device-local before
  // sync existed, so every entry written before the field really was written
  // here — and reading absence the other way would strand a user's entire
  // existing history behind their own undo.
  //
  // Skipped entries stay exactly where they are in the array —
  // getHistoryEntries still lists them and restoreToEntry still restores them,
  // which is the entire point of keeping them. Only the traversal narrows.
  //
  // Doing it here rather than at each place such an entry can be inserted is
  // what makes the rule hold everywhere at once: at historyIndex 0 there is no
  // slot below the current entry for adoptHistoryEntry to use, a variant this
  // device has never opened can load with a park as its only entry, and a
  // history merge can leave either kind at the end. Each of those puts a
  // version the user never chose one Cmd+Z away, and they are all the same
  // mistake.
  const isParked = (entry) => entry?.changeType === CHANGE_TYPES.SYNC_CONFLICT;
  const isForeign = (entry) => entry?.origin != null && entry.origin !== deviceOrigin();
  const isOwnStep = (entry) => !isParked(entry) && !isForeign(entry);
  // The index undo/redo would move to from `from`, or -1 when there is none.
  const undoTarget = (from) => {
    let i = from - 1;
    while (i >= 0 && !isOwnStep(history[i])) i -= 1;
    return i;
  };
  const redoTarget = (from) => {
    let i = from + 1;
    while (i < history.length && !isOwnStep(history[i])) i += 1;
    return i < history.length ? i : -1;
  };

  return {
    // Get current data (returns a clone to prevent direct mutation)
    getData() {
      return data ? deepClone(data) : null;
    },

    // Get raw reference (use carefully)
    getDataRef() {
      return data;
    },

    // Set entire data object
    setData(newData, skipSave = false, variantId = null) {
      data = deepClone(migrateSectionAreas(newData));
      isDirty = false;
      
      // Track current variant for history persistence
      if (variantId) {
        currentVariantId = variantId;
        // Try to load existing history for this variant
        this.loadHistory(variantId);
      }
      
      // If no history was loaded, initialize with current state.
      //
      // Or whenever the entry the loaded history calls current is NOT one of
      // this user's own steps (isOwnStep) — a parked conflict loser, or an
      // entry another device wrote. Both leave the timeline claiming a version
      // the user never chose is the one on screen, and sync produces them two
      // ways:
      //
      // - A variant this device has never opened has no history for parkLoser
      //   to insert into, so syncModel.js's storage path writes `{ history:
      //   [loser], historyIndex: 0 }`. loadHistory takes its success path on
      //   that, so no 'Initial state' was pushed and the rejected version was
      //   marked current, permanently.
      // - A history unit for a variant that is not loaded is merged straight
      //   into its key, with mergeHistory's index — the NEWEST entry, which the
      //   union routinely takes from the other device. Nothing there is a park,
      //   so a park-only check passed, the dialog marked a remote entry
      //   current, and one edit plus one Cmd+Z put that device's résumé on
      //   screen.
      //
      // Recording the state actually on screen fixes both: it lands at the end,
      // so there is no redo future for pushHistory to splice away either, and
      // the merged entries survive. A missing entry (an empty history, or a
      // stored index that points past the array) is repaired the same way.
      //
      // What this must NOT ask is whether the current entry's data still EQUALS
      // the document. updateSilent writes UI-only state (an accordion's
      // `_expanded`, `experienceSortMode`) into `data` and persists it without
      // a history entry, by design — so that drift is ordinary and expected,
      // not a broken invariant. Re-pointing on it appended an 'Initial state'
      // every time a résumé was reopened after an accordion toggle, which
      // doubled the length of version history and made Cmd+Z take two presses
      // per real edit. See the regression test in test/storeHistory.test.js.
      const current = history[historyIndex];
      if (!current || !isOwnStep(current)) {
        history.push({
          data: deepClone(data),
          timestamp: new Date().toISOString(),
          description: 'Initial state',
          changeType: CHANGE_TYPES.INITIAL,
          origin: deviceOrigin()
        });
        historyIndex = history.length - 1;
      }
      
      this.emit('dataLoaded', data);
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      if (!skipSave) {
        this.scheduleSave();
      }
    },

    // Update a specific field by path
    update(path, value) {
      if (!data) return;
      
      // Make the change
      setByPath(data, path, value);
      isDirty = true;
      
      // Save state to history AFTER making changes (unless this is an undo/redo action)
      if (!isUndoRedoAction) {
        this.pushHistory();
      }
      
      this.emit('fieldUpdated', { path, value });
      this.emit('change', data);
      this.scheduleSave();
    },

    // Update a field by path WITHOUT recording history or emitting a change.
    // Use for transient UI-only state (e.g. an accordion's collapsed/expanded
    // flag): it persists on the next debounced save — so the value DOES land in
    // appStorage and exported backups — but must NOT pollute undo history or
    // trigger a re-render (a re-render here would defeat the DOM-class toggle the
    // caller just performed). (#9)
    updateSilent(path, value) {
      if (!data) return;
      setByPath(data, path, value);
      isDirty = true;
      this.scheduleSave();
    },

    // Set metadata for next history entry
    setChangeMetadata(description, changeType = CHANGE_TYPES.EDIT) {
      pendingChangeDescription = description;
      pendingChangeType = changeType;
    },
    
    // Push current state to history (called AFTER changes are made)
    pushHistory(description = null, changeType = null) {
      if (!data) return;
      
      // Remove any future history if we're not at the end (branching)
      if (historyIndex < history.length - 1) {
        history.splice(historyIndex + 1);
      }
      
      // Create history entry with metadata. `origin` says the step was taken on
      // THIS device, which is what keeps another device's undo out of it once
      // this entry syncs — see isOwnStep.
      const entry = {
        data: deepClone(data),
        timestamp: new Date().toISOString(),
        description: description || pendingChangeDescription || 'Edit',
        changeType: changeType || pendingChangeType || CHANGE_TYPES.EDIT,
        origin: deviceOrigin()
      };
      
      // Add the NEW current state
      history.push(entry);
      historyIndex = history.length - 1;
      
      // Reset pending metadata
      pendingChangeDescription = null;
      pendingChangeType = CHANGE_TYPES.EDIT;
      
      // Limit history size
      if (history.length > MAX_HISTORY) {
        history.shift();
        historyIndex--;
      }
      
      // Persist history
      this.saveHistory();
      
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
    },
    
    // Whether `variantId` is the variant on screen AND work on it is still in
    // flight. src/sync/syncModel.js asks before it lands a fetched résumé:
    // adopting one repaints the canvas, and a repaint over work in flight
    // destroys it.
    //
    // Two things count as in flight, and the second cannot be seen from here:
    //
    // - `isDirty` — an edit this store has taken but no save has written yet.
    //   It also stands in for the OTHER half of the same race: the fetch path
    //   compares the remote stamp against the last PERSISTED one (syncModel's
    //   modifiedAtFor), and the save debounce has no max wait, so under
    //   continuous editing that stamp goes arbitrarily stale and a remote copy
    //   older than the live document can outrank it. Dirty says "the recorded
    //   time is not the document's time", which is the honest answer.
    // - `sessionActive`, passed in — an inline-editing session. Text typed into
    //   a contentEditable exists ONLY in the DOM until blur commits it through
    //   `update` (src/inlineEditor.js), so `isDirty` is false while a person is
    //   mid-word. This module has no DOM, so the caller reports it.
    //
    // Refusing rather than deferring is what the caller does with a true here,
    // and nothing is lost by it: the refusal shortens the applied count, the
    // transport forfeits the record's change tag, and the next save — which the
    // in-flight edit is about to trigger — meets the conflict path, where both
    // copies are compared and the loser is parked.
    isBusyEditing(variantId, sessionActive = false) {
      if (!variantId || variantId !== currentVariantId) return false;
      return isDirty || sessionActive === true;
    },

    // Adopt a résumé that arrived from another device as the LOADED variant's
    // document, called by src/sync/syncModel.js when a `resume:` unit lands.
    // Returns false when `variantId` is not the loaded variant, which tells the
    // caller the storage write it has already done is the whole job.
    //
    // It exists for the same reason adoptHistory and adoptHistoryEntry do, one
    // layer over: sync applies a fetched résumé by merging it into
    // `resume-designer-data` ON DISK, but the loaded variant's document also
    // lives HERE, in `data`, and the debounced save writes `data` back over
    // that blob. So an applied résumé survived exactly until the next save,
    // which wrote the stale in-memory document over it, stamped it with a fresh
    // `modifiedAt`, and — this device legitimately holding the server's change
    // tag, because the page had confirmed the apply — pushed it up as a clean,
    // uncontested update. No conflict was raised and nothing was parked. Only
    // the store can tell whether this is the variant on screen: currentVariantId
    // is private to it.
    //
    // `isDirty` goes FALSE and no save is scheduled: what is adopted is exactly
    // what the caller has just written to storage, so there is nothing left to
    // persist, and saving would restamp the unit and send back what this device
    // has only just received. A debounce already in flight cannot resurrect the
    // replaced document either — scheduleSave's timer re-reads isDirty when it
    // fires.
    //
    // The replaced document is not discarded silently. Every edit path records
    // its result in `history` (pushHistory) BEFORE the save debounce runs, so
    // the version this replaces is in that résumé's version history and one
    // restore away — which is where "newer wins" says a loser belongs. The one
    // writer that marks the store dirty without recording history is
    // updateSilent, and what it writes is transient UI state by definition (an
    // accordion's `_expanded`, the sort mode).
    //
    // `history` is otherwise left alone: this is not a step the user took here,
    // and the step the OTHER device took arrives by itself as that variant's
    // history unit (adoptHistory). historyIndex therefore keeps pointing at the
    // entry it pointed at before, and `data` drifts from it — the same drift
    // updateSilent produces, which setData is explicitly written to tolerate
    // (see the comment there).
    //
    // 'change' is the event, because it is the one a whole-document replacement
    // of the SAME variant already emits — undo, redo and restoreToEntry all use
    // it — and every renderer hangs off it: the canvas (main.js), React
    // (useResumeStore.js) and the iOS shell's document snapshot. 'dataLoaded'
    // is the other candidate and it is the wrong one: subscribers read that as a
    // DIFFERENT document backing the render (variant switch, import, restore)
    // and act accordingly — ending a pending inline-change session, re-settling
    // the chat threads for a variant that has not changed.
    adoptDocument(variantId, document) {
      if (!variantId || variantId !== currentVariantId) return false;
      // Absence is never deletion: a unit carrying no document leaves the one
      // on screen where it is rather than blanking the résumé.
      if (!document || typeof document !== 'object') return false;

      data = deepClone(migrateSectionAreas(document));
      isDirty = false;
      this.emit('change', data);
      return true;
    },

    // Insert a history entry this store did not produce — the losing side of a
    // sync conflict, parked by src/sync/syncModel.js so "newer wins" destroys
    // nothing. Returns false when `variantId` is not the loaded variant, which
    // tells the caller to write that variant's history key directly instead.
    //
    // Going through the store is not a nicety: saveHistory() rewrites the whole
    // key from THIS array, so an entry written straight to storage for the
    // loaded variant is erased by the next edit's save.
    //
    // WHERE the entry lands answers to two constraints, and only positions
    // strictly below historyIndex satisfy both:
    //
    // - At or below historyIndex, never after it. Everything after the index is
    //   the redo future, and pushHistory() splices the future away on the next
    //   edit — precisely how a parked entry used to vanish.
    // - Below it, not AT it, so historyIndex — which moves up with the
    //   insertion — still points at the same ENTRY it pointed at before.
    //   Parking changes what history holds, never what the document shows.
    //
    // It is one slot below the current entry rather than at index 0 because
    // pushHistory() evicts from the FRONT when history passes MAX_HISTORY, and
    // a park at the front would be the first thing a full history dropped.
    //
    // With historyIndex 0 there is no slot below the current entry, so the
    // entry goes to 0 and the index to 1 — the arrangement in which a park sits
    // exactly one undo away. Undo keeping away from it is NOT this function's
    // doing and cannot be: see isParked above, where the traversal skips parked
    // entries wherever they ended up.
    adoptHistoryEntry(variantId, entry) {
      if (!variantId || variantId !== currentVariantId || !entry) return false;

      history.splice(Math.max(0, historyIndex - 1), 0, entry);
      historyIndex = Math.max(0, historyIndex + 1);
      this.saveHistory();
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      return true;
    },

    // Union another device's history for this variant into the loaded one,
    // called by src/sync/syncModel.js when a history unit arrives. Returns
    // false when `variantId` is not the loaded variant, which tells the caller
    // to merge into that variant's key directly.
    //
    // It exists for the same reason adoptHistoryEntry does: saveHistory()
    // rewrites the whole key from THIS array, so a merge written straight to
    // storage for the loaded variant is erased by the next edit. The merge
    // itself is mergeHistory's — the local side has to be the in-memory array,
    // not a re-read of the key, because setData() pushes an 'Initial state'
    // entry that no save has reached yet.
    //
    // `data` is untouched — a merge changes what history holds, not what the
    // document shows — so historyIndex has to keep pointing at the entry the
    // document IS on, or the store-wide invariant `history[historyIndex].data
    // === data` breaks and undo hands the user a state they were never in.
    // Taking mergeHistory's own index (the newest entry) broke exactly that:
    // the union interleaves by timestamp, so the newest entry is routinely the
    // other device's — or a loser IT parked.
    //
    // The entry is MOVED to the end rather than pointed at where it sorted,
    // because everything after historyIndex is the redo future and
    // pushHistory() splices the future away on the next edit: a mid-array index
    // would delete the entries this merge just brought in — parked losers
    // included — one keystroke later. At the end, both hold: the index is on
    // the document's own entry AND there is no future to splice.
    adoptHistory(variantId, remote) {
      if (!variantId || variantId !== currentVariantId || !remote) return false;

      const current = history[historyIndex] ?? null;
      const merged = mergeHistory({ history, historyIndex }, remote).history;
      if (current) {
        // By identity, not by reference: the union keeps one object per
        // identity, so an entry both devices hold comes back as the remote's
        // deserialised twin. A current entry the cap dropped is re-appended —
        // whatever else history holds, it has to hold the live document.
        //
        // The current entry's identity is computed ONCE. Inside the callback it
        // canonical-serialised a whole résumé up to MAX_HISTORY times per merge,
        // for a value that cannot change.
        const identity = entryIdentity(current);
        const at = merged.findIndex((e) => entryIdentity(e) === identity);
        if (at >= 0) {
          merged.push(merged.splice(at, 1)[0]);
        } else {
          merged.push(current);
          // mergeHistory returns an array already at the bound, so re-appending
          // puts it one over. The oldest goes — the same end pushHistory's
          // shift() and mergeHistory's slice(-MAX_HISTORY) drop, and the only
          // one that can be dropped safely.
          if (merged.length > MAX_HISTORY) merged.shift();
        }
      }
      history = merged;
      historyIndex = merged.length - 1;
      this.saveHistory();
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      return true;
    },

    // Save history to storage (quota throws survive the browser passthrough,
    // hence the try/catch; cached mode never throws here)
    saveHistory() {
      if (!currentVariantId) return;

      try {
        const historyData = {
          history: history,
          historyIndex: historyIndex
        };
        appStorage.setItem(
          HISTORY_KEY_PREFIX + currentVariantId,
          JSON.stringify(historyData)
        );
      } catch (e) {
        console.warn('Failed to save history:', e);
      }
    },

    // Load history from storage
    loadHistory(variantId) {
      try {
        const saved = appStorage.getItem(HISTORY_KEY_PREFIX + variantId);
        if (saved) {
          const historyData = JSON.parse(saved);
          if (historyData.history && Array.isArray(historyData.history)) {
            history = historyData.history;
            historyIndex = historyData.historyIndex ?? history.length - 1;
            return true;
          }
        }
      } catch (e) {
        console.warn('Failed to load history:', e);
      }
      
      // Reset to empty if load fails
      history = [];
      historyIndex = -1;
      return false;
    },
    
    // Check if undo is available (parked sync conflicts are not undo steps —
    // see isParked)
    canUndo() {
      return undoTarget(historyIndex) >= 0;
    },

    // Check if redo is available
    canRedo() {
      return redoTarget(historyIndex) >= 0;
    },

    // Undo last change
    undo() {
      const target = undoTarget(historyIndex);
      if (target < 0) return false;

      isUndoRedoAction = true;
      historyIndex = target;
      data = deepClone(history[historyIndex].data);
      isDirty = true;
      this.saveHistory(); // Persist after undo
      this.emit('change', data);
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      this.scheduleSave();
      isUndoRedoAction = false;
      
      return true;
    },
    
    // Redo last undone change
    redo() {
      const target = redoTarget(historyIndex);
      if (target < 0) return false;

      isUndoRedoAction = true;
      historyIndex = target;
      data = deepClone(history[historyIndex].data);
      isDirty = true;
      this.saveHistory(); // Persist after redo
      this.emit('change', data);
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      this.scheduleSave();
      isUndoRedoAction = false;
      
      return true;
    },
    
    // Get all history entries (for history panel)
    getHistoryEntries() {
      return history.map((entry, index) => ({
        index,
        timestamp: entry.timestamp,
        description: entry.description,
        changeType: entry.changeType,
        isCurrent: index === historyIndex
      }));
    },
    
    // Get specific history entry data
    getHistoryEntryData(index) {
      if (index >= 0 && index < history.length) {
        return deepClone(history[index].data);
      }
      return null;
    },
    
    // Restore to a specific history entry
    restoreToEntry(index) {
      if (index < 0 || index >= history.length) return false;
      
      isUndoRedoAction = true;
      historyIndex = index;
      data = deepClone(history[historyIndex].data);
      isDirty = true;
      this.saveHistory();
      this.emit('change', data);
      this.emit('historyChanged', { canUndo: this.canUndo(), canRedo: this.canRedo() });
      this.scheduleSave();
      isUndoRedoAction = false;
      
      return true;
    },
    
    // Get current history index
    getHistoryIndex() {
      return historyIndex;
    },
    
    // Get history length
    getHistoryLength() {
      return history.length;
    },
    
    // Clear history (e.g., when loading new data)
    clearHistory() {
      history.length = 0;
      historyIndex = -1;
      this.emit('historyChanged', { canUndo: false, canRedo: false });
    },

    // Get a specific field by path
    get(path) {
      if (!data) return undefined;
      return getByPath(data, path);
    },

    // Add item to an array field
    addToArray(path, item) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr)) {
        arr.push(item);
        isDirty = true;
        if (!isUndoRedoAction) this.pushHistory();
        this.emit('arrayItemAdded', { path, item });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Insert an item at a specific index. addToArray only appends, so applying
    // a proposed insertion (`[A,B]` -> `[A,X,B]`) had to go through the generic
    // path-write, which ASSIGNS `arr[1] = X` and destroys B. Index is clamped
    // rather than rejected: a change set numbers its additions against the
    // proposed array, so an index can legitimately sit one past the current end.
    insertIntoArray(path, index, item) {
      if (!data) return;

      const arr = getByPath(data, path);
      if (!Array.isArray(arr)) return;
      const at = Math.max(0, Math.min(index, arr.length));
      arr.splice(at, 0, item);
      isDirty = true;
      if (!isUndoRedoAction) this.pushHistory();
      this.emit('arrayItemAdded', { path, item, index: at });
      this.emit('change', data);
      this.scheduleSave();
    },

    // Remove item from array by index
    removeFromArray(path, index) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr) && index >= 0 && index < arr.length) {
        const removed = arr.splice(index, 1)[0];
        isDirty = true;
        if (!isUndoRedoAction) this.pushHistory();
        this.emit('arrayItemRemoved', { path, index, item: removed });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Move item within array
    moveInArray(path, fromIndex, toIndex) {
      if (!data) return;
      
      const arr = getByPath(data, path);
      if (Array.isArray(arr) && fromIndex >= 0 && fromIndex < arr.length) {
        const [item] = arr.splice(fromIndex, 1);
        arr.splice(toIndex, 0, item);
        isDirty = true;
        if (!isUndoRedoAction) this.pushHistory();
        this.emit('arrayItemMoved', { path, fromIndex, toIndex });
        this.emit('change', data);
        this.scheduleSave();
      }
    },

    // Check if there are unsaved changes
    isDirty() {
      return isDirty;
    },

    // Mark as saved
    markSaved() {
      isDirty = false;
      this.emit('saved');
    },

    // Subscribe to events
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },

    // Emit event to all listeners
    emit(event, payload) {
      listeners.forEach(callback => {
        try {
          callback(event, payload);
        } catch (e) {
          console.error('Store listener error:', e);
        }
      });
    },

    // Set save callback (called by persistence layer)
    onSave(callback) {
      saveCallback = callback;
    },

    // Latch saving off ahead of a destructive import (see savesSuspended).
    // Called BEFORE the import runs, so the store can't write its stale resume
    // over the imported data during the import's own async flush. Cancels any
    // pending debounce so it can't fire either.
    //
    // Returns TRUE only when this call actually acquired the latch (flipped it
    // off→on). A caller may only resumeSaves() if it acquired here — otherwise
    // it would release a suspension a prior import still relies on (e.g. a
    // Replace whose success-modal flush failed keeps saves suspended, and a
    // later retry that re-latches then rolls back must NOT resume it).
    suspendSaves() {
      const acquired = !savesSuspended;
      savesSuspended = true;
      if (saveTimeout) {
        clearTimeout(saveTimeout);
        saveTimeout = null;
      }
      return acquired;
    },

    // Re-enable saving after an import FAILED and rolled back: the store still
    // matches the (rolled-back) appStorage, and the app keeps running without a
    // reload, so it must be able to save again. On a SUCCESSFUL import this is
    // never called — the window reloads with saves still suspended.
    resumeSaves() {
      savesSuspended = false;
    },

    // True while a destructive import is mid-flight (saves suspended, awaiting
    // the success-modal reload or a failure resume). The single source of truth
    // for "no persistence may happen right now" — the companion-extension bridge
    // reads this to reject writes that would otherwise serialize stale caches
    // over the just-restored keys (its writers bypass the store entirely).
    areSavesSuspended() {
      return savesSuspended;
    },

    // Schedule a debounced save
    scheduleSave() {
      if (savesSuspended) return;
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      saveTimeout = setTimeout(() => {
        if (saveCallback && isDirty) {
          saveCallback(data);
          this.markSaved();
        }
      }, SAVE_DEBOUNCE_MS);
    },

    // Force immediate save. Returns whether the persist succeeded so callers
    // that must not proceed on an unsaved edit (the profile switch reloads the
    // window) can abort. On failure the dirty flag is kept (not markSaved) so a
    // later save retries.
    saveNow() {
      if (saveTimeout) {
        clearTimeout(saveTimeout);
      }
      // Suspended after a restore: the in-memory data is stale, so writing it
      // would clobber the just-restored workspace. Report success so shutdown
      // callers (close/visibilitychange) don't treat the no-op as a failure.
      if (savesSuspended) return true;
      if (saveCallback && data) {
        const ok = saveCallback(data) !== false;
        if (ok) this.markSaved();
        return ok;
      }
      return true;
    }
  };
}

// Export singleton instance
export const store = createStore();

// Default empty resume template
export const EMPTY_RESUME = {
  name: 'Your Name',
  tagline: 'Your Professional Title',
  contact: {
    location: 'City, State',
    email: 'email@example.com',
    phone: '000-000-0000',
    portfolio: '',
    instagram: ''
  },
  summary: 'A brief professional summary describing your experience and goals.',
  sections: [
    {
      id: generateId('section'),
      title: 'Skills',
      type: 'list',
      area: 'sidebar',
      content: ['Skill 1', 'Skill 2', 'Skill 3']
    }
  ],
  experience: [
    {
      id: generateId('exp'),
      title: 'Job Title',
      company: 'Company Name',
      dates: 'Start Date – End Date',
      bullets: [
        'Accomplishment or responsibility',
        'Another key achievement'
      ]
    }
  ],
  education: ['Degree — School Name — Dates'],
  tools: 'Tool 1 • Tool 2 • Tool 3'
};
