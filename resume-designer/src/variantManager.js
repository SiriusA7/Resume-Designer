/**
 * Variant Manager
 *
 * Framework-agnostic CRUD + selection state for resume variants. This module
 * owns `currentVariantId` and the `onVariantChange` callback that main.js wires
 * (it re-renders the resume + re-syncs the job panel). The React header consumes
 * this through the `useVariants()` hook (subscribe/getSnapshot below); nothing
 * here touches the DOM, so the same logic serves both the React chrome and the
 * non-React callers (onboarding, jobDescriptionPanel).
 *
 * Previously this logic lived inside headerBar.js (which also rendered the
 * header markup imperatively). Step 6 of the React migration extracted it here
 * so the header could become a real component without duplicating variant state.
 */

import { store, generateId, EMPTY_RESUME } from './store.js';
import { storageErrorToast } from './storageToast.js';
import { assignGroupIds, groupExperience } from './experienceGroups.js';
import {
  getVariants,
  getCurrentVariantId,
  setCurrentVariantId,
  saveVariant,
  deleteVariant,
  renameVariant,
  initPersistence,
  importFile,
  exportAsJSON,
  exportAsMarkdown,
  generateUniqueVariantName,
} from './persistence.js';

let currentVariantId = null;
let onVariantChangeCallback = null;

// --- React external-store bridge ---------------------------------------------
// useSyncExternalStore needs a STABLE snapshot reference between renders, so we
// cache `snapshot` and only recompute it inside notify() (on a real change).
// Returning getVariants() directly would deep-read storage every render and the
// fresh object identity would loop the store (the same trap useResumeStore hit).
//
// The initial snapshot is LAZY (computed on first access, not at import time):
// module evaluation happens before init() runs initAppStorage(), so an
// import-time computeSnapshot() would read the pre-adoption passthrough — on
// Tauri that's an empty localStorage, i.e. a wrong (empty) first paint. Note
// App.jsx fires init() from its mount effect without gating render on it, so
// the first Header render can still beat initAppStorage(); initVariants() →
// notify() recomputes once boot completes, exactly as it always has.
const subscribers = new Set();
let snapshot = null;

function computeSnapshot() {
  return { currentId: currentVariantId, list: getVariantList() };
}

function notify() {
  snapshot = computeSnapshot();
  subscribers.forEach((cb) => cb());
}

