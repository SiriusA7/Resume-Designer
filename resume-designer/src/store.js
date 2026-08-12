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
import { BACKUP_HISTORY_PREFIX } from './profileKeys.js';
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

  // A parked sync conflict is another device's REJECTED résumé — the losing
  // side of "newer wins", archived by src/sync/syncModel.js so nothing is
  // destroyed. It is not a step this user took, and the undo timeline is a
  // record of steps this user took, so the whole traversal below steps over it:
  // no Cmd+Z, and no Cmd+Shift+Z, ever lands on one.
  //
  // It stays exactly where it is in the array — getHistoryEntries still lists
  // it and restoreToEntry still restores it, which is the entire point of
  // parking. Only the traversal skips it.
  //
  // Doing it here rather than at each place a park can be inserted is what
  // makes the rule hold everywhere at once: at historyIndex 0 there is no slot
  // below the current entry for adoptHistoryEntry to use, a variant this device
  // has never opened can load with a park as its only entry, and a history
  // merge can leave one at the end. Each of those put a rejected version one
  // Cmd+Z away, and all three are the same mistake.
  const isParked = (entry) => entry?.changeType === CHANGE_TYPES.SYNC_CONFLICT;
  // The index undo/redo would move to from `from`, or -1 when there is none.
  const undoTarget = (from) => {
    let i = from - 1;
    while (i >= 0 && isParked(history[i])) i -= 1;
    return i;
  };
  const redoTarget = (from) => {
    let i = from + 1;
    while (i < history.length && isParked(history[i])) i += 1;
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
      // Or if the entry the loaded history calls current is a parked sync
      // conflict, which the document is by definition NOT on: a variant this
      // device has never opened has no history for parkLoser to insert into, so
      // syncModel.js's storage path writes `{ history: [loser], historyIndex: 0
      // }`, and loadHistory takes its success path on that — no 'Initial state'
      // was pushed and the rejected version was marked current, permanently.
      // Recording the state actually on screen restores the invariant every
      // other method here assumes: history[historyIndex] is the entry the
      // document is on.
      if (history.length === 0 || isParked(history[historyIndex])) {
        history.push({
          data: deepClone(data),
          timestamp: new Date().toISOString(),
          description: 'Initial state',
          changeType: CHANGE_TYPES.INITIAL
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
      
      // Create history entry with metadata
      const entry = {
        data: deepClone(data),
        timestamp: new Date().toISOString(),
        description: description || pendingChangeDescription || 'Edit',
        changeType: changeType || pendingChangeType || CHANGE_TYPES.EDIT
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
        const at = merged.findIndex((e) => entryIdentity(e) === entryIdentity(current));
        if (at >= 0) merged.push(merged.splice(at, 1)[0]);
        else merged.push(current);
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
