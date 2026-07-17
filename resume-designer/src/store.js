/**
 * Resume Store - Reactive state management for resume data
 * Handles state updates, change events, and coordinates with persistence
 */

import { appStorage } from './appStorage.js';

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

// Set nested value by path
function setByPath(obj, path, value) {
  const keys = path.split('.');
  const lastKey = keys.pop();
  
  let current = obj;
  for (const key of keys) {
    // Handle array index notation
    const match = key.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      current = current[match[1]][parseInt(match[2])];
    } else {
      if (current[key] === undefined) {
        current[key] = {};
      }
      current = current[key];
    }
  }
  
  // Handle array index in last key
  const lastMatch = lastKey.match(/^(\w+)\[(\d+)\]$/);
  if (lastMatch) {
    current[lastMatch[1]][parseInt(lastMatch[2])] = value;
  } else {
    current[lastKey] = value;
  }
}

// History persistence key prefix
const HISTORY_KEY_PREFIX = 'resume-designer-history-';

// Change type constants
export const CHANGE_TYPES = {
  INITIAL: 'initial',
  EDIT: 'edit',
  AI: 'ai',
  IMPORT: 'import',
  REORDER: 'reorder',
  ADD: 'add',
  REMOVE: 'remove'
};

// Create the store
function createStore() {
  let data = null;
  let isDirty = false;
  const listeners = new Set();
  let saveCallback = null;
  let saveTimeout = null;
  // Latched off before a destructive restore reloads the window. Between the
  // restore writing appStorage and the reload booting from it, the in-memory
  // `data` is the STALE pre-import résumé; a save in that window (the
  // visibilitychange/close handlers call saveNow) would write it back into the
  // freshly-restored profile — corrupting the backup. Once suspended it stays
  // suspended: the only path forward from a restore is the reload.
  let savesSuspended = false;
  const SAVE_DEBOUNCE_MS = 500;
  
  // Undo/redo history with metadata
  // Each entry: { data, timestamp, description, changeType, path? }
  let history = [];
  let historyIndex = -1;
  const MAX_HISTORY = 100; // Increased for version history
  let isUndoRedoAction = false;
  let currentVariantId = null;
  let pendingChangeDescription = null;
  let pendingChangeType = CHANGE_TYPES.EDIT;

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
      data = deepClone(newData);
      isDirty = false;
      
      // Track current variant for history persistence
      if (variantId) {
        currentVariantId = variantId;
        // Try to load existing history for this variant
        this.loadHistory(variantId);
      }
      
      // If no history was loaded, initialize with current state
      if (history.length === 0) {
        history.push({
          data: deepClone(data),
          timestamp: new Date().toISOString(),
          description: 'Initial state',
          changeType: CHANGE_TYPES.INITIAL
        });
        historyIndex = 0;
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
    
    // Check if undo is available
    canUndo() {
      return historyIndex > 0;
    },
    
    // Check if redo is available
    canRedo() {
      return historyIndex < history.length - 1;
    },
    
    // Undo last change
    undo() {
      if (!this.canUndo()) return false;
      
      isUndoRedoAction = true;
      historyIndex--;
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
      if (!this.canRedo()) return false;
      
      isUndoRedoAction = true;
      historyIndex++;
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
    // Called BEFORE the import runs, so the store can't write its stale résumé
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