export function subscribeVariants(callback) {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

export function getVariantsSnapshot() {
  if (!snapshot) snapshot = computeSnapshot();
  return snapshot;
}

/**
 * Recompute + publish the variants snapshot after persistence-level edits made
 * outside this module (the Library dialog renames/deletes non-current variants
 * straight through persistence.js, which can't notify subscribers itself).
 */
export function refreshVariants() {
  notify();
}

/**
 * Variants sorted most-recently-modified first (matching the old header order).
 */
export function getVariantList() {
  const variants = getVariants();
  return Object.values(variants).sort((a, b) => {
    const dateA = a.updatedAt || a.createdAt || '';
    const dateB = b.updatedAt || b.createdAt || '';
    return dateB.localeCompare(dateA);
  });
}

// --- Initialization ----------------------------------------------------------

/**
 * Wire the variant-change callback, then load the persisted current variant.
 * Returns the active variant id (or null on a fresh install).
 */
export function initVariants(onVariantChange) {
  onVariantChangeCallback = onVariantChange;
  currentVariantId = getCurrentVariantId();

  if (currentVariantId) {
    if (!loadVariant(currentVariantId)) {
      // Dangling pointer: the persisted current id references a variant that
      // no longer exists, so loadVariant bailed before its notify(). Publish
      // the real list anyway so the header recovers instead of keeping the
      // stale pre-init (empty) snapshot.
      notify();
    }
  } else {
    // No persisted selection yet; still publish an initial snapshot so any
    // already-mounted subscriber renders the (possibly empty) list.
    notify();
  }

  return currentVariantId;
}

export function getCurrentId() {
  return currentVariantId;
}

// --- CRUD --------------------------------------------------------------------

/**
 * Load a variant into the store. `store.setData(.., skipSave=true, id)` avoids a
 * redundant save and tags the history with the variant id. The onVariantChange
 * callback (main.js) re-renders the resume + re-syncs the job panel; the store's
 * own `dataLoaded` event also re-renders, so a fresh variant paints either way.
 */
export function loadVariant(id) {
  const variants = getVariants();
  const variant = variants[id];
  if (!variant) return false;

  currentVariantId = id;
  setCurrentVariantId(id);
  store.setData(variant.data, true, id);
  initPersistence(id);

  if (onVariantChangeCallback) {
    onVariantChangeCallback(variant);
  }

  notify();
  return true;
}

export function createVariant(name, data = null) {
  const id = generateId('variant');
  const variantData = data || JSON.parse(JSON.stringify(EMPTY_RESUME));

  // saveVariant reports whether the write landed (false on the browser
  // passthrough's storage quota) and loadVariant returns false when the
  // variant isn't readable back. Without this guard the header's
  // "+ / Duplicate / Import" actions silently did nothing at quota — same
  // bug class as the onboarding wizard's fake success screen.
  if (!saveVariant(id, name, variantData) || !loadVariant(id)) {
    storageErrorToast(
      "Could not save the new resume: the app's local storage is full. "
      + 'Delete resumes you no longer need and try again — you can export a '
      + 'backup first via Settings → Data → Export Backup.',
    );
    return null;
  }

  return id;
}

export function duplicateVariant() {
  const variants = getVariants();
  const current = variants[currentVariantId];
  if (!current) return null;

  const baseName = `${current.name} (Copy)`;
  const newName = generateUniqueVariantName(baseName, variants);
  const newData = JSON.parse(JSON.stringify(current.data));
  return createVariant(newName, newData);
}

/**
 * Delete the active variant, unconditionally — confirmation now lives in the
 * caller (the React header owns a shadcn AlertDialog; spec §2.3-11). Last-variant
 * protection is preserved here as a guard so no surface can ever delete the only
 * variant: callers should disable their delete control in that case, but this is
 * the backstop.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'last-variant' }}
 */
export function deleteCurrentVariant() {
  const variants = getVariants();
  if (Object.keys(variants).length <= 1) {
    return { ok: false, reason: 'last-variant' };
  }

  const newCurrentId = deleteVariant(currentVariantId);
  if (newCurrentId) {
    loadVariant(newCurrentId); // notifies
  } else {
    notify();
  }
  return { ok: true };
}

/**
 * Rename the active variant. The name now arrives from the caller (the React
 * header collects it via a shadcn Dialog), replacing the old prompt() modal.
 */
export function renameCurrentVariant(newName) {
  const variants = getVariants();
  const current = variants[currentVariantId];
  if (!current) return false;

  const trimmed = (newName || '').trim();
  if (!trimmed) return false;

  renameVariant(currentVariantId, trimmed);
  notify();
  return true;
}

/**
 * @param {File} file
 * @param {{ confirmGrouping?: (runCount: number) => Promise<boolean> }} [options]
 *   `confirmGrouping` is injected by the UI so this module stays free of React.
 *   Omitted, nothing is ever grouped — the conservative default.
 */
export async function importVariant(file, { confirmGrouping = null } = {}) {
  try {
    // Import WITHOUT grouping (parseResume's default), then work out whether
    // grouping would change anything. No adjacent same-company entries means
    // nothing to decide and no dialog: the question only appears when the
    // answer matters.
    const data = await importFile(file);
    const entries = Array.isArray(data?.experience) ? data.experience : [];
    const grouped = assignGroupIds(entries);
    // Count only the runs grouping would NEWLY form. A re-imported JSON résumé
    // carries its own _groupId values, so counting every run in the grouped
    // output would raise a dialog whose answers are indistinguishable — and
    // "keep separate" would not separate anything.
    const runCount = groupExperience(grouped)
      .filter((g) => g.roles.length > 1 && g.roles.some((r) => !entries[r.index]?._groupId)).length;
    if (runCount > 0 && confirmGrouping && await confirmGrouping(runCount)) {
      data.experience = grouped;
    }
    const name = file.name.replace(/\.(json|md|markdown)$/i, '');
    // createVariant returns null when the variant couldn't be persisted
    // (it already surfaced the storage error to the user).
    return createVariant(name, data) !== null;
  } catch (err) {
    alert('Import failed: ' + err.message);
    return false;
  }
}

export function exportCurrentVariant(format = 'json') {
  const variants = getVariants();
  const current = variants[currentVariantId];
  if (!current) return;

  const filename = `${current.name.replace(/[^a-z0-9]/gi, '-')}`;
  if (format === 'json') {
    exportAsJSON(current.data, `${filename}.json`);
  } else {
    exportAsMarkdown(current.data, `${filename}.md`);
  }
}
