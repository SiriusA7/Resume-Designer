/**
 * Persistence Layer
 * Handles appStorage auto-save and JSON/Markdown export/import
 */

import { store, generateId } from './store.js';
import { parseResume } from './parser.js';
import { isTauri, isIOSPlatform, stageTextForShare, notify } from './native.js';
// The share sheet, for the exports iOS cannot download. `iosShell` does not
// import this module, so the edge only goes one way.
import { sharePdf, isNativeShellAvailable } from './iosShell.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';
// The API key lives in the OS keychain, not beside the resume data on disk.
import {
  getSecret, setSecret, isSecretStoreReady, setCredentialChangeNotifier,
} from './secretStore.js';

const STORAGE_KEY = 'resume-designer-data';
export const SETTINGS_UPDATED_EVENT = 'resume-designer-settings-updated';
let persistedSaveHandler = null;

/** Wired by syncModel.js through main.js to keep the module graph acyclic. */
export function setPersistedSaveHandler(handler) {
  persistedSaveHandler = typeof handler === 'function' ? handler : null;
}

// Stamps and announces the units a RESTORE produced. Injected for the same
// reason the save handler is: this module must not import the sync layer.
// Without it the tombstones a replacement restore writes never travel — the
// blob goes in under a PHYSICAL key, which the interceptor classifies
// 'unknown', so nothing is stamped and nothing is queued.
let restoreStampHandler = null;
let restoreAnnounceHandler = null;
export function setRestoreStampHandler(handler, announceHandler) {
  restoreStampHandler = typeof handler === 'function' ? handler : null;
  restoreAnnounceHandler = typeof announceHandler === 'function' ? announceHandler : null;
}

/**
 * Stamp everything the restore wrote, with the restore's own writes.
 *
 * Rides its flush deliberately — `importFullBackupDurably` arms a guard the
 * moment this function's caller returns, and that guard DEFERS every other
 * writer while the reload the restore ends with discards what was deferred.
 * Returns the unit ids per workspace so the durable caller can announce exactly
 * what was stamped, rather than recomputing it against a store that has since
 * moved.
 *
 * THROWS RATHER THAN LOGGING, unlike the announcement below, and the asymmetry
 * is the point. `appStorage` swallows its own observer's failures because the
 * bytes are already stored by then and a bookkeeping error surfacing at some
 * unrelated call site reads as a lost edit. Here the stamp is not incidental:
 * it is what makes the restored content outrank what the server still holds. A
 * suppressed failure — a QuotaExceededError in passthrough mode is the
 * plausible one, since that mode's `setItem` throws synchronously — leaves a
 * restore reported as successful, persisted, and unstamped, so the next fetch
 * reads it as -Infinity and overwrites it with the records it just replaced.
 * Letting it reach the caller's `try` runs the rollback, which is the outcome
 * a person can see and retry.
 */
function stampRestoredWrites(restoredWrites, noteKeyWritten) {
  const stamped = new Map();
  if (!restoreStampHandler || !restoredWrites?.size) return stamped;
  for (const [profileId, writes] of restoredWrites) {
    if (!writes?.length) continue;
    const ids = restoreStampHandler(profileId, writes, noteKeyWritten);
    if (ids?.length) stamped.set(profileId, ids);
  }
  return stamped;
}

/**
 * Announce the tombstones a restore produced, once that restore is DURABLE.
 *
 * Never during the restore. In cached mode nothing in the import throws —
 * failures surface at the flush — so announcing there uploads deletions for a
 * restore that may still be rolled back, and a rollback cannot recall them.
 * Keyed by workspace, because the same résumé id lives in more than one.
 *
 * LOGS rather than throwing, unlike the stamping above. By this point the
 * restore is on disk and correct; there is nothing to roll back to, and failing
 * it here would report a restore that actually succeeded as a failure. The
 * stamp is durable, so a lost announcement costs immediacy and not the content
 * — the unit still outranks the server whenever it is next collected.
 */
export function commitRestoredUnits(restoredUnits) {
  if (!restoreAnnounceHandler || !restoredUnits?.size) return;
  for (const [profileId, ids] of restoredUnits) {
    if (!ids?.length) continue;
    try {
      restoreAnnounceHandler(profileId, ids);
    } catch (e) {
      console.error('[backup] could not announce restored units:', e);
    }
  }
}

// `setSyncDirtyNotifier` stood here, and this module no longer names a dirty
// unit at all: the handler above queues them for the storage drain, which is
// the only place that knows the bytes reached disk. The notifier now has ONE
// installer (syncModel's `setStorageDirtyNotifier`) rather than two, and there
// is no longer a route that can announce a unit earlier than the drain.

// Storage structure
const DEFAULT_STORAGE = {
  variants: {},
  currentVariantId: null,
  settings: {
    colorPalette: 'terracotta',
    layout: 'sidebar',
    pageSize: 'continuous',
    orientation: 'portrait',
    pageWidthIn: 8.5,
    customColor: '#c45c3e',
    autoFallback: false,
    defaultModel: 'anthropic/claude-sonnet-4.6',
    customModels: [],
    chatPanelWidth: 320,
    chatReasoningEffort: 'medium',
    chatWebSearch: false,
    analysisModel: '',
    analysisReasoning: 'medium',
    tailorModel: '',
    tailorReasoning: 'medium',
    onboardingModel: '',
    onboardingReasoning: 'medium'
  },
  userProfile: {
    // Contact information
    contactInfo: {
      fullName: '',
      email: '',
      phone: '',
      location: '',
      linkedin: '',
      portfolio: '',
      github: '',
      twitter: '',
      instagram: ''
    },
    personalSummary: '',
    careerGoals: '',
    workExperience: [],
    skills: [],
    education: [],
    projects: [],
    certifications: [],
    achievements: [],
    industryKnowledge: '',
    preferences: '',
    customSections: []
  }
};

// Load all data from storage
export function loadFromStorage() {
  try {
    const raw = appStorage.getItem(STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load from storage:', e);
  }
  // Deep clone — a shallow spread would hand callers references to
  // DEFAULT_STORAGE's nested objects (variants/settings/userProfile), and a
  // caller mutating its "loaded" copy (saveVariant does) would silently edit
  // the module constant for the rest of the session.
  return structuredClone(DEFAULT_STORAGE);
}

// Save all data to storage. The try/catch matters in the browser passthrough,
// where appStorage.setItem is a direct localStorage write that can still throw
// QuotaExceededError; in cached (Tauri) mode setItem never throws — disk
// failures surface asynchronously via the facade's own toast.
export function saveToStorage(data) {
  try {
    appStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch (e) {
    console.error('Failed to save to storage:', e);
    return false;
  }
}

/**
 * A deleted résumé, kept as a record rather than removed.
 *
 * Absence cannot travel. A unit that is simply gone from the blob emits nothing,
 * and the transport treats a missing unit as "nothing to say" rather than
 * "delete this" — deliberately, because that is the only reading under which a
 * device that has not finished syncing cannot wipe another device's work. So a
 * delete that removed the entry never reached anywhere: the résumé stayed on
 * every other device, and a fresh device or a forced refetch handed it back to
 * the one that deleted it.
 *
 * A tombstone is the same `resume:<id>` unit carrying `deletedAt`. It travels,
 * merges and resolves like any other record — newest wins, so a delete beats an
 * older edit and loses to a newer one — and it is never pruned, because a
 * pruned tombstone is a résumé that comes back. Same shape the profile registry
 * already uses (see `mergeRegistry`).
 */
export const isDeletedVariant = (variant) => Boolean(variant && variant.deletedAt);

/** Only the résumés that still exist. Tombstones are storage, not content. */
function liveVariants(storage) {
  const out = {};
  for (const [id, variant] of Object.entries(storage.variants || {})) {
    if (!isDeletedVariant(variant)) out[id] = variant;
  }
  return out;
}

// Get all variants
export function getVariants() {
  return liveVariants(loadFromStorage());
}

/** The raw map, tombstones included — for the paths that must see them. */
export function getVariantsIncludingDeleted() {
  return loadFromStorage().variants || {};
}

// Get current variant ID
export function getCurrentVariantId() {
  const storage = loadFromStorage();
  return storage.currentVariantId;
}

// Set current variant ID
export function setCurrentVariantId(id) {
  const storage = loadFromStorage();
  storage.currentVariantId = id;
  saveToStorage(storage);
}

// Save a variant
export function saveVariant(id, name, data) {
  const storage = loadFromStorage();
  const existingVariant = isDeletedVariant(storage.variants[id]) ? null : storage.variants[id];
  const now = new Date().toISOString();
  
  storage.variants[id] = {
    id,
    name,
    data,
    createdAt: existingVariant?.createdAt || now, // Preserve original creation time
    updatedAt: now,
    // Preserve job analysis data if it exists
    jobAnalysis: existingVariant?.jobAnalysis || null,
    analysisUpdatedAt: existingVariant?.analysisUpdatedAt || null
  };
  // Report whether the write actually landed. saveToStorage swallows
  // QuotaExceededError (full localStorage), so without this signal a caller
  // can't tell a saved variant from one that silently vanished.
  return saveToStorage(storage);
}

// Generate a unique variant name based on the person's name
export function generateUniqueVariantName(baseName, variants = null) {
  if (!variants) {
    variants = getVariants();
  }
  
  const variantList = Object.values(variants);
  const baseNameLower = baseName.toLowerCase().trim();
  
  // Find all variants with names starting with the base name
  const matchingNames = variantList
    .map(v => v.name.toLowerCase())
    .filter(name => name === baseNameLower || name.startsWith(baseNameLower + ' ('));
  
  if (matchingNames.length === 0) {
    return baseName;
  }
  
  // Find the next available number
  let maxNum = 1;
  const numPattern = /\((\d+)\)$/;
  
  for (const name of matchingNames) {
    const match = name.match(numPattern);
    if (match) {
      maxNum = Math.max(maxNum, parseInt(match[1], 10));
    }
  }
  
  // If base name exists without a number, start at 2
  if (matchingNames.includes(baseNameLower)) {
    return `${baseName} (${maxNum + 1})`;
  }
  
  return `${baseName} (${maxNum + 1})`;
}

// Delete a variant
export function deleteVariant(id) {
  const storage = loadFromStorage();
  if (!storage.variants[id]) return storage.currentVariantId;
  // REPLACED by a tombstone, not removed — see `isDeletedVariant`. The name is
  // kept so a conflict notice or a log line can say WHICH résumé went; nothing
  // renders it, because every reader goes through `getVariants`.
  const now = new Date().toISOString();
  storage.variants[id] = {
    id,
    name: storage.variants[id].name,
    deletedAt: now,
    updatedAt: now,
  };

  // If deleted variant was current, switch to another LIVE one.
  if (storage.currentVariantId === id) {
    const variantIds = Object.keys(liveVariants(storage));
    storage.currentVariantId = variantIds.length > 0 ? variantIds[0] : null;
  }

  saveToStorage(storage);
  return storage.currentVariantId;
}

// Rename a variant
export function renameVariant(id, newName) {
  const storage = loadFromStorage();
  if (storage.variants[id] && !isDeletedVariant(storage.variants[id])) {
    storage.variants[id].name = newName;
    storage.variants[id].updatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Save job analysis results for a specific variant
export function saveVariantAnalysis(variantId, analysis) {
  const storage = loadFromStorage();
  if (storage.variants[variantId] && !isDeletedVariant(storage.variants[variantId])) {
    storage.variants[variantId].jobAnalysis = analysis;
    storage.variants[variantId].analysisUpdatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Get job analysis results for a specific variant
export function getVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  const variant = storage.variants[variantId];
  if (isDeletedVariant(variant)) return null;
  return variant?.jobAnalysis || null;
}

// Clear job analysis results for a specific variant
export function clearVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  if (storage.variants[variantId] && !isDeletedVariant(storage.variants[variantId])) {
    storage.variants[variantId].jobAnalysis = null;
    storage.variants[variantId].analysisUpdatedAt = null;
    saveToStorage(storage);
  }
}

// Save settings. The credential does NOT come through here — it lives in the
// OS keychain and its write is async, so it has its own entry point
// (saveApiKey). Everything else merges into the per-profile blob.
//
// Throwing rather than silently delegating: this function is synchronous, so a
// delegated keychain write could only be fire-and-forget, and a failed one
// would leave the user believing a key was saved that never reached the
// keychain. A loud error at the call site is the correct signal.
export function saveSettings(settings) {
  const { openrouterKey, ...rest } = settings;
  if (openrouterKey !== undefined) {
    throw new Error('saveSettings cannot write openrouterKey — use saveApiKey()');
  }
  const storage = loadFromStorage();
  storage.settings = { ...storage.settings, ...rest };
  // The blob never GAINS a credential here (`rest` excludes openrouterKey) —
  // but an existing blob value is the pre-extraction fallback and must NOT be
  // stripped by this path: in cached mode the shared-key and blob files flush
  // independently, so the shared write can fail while this blob rewrite
  // lands, leaving no durable credential after restart. The flush-gated boot
  // extraction (extractSharedApiKey) owns the strip; until it succeeds the
  // stale blob value stays masked by the shared-key overlay in getSettings.
  saveToStorage(storage);

  notifySettingsUpdated();
}

/**
 * Tell the UI that settings — including the credential — may have changed.
 *
 * Every listener re-reads through getSettings() rather than trusting `detail`,
 * so the payload is informational and a notification is never wrong, only
 * sometimes redundant. That is what makes it safe to fire from the failure
 * paths in saveApiKey and from a remote credential adoption.
 */
function notifySettingsUpdated() {
  if (typeof window === 'undefined') return;
  const storage = loadFromStorage();
  window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, {
    detail: { settings: { ...storage.settings, openrouterKey: getSettings().openrouterKey } }
  }));
}

// A remote credential adoption has no local caller to announce it, so
// secretStore calls back here. Wired at import time; persistence.js is imported
// by every entry point that has a UI.
setCredentialChangeNotifier(notifySettingsUpdated);

/**
 * Persist the API key. Async because it goes to the OS keychain rather than
 * to disk beside the resume data.
 *
 * Rejects if the keychain refuses the write, so the caller can tell the user
 * their key was NOT saved. Callers must await this — a dropped promise here is
 * a silently lost credential.
 */
export async function saveApiKey(value) {
  // `finally`, not "after the await". setSecret() has three paths that change
  // the effective credential and THEN throw: the memory-only fallback (caches
  // the value, reports it was not saved), the write-conflict path (adopts the
  // winner's value, then reports the conflict), and a plaintext-cleanup failure
  // after the ciphertext write has landed. Dispatching only on success left
  // getSettings() returning a new key while the UI kept the old enabled state
  // until reload. Listeners re-read state rather than trusting the payload, so
  // firing on a total failure too is harmless — it just recomputes to what is
  // already on screen.
  try {
    await setSecret(value);
  } finally {
    notifySettingsUpdated();
  }
}

// Get settings. The machine-level key is authoritative when PRESENT
// (null-check, not truthiness: an existing empty value means the user cleared
// the key and must mask any stale blob value); the blob is only a fallback
// for pre-extraction installs (adoption strips it on the next boot).
//
// The credential comes from secretStore's synchronous in-memory copy, hydrated
// at boot from the OS keychain or the encrypted browser store.
//
// The blob fallback is gated on the store not having ANSWERED yet, not merely
// on it answering null. Those were the same observation while null could only
// mean "nothing stored" — but this PR gave the store states where null is a
// DELIBERATE refusal: `browser-unreadable` returns null precisely so a
// credential it cannot verify stops being used. Falling back there handed the
// stale blob key straight to aiService and undid the safeguard, keeping a
// superseded or revoked credential in service. An older comment here still
// claimed the browser build has no keychain and always falls back; that stopped
// being true when the browser gained an encrypted store.
export function getSettings() {
  const storage = loadFromStorage();
  const s = storage.settings || DEFAULT_STORAGE.settings;
  const shared = getSecret();
  // Boot, and the print window (which never initialises the store) — the blob
  // is genuinely the only source there, and it is a migration source.
  const beforeStoreAnswered = !isSecretStoreReady();
  // Legacy OpenRouter-era guarantees preserved (see original comment).
  return {
    autoFallback: false,
    customModels: [],
    ...s,
    openrouterKey: shared !== null
      ? shared
      : (beforeStoreAnswered ? (s.openrouterKey || '') : ''),
  };
}

// Get user profile
export function getUserProfile() {
  const storage = loadFromStorage();
  const profile = storage.userProfile || DEFAULT_STORAGE.userProfile;
  console.log('[Persistence] getUserProfile returning:', profile);
  return profile;
}

// Save user profile
export function saveUserProfile(profile) {
  const storage = loadFromStorage();
  storage.userProfile = { ...DEFAULT_STORAGE.userProfile, ...profile };
  // Return durability so callers that must not proceed on an unsaved edit
  // (the profile-switch / export abort) can see a passthrough quota failure,
  // which saveToStorage otherwise only logs.
  return saveToStorage(storage);
}

// Initialize persistence - connect store to auto-save
export function initPersistence(variantId) {
  store.onSave((data) => {
    if (variantId) {
      const storage = loadFromStorage();
      const variant = storage.variants[variantId];
      if (variant && !isDeletedVariant(variant)) {
        // The debounced auto-save is the path that persists ongoing EDITS.
        // When the write fails (browser passthrough at storage quota), the
        // user must hear about it once — otherwise everything typed from now
        // on silently evaporates on quit/reload.
        const ok = saveVariant(variantId, variant.name, data);
        if (ok) {
          try {
            // Stamps the résumé and its history and QUEUES them for the storage
            // drain — it no longer announces them here. `ok` above is the
            // write-behind cache accepting the value, not the disk taking it,
            // and telling the transport to upload on that answer is how a
            // change tag gets held for bytes that never landed. The handler's
            // own comment carries the rest.
            persistedSaveHandler?.(variantId);
          } catch (err) {
            console.error('[Persistence] sync bookkeeping failed after successful save:', err);
          }
        } else {
          storageErrorToast(
            'Storage is full — your recent edits are NOT being saved. Free up '
            + 'space (delete resumes you no longer need) or export a backup now '
            + 'via Settings → Data → Export Backup.',
            { once: true },
          );
        }
        return ok; // let store.saveNow() report durability (profile-switch abort)
      }
    }
    return true; // nothing to persist
  });
}

// Export resume as JSON
export function exportAsJSON(data, filename) {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename || 'resume.json', 'application/json');
}

// Export resume as Markdown
export function exportAsMarkdown(data, filename) {
  const markdown = generateMarkdown(data);
  downloadFile(markdown, filename || 'resume.md', 'text/markdown');
}

// ===== Full backup / restore =====
//
// Snapshots EVERY appStorage key the app owns (variants, history,
// settings, chat, job descriptions) into a single JSON envelope. The
// envelope format is shared with `scripts/migrate-from-electron.mjs` so
// a JSON produced from the old Electron LevelDB is also importable here.
//
// Why a single envelope instead of N per-key files? The data has
// internal references (currentVariantId points at a variants key;
// history is keyed by variantId; chat threads reference variantIds).
// Round-tripping atomically as a single file keeps those refs
// consistent — partial restores would risk dangling references.

import {
  BACKUP_HISTORY_PREFIX,
  isOwnedKey,
  OPENROUTER_KEY_KEY,
  PROFILES_KEY,
  ACTIVE_PROFILE_KEY,
  isValidProfileId,
  splitPhysicalKey,
  physicalKey,
  withoutStoredCredentials,
  withoutDeviceIdentity,
  mapKey,
} from './profileKeys.js';
import { clearedPayloadFor, clearableKeys } from './sync/clearedPayloads.js';
import { loadRegistry, getActiveProfileId } from './profiles.js';
import { getProfileMapping } from './appStorage.js';

export { isOwnedKey }; // re-export: backupKeys.test.js and others import it from here

// Shared machine-level keys that belong in a backup (parity with the old
// BACKUP_FIXED_KEYS entries for theme/updates, plus the companion-bridge
// pairing token — one loopback server per install, so the token is not
// per-profile. model-catalog and migration flags stay cache/flag-only, never
// backed up).
const BACKUP_SHARED_KEYS = [
  'resume-designer-theme',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  'resume-designer-bridge-token',
];

// The API key USED to be a backed-up shared key. It lives in the OS keychain
// now (secretStore.js), and putting it back in a backup would undo that: a
// backup JSON is clear-text storage of exactly the kind the credential was
// moved out of, and it is a file people deliberately email and sync — more
// exposed than app_data_dir ever was, not less.
//
// So the credential is no longer backup data at all: not exported, not wiped on
// import, not restored. Restoring onto a new machine means entering the key
// once, from Settings.
//
// Listed here rather than deleted because older backup files still carry it and
// the validator below rejects shared keys it does not recognise — dropping the
// name outright would make every backup a user already holds fail to import.
const BACKUP_LEGACY_SHARED_KEYS = [OPENROUTER_KEY_KEY];

/**
 * Recognize a localStorage QuotaExceededError across browser engines.
 * Different browsers report this differently and JS doesn't expose a
 * single canonical predicate; we accept the four common forms:
 *   - WebKit/Blink: `e.name === 'QuotaExceededError'`
 *   - Firefox:      `e.name === 'NS_ERROR_DOM_QUOTA_REACHED'` or `e.code === 1014`
 *   - Legacy:       `e.code === 22` (DOMException quota code)
 *   - Fallback:     message text contains "quota" (defensive)
 */
function isQuotaExceededError(e) {
  if (!e) return false;
  if (e.name === 'QuotaExceededError') return true;
  if (e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  if (e.code === 22 || e.code === 1014) return true;
  return /quota/i.test(String(e.message ?? ''));
}

/**
 * Write a key through appStorage with graceful fallback for history
 * keys specifically. Returns true on success, false if the write was
 * skipped because we hit the storage quota AND it was a history key.
 * (Quota throws only happen in the browser passthrough; cached/Tauri
 * writes never throw here.)
 *
 * History (undo/redo per variant) can be 100s of KB to multiple MB
 * for users with long edit sessions. WKWebView's per-origin
 * localStorage cap is ~5 MB — large legacy data sets blow past it on
 * import. Treating history as best-effort means resumes / job
 * descriptions / user profile (a few hundred KB total) always fit,
 * and we drop the least-important data instead of failing the
 * entire import.
 *
 * Critical keys (resume-designer-data, job descriptions, etc.)
 * still throw on quota — they shouldn't be that big, and silently
 * losing them would be a much worse failure mode than surfacing
 * an error.
 */
function writeOwnedKeyOrSkip(key, value) {
  try {
    appStorage.setItem(key, value);
    return true;
  } catch (e) {
    if (isQuotaExceededError(e) && key.includes(BACKUP_HISTORY_PREFIX)) {
      console.warn(
        `[backup] Skipping history key "${key}" — storage quota exceeded.`
      );
      return false;
    }
    throw e;
  }
}

// Undo a failed wipe-then-write import: drop whatever the import managed to
// write, then restore the snapshot taken before the wipe. The snapshot fit in
// storage before the wipe, so it fits again once the partial writes are gone;
// the per-key try/catch is defensive — a rollback must never mask the import
// error it is cleaning up after.
function rollbackWipedImport(writtenKeys, priorValues) {
  for (const k of writtenKeys) {
    try { appStorage.removeItem(k); } catch { /* keep going */ }
  }
  for (const [k, v] of priorValues) {
    // A null here is a key that did NOT exist before the restore — the snapshot
    // resolves each name to the address appStorage would use, and an unprefixed
    // owned key whose physical twin is absent reads as null. `setItem` stringifies,
    // so replaying it wrote the four characters "null" into a key that should not
    // exist at all: readable, stampable, and uploadable to every other device as
    // that unit's payload. The wipe above is what restores absence.
    if (v == null) continue;
    try { appStorage.setItem(k, v); } catch { /* keep going */ }
  }
}

// Physical keys belonging to the ACTIVE profile, plus any unprefixed owned
// keys (pre-adoption states), plus shared owned keys. This is the "what a
// format-1 restore may remove/replace" set — other profiles are untouchable.
function collectActiveOwnedKeys() {
  const active = getActiveProfileId();
  return appStorage.keys().filter((k) => {
    if (!k) return false;
    const split = splitPhysicalKey(k);
    if (split) return split.profileId === active && isOwnedKey(split.logicalKey);
    return isOwnedKey(k); // unprefixed per-profile keys AND shared owned keys (theme etc.)
  });
}

/**
 * Write a JSON file containing the registry, shared keys, and every
 * profile's owned keys (format 2). Shared owned keys (theme, update settings)
 * route to the shared section. In the incomplete-adoption RECOVERY state
 * (mapping left off after a quota/disk failure) the live workspace still lives
 * under UNPREFIXED owned keys — those are captured under the active profile
 * below, so a backup taken on the storage-failure guidance still contains the
 * user's resumes, not just registry/settings.
 * Returns { keysExported, filename } for the caller to surface in UI.
 */
export function exportFullBackup(filename) {
  // Null-prototype map: profile ids are alphanumeric (isValidProfileId), which
  // includes prototype names like "constructor" / "toString". Keyed on a plain
  // {}, `profiles[id] ||= …` would see the inherited value as truthy and never
  // assign, then `.keys` would read a builtin instead of the fresh bucket and
  // the profile's data would be lost from the export (and absent on JSON
  // stringify, since it's inherited not own). Object.create(null) has no such
  // inherited keys; JSON.stringify still serializes its own enumerable keys.
  const profiles = Object.create(null);
  const shared = {};
  const activeId = getActiveProfileId();
  // A deleted workspace's bytes are not part of a backup: exported, they come
  // back on the next restore and the workspace the person deleted is simply
  // there again. A backup enumerates PHYSICAL keys, which know nothing about
  // the registry, so the registry is what has to say.
  //
  // THE ACTIVE ONE IS EXEMPT, and getting that wrong is worse than not
  // filtering at all. `purgeTombstonedProfiles` refuses to touch the active
  // workspace precisely because it is still mapped and still holds live content
  // on screen — so it is the one tombstoned namespace guaranteed to be full,
  // and filtering it here threw away exactly what the purge was protecting.
  //
  // The path is not hypothetical: when the switch away from a remotely deleted
  // workspace FAILS — most often a failed disk write — the app stays on it, and
  // the app's own response to a failed disk write is a toast telling the person
  // to export a backup. That backup would have omitted everything on their
  // screen, announced success, and then destroyed the local copy on restore,
  // because a registry id with no bucket restores as an empty workspace.
  const deletedProfileIds = new Set(
    (loadRegistry() || [])
      .filter((p) => p?.deletedAt && p.id && p.id !== activeId)
      .map((p) => p.id),
  );
  for (const k of appStorage.keys()) {
    if (!k) continue;
    const split = splitPhysicalKey(k);
    if (split && deletedProfileIds.has(split.profileId)) continue;
    if (split && isOwnedKey(split.logicalKey)) {
      const v = appStorage.getItem(k);
      if (v !== null) {
        ((profiles[split.profileId] ||= { keys: {} }).keys)[split.logicalKey] =
          withoutStoredCredentials(split.logicalKey, v);
      }
    } else if (BACKUP_SHARED_KEYS.includes(k)) {
      const v = appStorage.getItem(k);
      if (v !== null) shared[k] = v;
    }
  }
  // Recovery state: unprefixed owned keys (non-shared) are the active profile's
  // authoritative live data — edits since the failed adoption went here, so
  // they OVERRIDE any stale physical partial copy. A no-op in the normal case
  // (mapping on → no unprefixed owned keys exist). In the MARKERLESS degraded
  // state (the very first marker write failed: no registry, no pointer,
  // activeId null) they are captured under a synthesized recovery id instead —
  // otherwise the escape-hatch backup the storage-failure guidance tells the
  // user to take would contain an empty registry and NO resumes, and the
  // importer would reject the file outright. The orphan reconciliation below
  // then synthesizes the matching registry entry.
  const unprefixedOwned = appStorage.keys().filter(
    (k) => k && !splitPhysicalKey(k) && !BACKUP_SHARED_KEYS.includes(k) && isOwnedKey(k)
  );
  let recoveryId = activeId;
  if (!recoveryId && unprefixedOwned.length) {
    recoveryId = 'recovered0';
    while (profiles[recoveryId]) recoveryId += '0'; // never merge into a real namespace
  }
  if (recoveryId) {
    for (const k of unprefixedOwned) {
      const v = appStorage.getItem(k);
      if (v !== null) ((profiles[recoveryId] ||= { keys: {} }).keys)[k] = withoutStoredCredentials(k, v);
    }
  }
  // Reconcile orphan namespaces with the exported registry: a partial
  // cached-mode deletion (registry update durable, some workspace deletes
  // not) can leave physical keys whose id is missing from loadRegistry(),
  // and importFullBackupV2 rejects orphan `profiles` entries outright — the
  // app must never generate a backup its own importer refuses. Synthesizing
  // a registry entry (in the EXPORTED copy only, never live storage) keeps
  // the data and makes the backup self-consistent; the orphan becomes a
  // visible, normal profile on restore.
  const exportedRegistry = (loadRegistry() || []).slice();
  const knownIds = new Set(exportedRegistry.map((p) => p.id));
  for (const pid of Object.keys(profiles)) {
    if (!knownIds.has(pid)) {
      exportedRegistry.push({ id: pid, name: `Recovered profile (${pid.slice(0, 6)})` });
    }
  }
  // The ACTIVE workspace goes into the envelope LIVE, even when its registry
  // entry is tombstoned. Its bytes are included above — they are what is on
  // screen — but bytes alone do not restore: a format-2 restore writes the
  // tombstone unchanged, the next start resolves to some other live workspace,
  // and `purgeTombstonedProfiles` then deletes the namespace that was just
  // restored. The recovery backup could not recover the very thing it was taken
  // for, which is the state the storage-failure guidance sends people to it in.
  //
  // `updatedAt` is refreshed so the revival OUTRANKS the tombstone it replaces —
  // without that, the next registry merge re-tombstones it and the purge takes
  // it again one sync later. This is the exported copy only, never live storage,
  // the same rule the orphan synthesis above follows: restoring is an explicit
  // act, and somebody restoring this file is asking for exactly this workspace.
  if (activeId) {
    const i = exportedRegistry.findIndex((p) => p?.id === activeId && p?.deletedAt);
    if (i !== -1) {
      const { deletedAt: _deletedAt, ...revived } = exportedRegistry[i];
      exportedRegistry[i] = { ...revived, updatedAt: new Date().toISOString() };
    }
  }

  const backup = {
    backupFormat: 2,
    kind: 'full',
    createdAt: new Date().toISOString(),
    source: 'in-app',
    registry: exportedRegistry,
    activeProfile: getActiveProfileId(),
    shared,
    profiles,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const name = filename || `on-paper-backup-${stamp}.json`;
  downloadFile(JSON.stringify(backup, null, 2), name, 'application/json');
  const keysExported = Object.values(profiles)
    .reduce((n, p) => n + Object.keys(p.keys).length, Object.keys(shared).length);
  return { keysExported, filename: name };
}

/**
 * Replace all owned storage keys with the contents of an already-
 * parsed backup envelope. Auto-migration (which receives the envelope
 * directly from a Rust command) and the file-based importer below both
 * funnel through here.
 *
 * Returns { keysImported, removedExistingKeys }. The caller is
 * responsible for prompting/confirming and for ensuring the in-memory
 * store re-reads from storage (via reload, or by running this
 * BEFORE the store first reads).
 */
// The single fix-up point for a value arriving from a backup envelope. Both
// import formats route their owned-key writes through here, so anything that
// must be true of EVERY imported value belongs in this function rather than at
// one of the call sites — the credential strip was originally applied per-site
// and the format-1 replacement path was simply missed.
//
// Three jobs:
//
// 1. Legacy Electron stores can hold job descriptions as an id-keyed OBJECT map
//    — a shape the Rust migration probe explicitly counts as valid and the
//    envelope passes through verbatim — but jobDescriptions.js requires an
//    array (it spreads/filters the parsed value). Canonicalize on import;
//    anything else (already an array, unparseable) is written unchanged.
//
// 2. Strip a legacy `settings.openrouterKey` out of the data blob. Backups
//    written before the keychain move still carry it, and on a fresh install
//    with an empty keychain it would land in plaintext, go live immediately,
//    and be promoted into the keychain on the next boot — an old backup quietly
//    restoring a credential the exclusion policy says it must not.
//
//    `keepCredential` exempts BOTH Electron paths — the automatic upgrade in
//    main.js and the manual "import from previous installation" in
//    backupFlow.js. Each is a MIGRATION of the user's own live data on this
//    machine, not the restore of a backup FILE. The test is where the data came
//    from, not which function is calling: a file could have come from any
//    machine, the LevelDB store next door could not. Stripping deleted the key
//    outright, and on the automatic path it then stamped
//    the migration flag `imported`, so it never ran again and the user came up
//    permanently without the AI credential they had configured. Kept, it flows
//    through the ordinary upgrade pipeline instead — extractSharedApiKey moves
//    it to the shared key, initSecretStore moves that into the keychain and
//    strips the plaintext — the same path every pre-keychain user already takes
//    on first launch of this version. The plaintext hop is momentary and on the
//    same disk the Electron app was already keeping the key on in the clear, so
//    it exposes nothing that was not already exposed.
//
// 3. Drop the backup's `deviceId` out of the sync-state key. That key belongs in
//    a backup — the per-unit modification stamps in it are per-profile data — but
//    the id beside them names the MACHINE, and restoring one device's backup onto
//    a second gave both the same origin id, which is what undo scopes itself by.
//    NOT exempted by `keepCredential`: a same-machine Electron migration predates
//    sync entirely and carries no such key, so there is nothing for an exemption
//    to preserve. See withoutDeviceIdentity for the rest of the argument.
function normalizeImportedValue(key, value, keepCredential = false) {
  // One call each, and the flag carries the one exemption there is.
  // `keepCredential` spares the OpenRouter key for a same-machine migration; the
  // dead provider keys are never spared, which the helper enforces rather than
  // leaving to this caller, and neither is the device id.
  const sanitized = withoutDeviceIdentity(
    key,
    withoutStoredCredentials(key, value, { keepOpenRouterKey: keepCredential }),
  );
  if (key !== 'resume-designer-job-descriptions') return sanitized;
  try {
    const jd = JSON.parse(sanitized);
    if (jd && typeof jd === 'object' && !Array.isArray(jd)) {
      return JSON.stringify(Object.values(jd));
    }
  } catch { /* leave malformed JSON as-is; initJobDescriptions handles it */ }
  return sanitized;
}

/**
 * The incoming blob, with a tombstone for every résumé the restore DROPS.
 *
 * A replacement restore is a deletion for anything it omits — but it writes a
 * new blob rather than calling `deleteVariant`, so nothing produced the
 * tombstone that makes a deletion travel. `changedDataUnits` only compares ids
 * present in the new value, so the dropped résumé was not even named: CloudKit
 * kept its record, and the next fetch on any device handed it straight back.
 *
 * The tombstone carries no `data`, exactly as `deleteVariant`'s does, so every
 * reader hides it and `landsAsResume` still accepts it on the other side.
 */
/**
 * Write the "cleared" value for every synced key this restore wiped and did not
 * put back, so the removal travels.
 *
 * The wipe deletes each owned key and the write loops only restore the ones the
 * backup carries; whatever is left over is a deletion nothing announces, because
 * an absent key produces no unit (`collectKeyUnit`). Routed through the
 * restore's own tracked writer so the ordinary machinery carries it: the write
 * joins the rollback set, and `stampRestoredWrites` names its unit from the
 * comparison against the pre-wipe value like any other.
 *
 * @param priorValues pre-wipe snapshot, keyed by ADDRESS
 * @param writtenAddresses the addresses this restore has already rewritten
 * @param write (address, value, profileId, logicalKey) => void
 */
function clearOmittedSyncedKeys(priorValues, writtenAddresses, write, workspaces) {
  for (const profileId of workspaces) {
    for (const logicalKey of clearableKeys()) {
      // The ADDRESS this workspace's key lives at. '' is the open one, where
      // `mapKey` answers with whatever the mapping currently says — which is
      // also what `snapshotAndWipeOwnedKeys` keyed the snapshot by.
      const address = profileId
        ? physicalKey(profileId, logicalKey)
        : mapKey(getProfileMapping(), logicalKey);
      if (writtenAddresses.has(address)) continue;
      const cleared = clearedPayloadFor(logicalKey);
      if (cleared === undefined) continue;
      // Nothing to say for a key already at its cleared value: a `key:` unit is
      // named unconditionally, so a no-op write would upload nothing and stamp
      // it with a fresh time that outranks another device's real edit. An
      // ABSENT key is not that case — absence is what the server may disagree
      // with, and the whole reason this enumerates rather than reads.
      if (priorValues.get(address) === cleared) continue;
      write(address, cleared, profileId, logicalKey);
    }
  }
}

/**
 * Snapshot and wipe a set of owned keys, ONE ENTRY PER ADDRESS.
 *
 * Two different names can address the same cache slot: with a profile mapping
 * on, `appStorage` resolves an unprefixed owned key to that workspace's
 * physical key — so on an install carrying both (the incomplete-adoption
 * recovery state `exportFullBackup` documents, where the live workspace still
 * sits under UNPREFIXED keys), the naive loop snapshotted the value under the
 * first name, REMOVED it, and then recorded `null` for the second. Both restore
 * formats then read that null as "there was nothing here", wrote no tombstone
 * for any résumé the backup drops, and left every one of those CloudKit records
 * alive to come back on the next fetch. Resolving first and skipping repeats
 * keeps one real value per slot.
 */
function snapshotAndWipeOwnedKeys(keys) {
  const priorValues = new Map();
  const mapping = getProfileMapping();
  for (const k of keys) {
    // `mapKey` IS the rule appStorage applies, so it is the only thing asked.
    // A hand-written predicate here would have to re-derive its carve-outs for
    // shared keys and already-physical ones, and drift the day one changes.
    const address = mapKey(mapping, k);
    if (priorValues.has(address)) continue;
    priorValues.set(address, appStorage.getItem(address));
    appStorage.removeItem(address);
  }
  return priorValues;
}

/**
 * The pre-wipe value for a key a format-2 restore addresses PHYSICALLY.
 *
 * Mirror image of `priorSnapshotFor`, and needed for the mirror-image reason.
 * The snapshot is keyed by the address `appStorage` resolves to, and with the
 * profile mapping OFF — the incomplete-adoption recovery state `exportFullBackup`
 * documents — the active workspace's keys sit UNPREFIXED, while a format-2
 * restore addresses every workspace by its physical name. The lookup missed,
 * every key read as "there was nothing here", and the restore wiped that
 * workspace's résumés while writing no tombstone for any of them: deleted
 * locally, alive on the server, and handed straight back by the next fetch.
 */
function priorPhysicalSnapshot(address, logicalKey, profileId, priorValues) {
  if (priorValues.has(address)) return priorValues.get(address);
  if (!getProfileMapping() && profileId === getActiveProfileId()) {
    return priorValues.get(logicalKey);
  }
  return undefined;
}

/**
 * The pre-wipe value for a key the caller names LOGICALLY.
 *
 * `collectActiveOwnedKeys` snapshots what `appStorage.keys()` reports, which is
 * the PHYSICAL key once a profile mapping is on — while the format-1 restore
 * writes through the logical one. Looking the snapshot up by the logical name
 * therefore found nothing on every ordinary profiled install, and the tombstones
 * this exists for were silently never written. The first test for it missed this
 * because it ran with mapping OFF, where the two names are the same string.
 */
function priorSnapshotFor(logicalKey, priorValues) {
  if (priorValues.has(logicalKey)) return priorValues.get(logicalKey);
  const mapping = getProfileMapping();
  return mapping ? priorValues.get(mapKey(mapping, logicalKey)) : undefined;
}

function withTombstonesForDroppedVariants(priorRaw, nextRaw, droppedIds = []) {
  const prior = parseJSONSafe(priorRaw);
  // NO EARLY RETURN on a missing prior blob. Only the tombstone loop below
  // needs one — it is comparing against what this workspace held — while the
  // field reset is about what the BACKUP omits, which is a fact about the
  // backup and true whatever this device happens to have. A device with no blob
  // for a workspace (clean, or a profile it has never opened) is exactly the one
  // that cannot know another device holds customised settings for it, and
  // bailing here left the restore with nothing to stamp or announce, so that
  // record came back on the next fetch.
  // An ABSENT incoming blob is a workspace the backup represents as empty, and
  // that is still a deletion of everything in it. Treated as "nothing to
  // compare", the wipe removed the résumés locally and no tombstone was written
  // for any of them, so every CloudKit record survived and the next fetch
  // brought the whole workspace back.
  // RESET to the defaults when there is no incoming blob — not carried over
  // from the prior one, and not dropped.
  //
  // Dropping was the original bug: the blob holds `settings` and `userProfile`
  // beside the résumés, and a field that is simply gone is never named, because
  // `changedDataUnits` compares the fields present in the NEXT blob. So the
  // server kept them and the next fetch put them back — a local loss that undid
  // itself. Carrying them over fixed the travelling and broke the promise
  // instead: the restore confirmation says in as many words that current
  // settings WILL be replaced, and a workspace left holding values absent from
  // the backup is not what the person agreed to.
  //
  // The defaults are both. They are what "this workspace has no blob" means,
  // they are a VALUE rather than an absence so the reset travels like any other
  // change, and building from `DEFAULT_STORAGE` rather than spreading `prior`
  // also means no credential can ride across — `normalizeImportedValue` strips
  // those from an incoming blob, and this path has no incoming blob to strip.
  const next = parseJSONSafe(nextRaw) ?? {
    settings: DEFAULT_STORAGE.settings,
    userProfile: DEFAULT_STORAGE.userProfile,
    variants: {},
  };
  if (typeof next !== 'object') return nextRaw;
  const nextVariants = next.variants && typeof next.variants === 'object' ? next.variants : {};
  // The two units that live INSIDE this blob get the same treatment as every
  // whole key: a field the backup omits is a field it clears, and an absence
  // announces nothing. `changedDataUnits` compares the fields present in the
  // NEXT blob, so one that is simply gone is never named — the wipe removes it
  // here, the server keeps it, and the next fetch puts it back.
  //
  // Written whether or not THIS device had one, which is the part that looks
  // like inventing a field and is not. What the reset has to outrank lives on
  // the SERVER, and a device that never stored the field locally — a clean or
  // offline one restoring an older backup before its first fetch — is exactly
  // the device that cannot know another has a customised record. Absent, the
  // restore stamps and announces nothing and that record comes back. The
  // default is also what every reader already falls back to, so writing it
  // explicitly changes no behaviour here; it only gives the reset something to
  // travel as.
  let reset = 0;
  for (const field of ['settings', 'userProfile']) {
    if (next[field] === undefined) {
      next[field] = DEFAULT_STORAGE[field];
      reset++;
    }
  }
  const now = new Date().toISOString();
  let carried = 0;
  for (const [id, variant] of Object.entries(prior?.variants ?? {})) {
    if (nextVariants[id]) continue;
    if (isDeletedVariant(variant)) {
      // CARRIED FORWARD UNCHANGED, not skipped — the same mistake the registry
      // path made with already-deleted profiles. A résumé deleted here whose
      // tombstone has not reached CloudKit yet is one the server still holds
      // live; dropping the tombstone from the rebuilt blob leaves nothing to
      // upload, and the next fetch brings the résumé back. Verbatim, so its
      // original `deletedAt` stands: the deletion happened when it happened,
      // and moving the time forward would have it win arguments it should not.
      nextVariants[id] = variant;
      carried++;
      continue;
    }
    nextVariants[id] = { id, name: variant?.name, deletedAt: now, updatedAt: now };
    droppedIds.push(id);
  }
  // An ABSENT incoming blob always writes, even with nothing to tombstone. The
  // synthesized blob carries the DEFAULT settings and userProfile, and that
  // reset is the whole point of it: a workspace holding customised values and
  // no résumés would otherwise return `null` here, both callers would skip the
  // write, and the local wipe would look like a reset that no unit was ever
  // stamped or announced for — so the stale server copies come back.
  // `variants` is only forced onto the blob when there is something to put in it
  // or it was already there. A blob that never carried the key should not
  // acquire an empty one just because this ran.
  const rebuild = () => {
    const out = { ...next };
    if (Object.keys(nextVariants).length > 0 || next.variants !== undefined) {
      out.variants = nextVariants;
    }
    return JSON.stringify(out);
  };
  if (nextRaw == null) return rebuild();
  // `reset` counts too, or a backup that omits `settings` while dropping no
  // résumés would fall through to `nextRaw` and discard the default this just
  // decided on.
  if (droppedIds.length === 0 && carried === 0 && reset === 0) return nextRaw;
  return rebuild();
}

function parseJSONSafe(raw) {
  if (typeof raw !== 'string') return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function importFullBackupV2(parsed, keepCredential = false) {
  const registry = parsed.registry;
  // A PRESENT emoji must be a string: the switcher renders it directly as a
  // React child, so a non-string (e.g. {}) would throw and blank the app after
  // a restore that already wiped the prior storage. A missing emoji is fine —
  // loadRegistry coerces it to the default.
  const validRegistry = Array.isArray(registry) && registry.length > 0
    && registry.every((p) => p && isValidProfileId(p.id) && typeof p.name === 'string'
      && (p.emoji === undefined || typeof p.emoji === 'string'));
  const uniqueIds = validRegistry && new Set(registry.map((p) => p.id)).size === registry.length;
  if (!validRegistry || !uniqueIds) {
    throw new Error('Invalid format-2 backup: registry entries must have unique valid ids, string names, and (if present) string emoji.');
  }
  // Case-insensitive filesystems (Windows, and macOS by default) map the
  // physical keys — which become on-disk FILENAMES in the Tauri store —
  // case-insensitively, so ids differing only by case (e.g. "pABC"/"pabc")
  // collide to the same files: one restored workspace silently overwrites the
  // other. Generated ids are always lowercase (base-36), so this only rejects
  // hand-edited or foreign backups, before the destructive wipe.
  const caseFoldedUnique = new Set(registry.map((p) => p.id.toLowerCase())).size === registry.length;
  if (!caseFoldedUnique) {
    throw new Error('Invalid format-2 backup: registry ids must be unique case-insensitively (they map to filenames).');
  }
  // Reject a non-plain-object `profiles` (incl. arrays) pre-wipe: an array
  // passes typeof 'object', then every registry id reads as a missing entry
  // (treated as an empty workspace) and the wipe proceeds restoring nothing.
  if (!parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
    throw new Error('Invalid format-2 backup: "profiles" must be an object.');
  }

  // Validate and collect every referenced profile before removing anything.
  // A malformed or missing entry must never turn a restore into a destructive
  // partial wipe, and collecting up front lets critical keys across ALL
  // profiles be written before any best-effort history data.
  // Reject orphan `profiles` entries BEFORE the wipe: an entry whose id is
  // not in the (validated) registry would pass the per-profile validation
  // below — which iterates registry ids — but never be written by the restore
  // loops, so the clean slate would silently drop that workspace.
  // App-generated backups keep registry and profiles in sync; an orphan means
  // the file is corrupt or hand-edited.
  const registryIds = new Set(registry.map((p) => p.id));
  for (const pid of Object.keys(parsed.profiles)) {
    if (!registryIds.has(pid)) {
      throw new Error(`Invalid format-2 backup: profiles entry "${pid}" is not in the registry.`);
    }
  }

  const profileEntries = [];
  for (const { id: pid } of registry) {
    // Own-property read only: a registry id like "toString" with no entry is a
    // valid empty workspace, but a plain `parsed.profiles[pid]` would inherit
    // Object.prototype.toString and mis-read it as a present-but-invalid entry.
    const entry = Object.hasOwn(parsed.profiles, pid) ? parsed.profiles[pid] : undefined;
    // A registry profile with no stored keys yet exports with NO profiles
    // entry at all (exportFullBackup only creates one per observed physical
    // key) — a missing entry is a valid empty workspace, not corruption.
    if (entry === undefined) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid format-2 backup: profile "${pid}" must be an object.`);
    }
    if (!entry.keys || typeof entry.keys !== 'object' || Array.isArray(entry.keys)) {
      throw new Error(`Invalid format-2 backup: profile "${pid}" keys must be an object.`);
    }
    for (const [logicalKey, value] of Object.entries(entry.keys)) {
      if (typeof value !== 'string') {
        throw new Error(`Invalid backup: ${pid}/"${logicalKey}" must be a string value.`);
      }
      if (!isOwnedKey(logicalKey)) {
        throw new Error(`Invalid backup: unrecognized key "${logicalKey}".`);
      }
      profileEntries.push({
        physicalKey: physicalKey(pid, logicalKey),
        logicalKey,
        // Sanitized on write, by normalizeImportedValue — see its note on why
        // that lives in one chokepoint rather than at each call site.
        value,
      });
    }
  }

  // Validate the shared section BEFORE the wipe. This must run pre-wipe:
  // otherwise the clean slate below removes the current shared value (API key,
  // theme…) and the write loop, guarded on membership + `typeof v === 'string'`,
  // silently skips the bad replacement — a "successful" restore that erased
  // machine-level settings. Check the CONTAINER first: a string or array
  // `shared` would survive Object.entries (its entries are strings) and slip
  // past the value check.
  if (parsed.shared !== undefined
      && (parsed.shared === null || typeof parsed.shared !== 'object' || Array.isArray(parsed.shared))) {
    throw new Error('Invalid format-2 backup: "shared" must be an object.');
  }
  for (const [k, v] of Object.entries(parsed.shared || {})) {
    // Unknown keys reject too: app-generated backups only ever emit
    // BACKUP_SHARED_KEYS members, so an unrecognized key means the file is
    // corrupt, hand-edited, or from a newer format — and the restore loop
    // below would silently DROP it after the wipe, reporting success while
    // not restoring a setting the file plainly represents.
    //
    // The legacy list is the one exception, and it is safe for the exact reason
    // that rule exists: the credential is deliberately not restored, and the
    // wipe below no longer removes it, so nothing the file represents is lost.
    if (!BACKUP_SHARED_KEYS.includes(k) && !BACKUP_LEGACY_SHARED_KEYS.includes(k)) {
      throw new Error(`Invalid format-2 backup: unrecognized shared key "${k}".`);
    }
    if (typeof v !== 'string') {
      throw new Error(`Invalid backup: shared key "${k}" must be a string value.`);
    }
  }

  // Clean slate across ALL namespaces (full restore replaces everything) —
  // snapshotting every removed value first. The critical writes below can
  // throw QuotaExceededError in passthrough mode (a desktop multi-profile
  // backup can exceed a browser origin's quota), and without the snapshot
  // that throw would leave the store wiped or half-restored — losing the
  // user's CURRENT profiles on a failed import.
  // OPENROUTER_KEY_KEY is deliberately NOT wiped. The credential is no longer
  // backup data, so nothing would restore it — wiping it here would let an
  // import silently destroy a working key. (Post-migration it is not in
  // appStorage at all; this matters for an install that has not migrated yet.)
  const priorValues = snapshotAndWipeOwnedKeys(appStorage.keys().filter((k) => {
    const split = splitPhysicalKey(k);
    const owned = split ? isOwnedKey(split.logicalKey) : isOwnedKey(k);
    return owned || k === PROFILES_KEY || k === ACTIVE_PROFILE_KEY;
  }));
  const removedExistingKeys = priorValues.size;

  const written = [];
  // profileId -> every synced write this restore made in THAT workspace, with
  // the value it replaced. The interceptor cannot build this itself: these are
  // written under physical, profile-namespaced names, which `classifyKey`
  // answers 'unknown' for, so nothing a restore brings is stamped or announced
  // by the ordinary path. Recorded here because the restore is the only thing
  // that knows which workspace each key belongs to.
  const restoredWrites = new Map();
  const noteWrite = (pid, logicalKey, value, previous) => {
    if (!restoredWrites.has(pid)) restoredWrites.set(pid, []);
    restoredWrites.get(pid).push({ logicalKey, value, previous });
  };
  // `k` is the ADDRESS appStorage resolves to for every call here — physical for
  // a profile's key, unchanged for a shared one — so the pre-wipe snapshot,
  // which `snapshotAndWipeOwnedKeys` keys by address, answers directly.
  const writeTracked = (k, v, pid = '', logicalKey = k) => {
    appStorage.setItem(k, v);
    written.push(k);
    noteWrite(pid, logicalKey, v, priorPhysicalSnapshot(k, logicalKey, pid, priorValues) ?? null);
  };

  let keysImported = 0;
  let historySkipped = 0;
  // profileId -> the unit ids tombstoned in THAT workspace. Declared out here
  // so the return below can hand them to the durable caller.
  // Filled at the end of the try, from the writes recorded below.
  let restoredUnits = new Map();
  try {
    // A workspace the restore OMITS is a workspace the restore deletes — and
    // `mergeRegistry` is a union, so a merely-absent entry reads as "keep the
    // local one". Other devices went on showing it, and their next registry
    // edit uploaded it back for fresh ones. Written as tombstones so the
    // removal travels the way `deleteProfile`'s does.
    const priorRegistry = parseJSONSafe(priorValues.get(PROFILES_KEY)) || [];
    const restoredIds = new Set(registry.map((p) => p.id));
    const stamp = new Date().toISOString();
    // An ALREADY-tombstoned entry is carried across UNCHANGED rather than
    // skipped. Dropping it looks like tidying — the profile is gone, the backup
    // does not mention it — but the tombstone is the only thing standing between
    // that deletion and a device which still holds the live entry: `mergeRegistry`
    // unions, so the entry this device no longer carries is simply re-adopted
    // from the other one and the workspace comes back. Kept verbatim, not
    // re-stamped: the deletion happened when it happened, and moving its time
    // forward would have it win arguments it should not.
    const withRemovals = registry.concat(
      priorRegistry
        .filter((p) => p?.id && !restoredIds.has(p.id))
        .map((p) => (p.deletedAt ? p : { ...p, deletedAt: stamp, updatedAt: stamp })),
    );
    writeTracked(PROFILES_KEY, JSON.stringify(withRemovals));
    const active = registry.some((p) => p.id === parsed.activeProfile)
      ? parsed.activeProfile : registry[0].id;
    writeTracked(ACTIVE_PROFILE_KEY, active);

    for (const [k, v] of Object.entries(parsed.shared || {})) {
      if (BACKUP_SHARED_KEYS.includes(k) && typeof v === 'string') writeTracked(k, v);
    }

    // Same quota strategy as format 1, globally across every profile: critical
    // keys first, then bulky history best-effort. Per-profile passes could let
    // an early profile's history consume quota needed by a later profile's
    // critical data.
    const nonHistory = profileEntries.filter(
      ({ logicalKey }) => !logicalKey.startsWith(BACKUP_HISTORY_PREFIX)
    );
    const history = profileEntries.filter(
      ({ logicalKey }) => logicalKey.startsWith(BACKUP_HISTORY_PREFIX)
    );
    const blobWritten = new Set();
    for (const { physicalKey: key, logicalKey, value } of nonHistory) {
      let normalized = normalizeImportedValue(logicalKey, value, keepCredential);
      // Same rule one level down: a résumé the restore omits is a résumé it
      // deletes, and only a tombstone makes that travel.
      if (logicalKey === STORAGE_KEY) {
        normalized = withTombstonesForDroppedVariants(
          priorPhysicalSnapshot(key, STORAGE_KEY, splitPhysicalKey(key)?.profileId ?? '', priorValues),
          normalized,
        );
        blobWritten.add(splitPhysicalKey(key)?.profileId ?? '');
      }
      writeTracked(key, normalized, splitPhysicalKey(key)?.profileId ?? '', logicalKey);
      keysImported++;
    }
    // A workspace the backup represents as EMPTY writes no blob at all, so the
    // loop above never sees it — and the wipe already removed its résumés. The
    // tombstones have to be synthesized from the snapshot alone, or every one of
    // those CloudKit records outlives the restore and the next fetch undoes it.
    for (const { id: pid } of registry) {
      if (blobWritten.has(pid)) continue;
      const key = physicalKey(pid, STORAGE_KEY);
      const dropped = [];
      const rebuilt = withTombstonesForDroppedVariants(
        priorPhysicalSnapshot(key, STORAGE_KEY, pid, priorValues), null, dropped,
      );
      // Gated on there being something TO write, not on there being a tombstone
      // in it: the synthesized blob also resets settings and userProfile, and a
      // workspace with customised values and no résumés needs that written just
      // as much. `null` here means there was no prior blob at all.
      if (rebuilt == null) continue;
      writeTracked(key, rebuilt, pid, STORAGE_KEY);
    }
    for (const { physicalKey: key, logicalKey, value } of history) {
      if (writeOwnedKeyOrSkip(key, value)) {
        written.push(key);
        noteWrite(
          splitPhysicalKey(key)?.profileId ?? '', logicalKey, value,
          priorPhysicalSnapshot(key, logicalKey, splitPhysicalKey(key)?.profileId ?? '', priorValues) ?? null,
        );
        keysImported++;
      } else {
        historySkipped++;
      }
    }
    // Stamped HERE, with the restore's own writes and inside its try, and the
    // placement is the whole point. The stamp is itself an appStorage write, so
    // it has to happen before `importFullBackupDurably` arms the restore guard —
    // the guard DEFERS every other writer, and the reload the restore ends with
    // discards what was deferred, leaving the tombstone unstamped and reading as
    // -Infinity against the remote's real time. Riding this flush also makes it
    // roll back correctly: the sync-state key is a fixed backup key, so it is in
    // the pre-wipe snapshot. Only the ANNOUNCEMENT waits for durability.
    // EVERY RETAINED workspace, not every key on disk. A workspace the restore
    // deletes is skipped entirely: its profile tombstone carries that deletion
    // and its zone goes with it, so writing cleared payloads there re-creates
    // files for a profile that no longer exists and announces into a zone the
    // deletion is about to remove.
    clearOmittedSyncedKeys(
      priorValues, new Set(written), writeTracked,
      registry.map((p) => p.id),
    );
    restoredUnits = stampRestoredWrites(restoredWrites, (k) => written.push(k));
  } catch (err) {
    rollbackWipedImport(written, priorValues);
    throw err;
  }
  // `rollback` is for importFullBackupDurably: in cached mode nothing above
  // throws (failures surface at flush), so the snapshot must outlive this
  // function for the durability check to restore from.
  return {
    keysImported, removedExistingKeys, historySkipped,
    // HANDED BACK, not announced here. In cached mode nothing above throws —
    // failures surface at the flush — so announcing at this point uploads
    // deletions for a restore that may still be rolled back, and a rollback
    // cannot recall them. `commitRestoredUnits` is called once the flush
    // has answered.
    restoredUnits,
    rollback: () => rollbackWipedImport(written, priorValues),
    // For the guard's read isolation: pre-restore values (of removed keys) + the
    // keys written; appStorage normalizes both to physical form and marks the
    // added keys absent.
    preRestore: priorValues,
    writtenKeys: written,
  };
}

/**
 * The credential a format-1 envelope carries, or null when it carries none.
 *
 * Looks in BOTH places it can be, because the previous app used both: the
 * shared key once its own extraction had run, and `settings.openrouterKey` in
 * the data blob before that. Shared key first — it is the later of the two.
 *
 * Returns `''` verbatim when that is what is stored. An empty value means the
 * user had CLEARED their key in the previous installation, and on a
 * same-machine replace that is a state to adopt, not an absence to skip.
 */
export function credentialFromEnvelope(parsed) {
  const keys = parsed?.keys;
  if (!keys || typeof keys !== 'object') return null;
  if (typeof keys[OPENROUTER_KEY_KEY] === 'string') return keys[OPENROUTER_KEY_KEY];
  const blob = keys[STORAGE_KEY];
  if (typeof blob !== 'string') return null;
  try {
    const settings = JSON.parse(blob)?.settings;
    if (!settings || typeof settings !== 'object') return null;
    return typeof settings.openrouterKey === 'string' ? settings.openrouterKey : null;
  } catch {
    return null;
  }
}

export function importFullBackupFromEnvelope(parsed, { keepCredential = false } = {}) {
  if (parsed && parsed.backupFormat === 2 && parsed.kind === 'full') {
    return importFullBackupV2(parsed, keepCredential);
  }
  if (!parsed || parsed.backupFormat !== 1 ||
      !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(
      'Not an On Paper backup envelope (missing "backupFormat: 1" or a format-2 "kind: full").'
    );
  }
  // Every value must be a string — that's what `appStorage.setItem`
  // stores. Catching this here gives a clear error instead of a silent
  // String() coercion that could corrupt JSON-parseable payloads.
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (typeof v !== 'string') {
      throw new Error(`Invalid backup: key "${k}" must be a string value.`);
    }
  }

  // Clean slate for the active profile only: remove its existing owned keys
  // so the imported state is canonical without touching other profiles.
  // Snapshot each removed value first — pass 1 below can throw
  // QuotaExceededError in passthrough mode, and the rollback restores this
  // snapshot so a failed import can't leave the workspace wiped.
  const priorValues = snapshotAndWipeOwnedKeys(collectActiveOwnedKeys());

  // Two-pass write to handle the localStorage quota safely:
  //
  //   Pass 1: every NON-history key (resume-designer-data, JDs, chat
  //   threads, all settings keys). These are small in aggregate
  //   (~250 KB for the typical user), well under any WebView's
  //   per-origin localStorage cap. We write them first so they
  //   ALWAYS land — even if pass 2 runs out of room. A
  //   QuotaExceededError here bubbles up — after the rollback restores
  //   the pre-import workspace.
  //
  //   Pass 2: every history key (`resume-designer-history-*`). These
  //   are best-effort because they can be 100s of KB to MB per
  //   variant and routinely add up to 3-4 MB total. If any one of
  //   them exceeds the remaining quota, we skip just that key and
  //   keep going. Losing some undo/redo history is a fair trade for
  //   keeping the resumes themselves.
  //
  // Without this split, a one-pass loop in BTreeMap-alphabetical
  // order (which is what the Rust side produces) would write history
  // BEFORE job-descriptions — so a history blow-out would take the
  // critical JD key down with it.
  // Only write keys this app actually owns. A legitimate backup (produced by
  // exportFullBackup) contains owned keys only; any other key in an imported
  // file is corrupt or hostile, so we skip it rather than writing arbitrary
  // storage entries for this origin.
  const allEntries = Object.entries(parsed.keys);
  // `resume-designer-openrouter-key` is no longer an owned key — that is how the
  // credential was taken out of backups — so this filter drops it. Correct for a
  // backup FILE, and wrong for a same-machine migration, where a credential
  // arriving in the shared key would be lost before initSecretStore could move
  // it to the keychain, with the one-shot flag then reporting success.
  //
  // DEFENSIVE, not observed. The shipped Electron app cannot have written this
  // key: `electron/` was deleted 2026-05-25 (535b24c), OpenRouter arrived
  // 2026-05-30 (7a9e6d6), and the shared key itself only on 2026-07-15
  // (9c46406). That app stored anthropicKey/openaiKey/geminiKey and had no
  // OpenRouter credential of any kind. Kept anyway because it costs nothing
  // when the key is absent, and because this reads a database that already
  // exists on users' disks — being wrong about it loses a paid credential
  // behind a flag that never retries.
  const entries = allEntries.filter(
    ([k]) => isOwnedKey(k) || (keepCredential && k === OPENROUTER_KEY_KEY)
  );
  if (entries.length !== allEntries.length) {
    console.warn(
      `[backup] Ignored ${allEntries.length - entries.length} unrecognized key(s) in imported backup.`
    );
  }
  const nonHistory = entries.filter(([k]) => !k.startsWith(BACKUP_HISTORY_PREFIX));
  const history = entries.filter(([k]) => k.startsWith(BACKUP_HISTORY_PREFIX));

  const written = [];
  let historySkipped = 0;
  const droppedHere = [];
  // Format 1 restores the ACTIVE workspace only, so everything it writes belongs
  // to the workspace the mapping names — '' when there is none, the same
  // convention the collection uses for the open one.
  const activeWorkspace = getProfileMapping() ?? '';
  // Recorded for the same reason format 2 records its writes, plus one this
  // path has on its own: these go in under LOGICAL names, so the interceptor
  // DOES stamp them — and then the backup's own sync-state key lands later in
  // the same loop and replaces the table, erasing every stamp written before
  // it. Re-stamping at the end, after that key has landed, is what survives.
  const writes = [];
  const noteWrite = (k, value) => writes.push({
    logicalKey: splitPhysicalKey(k)?.logicalKey ?? k,
    value,
    previous: priorSnapshotFor(k, priorValues) ?? null,
  });
  let restoredUnits = new Map();
  try {
    for (const [k, v] of nonHistory) {
      let normalized = normalizeImportedValue(k, v, keepCredential);
      // The same rule format 2 follows, and this path needs it just as much:
      // a replacement restore is a deletion for every résumé it omits, and only
      // a tombstone makes that travel. `priorValues` is the pre-wipe snapshot
      // taken above, keyed the way this path writes — the active workspace's
      // blob, mapped or unprefixed depending on the install.
      if (k === STORAGE_KEY || splitPhysicalKey(k)?.logicalKey === STORAGE_KEY) {
        normalized = withTombstonesForDroppedVariants(
          priorSnapshotFor(k, priorValues), normalized, droppedHere,
        );
      }
      appStorage.setItem(k, normalized);
      written.push(k);
      noteWrite(k, normalized);
    }
    for (const [k, v] of history) {
      if (writeOwnedKeyOrSkip(k, v)) {
        written.push(k);
        noteWrite(k, v);
      } else historySkipped++;
    }
    // An envelope that carries NO blob at all is still a replacement, and still
    // a deletion of everything the workspace held. The write loop never sees it,
    // so the tombstones are synthesized from the snapshot alone — the same gap
    // format 2 had, and this path needed it stated separately for the same
    // reason it needed the rule stated separately in the first place.
    if (!nonHistory.some(([k]) => k === STORAGE_KEY || splitPhysicalKey(k)?.logicalKey === STORAGE_KEY)) {
      const key = activeWorkspace ? physicalKey(activeWorkspace, STORAGE_KEY) : STORAGE_KEY;
      const rebuilt = withTombstonesForDroppedVariants(priorValues.get(key), null, droppedHere);
      // See format 2: written whenever there is anything to write, because the
      // synthesized blob's default settings and userProfile are a reset in
      // their own right.
      if (rebuilt != null) {
        appStorage.setItem(STORAGE_KEY, rebuilt);
        written.push(STORAGE_KEY);
        noteWrite(key, rebuilt);
      }
    }
    // See format 2: stamped here, inside the try, so it rides the restore's own
    // flush and rolls back with it — and so the guard armed the moment this
    // returns cannot defer it into a queue the reload discards.
    // `written` holds the names this path PASSED to setItem, which are logical
    // for most keys, while the snapshot is keyed by address — so they are
    // compared in address form or every rewritten key reads as omitted.
    // Format 1 restores the ACTIVE workspace only, so that is the one list.
    clearOmittedSyncedKeys(
      priorValues,
      new Set(written.map((k) => mapKey(getProfileMapping(), k))),
      (address, value, profileId, logicalKey) => {
        appStorage.setItem(address, value);
        written.push(address);
        writes.push({ logicalKey, value, previous: priorValues.get(address) ?? null });
      },
      [activeWorkspace],
    );
    restoredUnits = stampRestoredWrites(
      new Map([[activeWorkspace, writes]]), (k) => written.push(k),
    );
  } catch (err) {
    rollbackWipedImport(written, priorValues);
    throw err;
  }

  // Same contract as the format-2 path: the snapshot must outlive this
  // function so importFullBackupDurably can restore on a failed flush.
  return {
    keysImported: entries.length - historySkipped,
    removedExistingKeys: priorValues.size,
    historySkipped,
    restoredUnits, // see the format-2 path
    rollback: () => rollbackWipedImport(written, priorValues),
    preRestore: priorValues, // see the format-2 path
    writtenKeys: written,
  };
}

/**
 * Durability wrapper for the real import paths (Settings → Data, legacy
 * migration). In cached/Tauri mode setItem/removeItem never throw — disk
 * failures surface only at flush() — so the sync import "succeeds" and drops
 * its snapshot while the scheduled drain can partially replace the user's
 * files: a disk-full restore could leave the durable store half-wiped after
 * restart with nothing to restore from. This keeps the snapshot alive
 * through a checked flush and rolls the store back (re-flushing the restore)
 * when durability fails. The sync core stays exported for validation and
 * for the merge path.
 */
export async function importFullBackupDurably(parsed, { keepCredential = false } = {}) {
  // Serialize restores: if one is already mid-flight (guard armed during its
  // flush await / success modal), bail before writing — otherwise these
  // synchronous writes get deferred by the active guard and then cleared.
  if (appStorage.isRestoreGuardActive()) {
    throw new Error('Another restore is already in progress — wait for it to finish before importing again.');
  }
  const { rollback, preRestore, writtenKeys, ...result } = importFullBackupFromEnvelope(parsed, { keepCredential });
  // The synchronous restore writes are done. Block every OTHER appStorage writer
  // from here until the reload, so a late async completion (chat/AI reply, tailor
  // draft, design-setting edit) can't clobber the just-restored keys during the
  // flush await and the interactive gap before the success overlay/reload. Pass
  // the pre-restore snapshot so reads stay isolated: a read-modify-write writer
  // (e.g. token tracking) sees the PRE-restore value, keeping its deferred write
  // replay-safe if this restore then rolls back.
  appStorage.beginRestoreGuard(preRestore, writtenKeys);
  if (!(await appStorage.flush())) {
    // Restore failed: stop guarding so the rollback writes reach storage, roll
    // back to the pre-import snapshot, then replay the writes skipped during the
    // window on top of it (so an in-flight completion isn't lost), and persist.
    appStorage.endRestoreGuard();
    rollback();
    appStorage.flushDeferredWrites();
    await appStorage.flush();
    throw new Error(
      'The backup could not be written to disk (is the disk full?). Your previous data was restored.'
    );
  }
  // Success: the restore is durable. Clear the pre-restore snapshot (no rollback
  // can follow, so reads should now see the restored cache) but KEEP the guard
  // armed. Interactive callers need CONTINUOUS ownership from here through their
  // modal + reload — releasing here would open an unguarded MICROTASK gap before
  // the awaiting caller reaches showImportSuccessAndReload(), during which a
  // queued AI/chat completion could clobber the restored cache. The boot Electron
  // migration (non-reloading) releases the guard itself right after this returns.
  appStorage.clearPreRestoreSnapshot();
  // Only NOW, and only the ANNOUNCEMENT — the stamp already rode the restore's
  // own flush. The restore is on disk, so the deletions it implies can be named
  // to the transport without the risk that a rollback takes the content back
  // while it has already uploaded their tombstones, which nothing can recall.
  commitRestoredUnits(result.restoredUnits);
  return result;
}

/**
 * Replace all owned storage keys with the contents of a backup JSON
 * file (Tools → Import Backup). Thin wrapper around
 * `importFullBackupFromEnvelope` that handles file-read + JSON-parse
 * with a distinct error message so the UI can distinguish "not JSON"
 * from "wrong envelope shape".
 */
export async function importFullBackup(file) {
  const text = await file.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Selected file is not valid JSON.');
  }
  return importFullBackupFromEnvelope(parsed);
}

/**
 * Non-destructive variant of envelope import: UNION the incoming
 * envelope into whatever is already in storage. Used by the
 * "Import from previous Electron version… → Merge" menu flow so a
 * user who already has Tauri-side data doesn't lose it when pulling
 * old variants in from the legacy LevelDB.
 *
 * Merge semantics, chosen to optimize for "user already has new work
 * I don't want to lose":
 *
 *   resume-designer-data
 *     - variants: union; if a variant ID collides, CURRENT wins
 *       (the user just created it; the legacy copy is presumed older)
 *     - currentVariantId, userProfile, settings: CURRENT wins for
 *       every top-level singleton. Surprising the user with a
 *       different selected variant or a profile rewrite is worse
 *       than leaving the legacy values un-imported.
 *
 *   resume-designer-job-descriptions
 *     - Union by `id`; current wins on collision. The shape can be
 *       either an array or an object map historically — we handle
 *       both (older Electron snapshots used objects; newer arrays).
 *
 *   resume-designer-history-<variantId>
 *     - Add legacy keys only if no current key by the same name
 *       (legacy history attached to a variant that the current state
 *       doesn't have wins; for collisions current wins).
 *
 *   Every other owned key (chat-threads, token-usage, theme, accent /
 *   font / spacing / photo / header-style settings, zoom, onboarding,
 *   edit-hint-dismissed)
 *     - Write incoming ONLY if not already present. Current wins.
 *
 * Returns { variantsAdded, jobDescriptionsAdded, settingsKeysAdded }
 * so the caller can build a precise "merged in X resumes, Y JDs"
 * confirmation toast.
 */
export function importFullBackupMerge(parsed, { keepCredential = false } = {}) {
  // Serialize restores (see importFullBackupDurably): don't run a merge while
  // another restore's guard is active, or its writes would be deferred + cleared.
  if (appStorage.isRestoreGuardActive()) {
    throw new Error('Another restore is already in progress — wait for it to finish before importing again.');
  }
  if (!parsed || parsed.backupFormat !== 1 ||
      !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(
      'Not an On Paper backup envelope (missing "backupFormat: 1").'
    );
  }
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (typeof v !== 'string') {
      throw new Error(`Invalid backup: key "${k}" must be a string value.`);
    }
  }

  let variantsAdded = 0;
  let jobDescriptionsAdded = 0;
  let settingsKeysAdded = 0;
  let historySkipped = 0;

  // Sort incoming so non-history keys are processed first. Same
  // reasoning as importFullBackupFromEnvelope: critical data gets
  // written while there's quota; history (the bulky stuff) goes
  // last and is allowed to fall off the end if it doesn't fit.
  // The mirror of the replace path's filter, and it was wrong in the OPPOSITE
  // direction: merge writes every key it is given, so an older backup carrying
  // `resume-designer-openrouter-key` would put the credential back in plaintext.
  // Kept only for a same-machine migration, dropped for a backup file.
  const sortedEntries = Object.entries(parsed.keys)
    .filter(([k]) => keepCredential || k !== OPENROUTER_KEY_KEY)
    .sort(([a], [b]) => {
    const aHist = a.startsWith(BACKUP_HISTORY_PREFIX);
    const bHist = b.startsWith(BACKUP_HISTORY_PREFIX);
    if (aHist === bHist) return 0;
    return aHist ? 1 : -1;
  });

  for (const [key, incomingValue] of sortedEntries) {
    const existingValue = appStorage.getItem(key);

    if (key === 'resume-designer-data') {
      // Strip a legacy credential from the INCOMING blob before either branch
      // below can put it in storage. Format-1 envelopes predate the keychain
      // move entirely, so they are the likeliest carriers — and both writes are
      // reachable: the wholesale adopt takes the blob verbatim, and the merge
      // keeps `incomingData.settings` whenever the existing blob has no
      // `settings` key of its own to shadow it.
      const incomingClean = withoutStoredCredentials(key, incomingValue, {
        keepOpenRouterKey: keepCredential,
      });
      // Merge the data blob: variants union (current wins on
      // collision), all top-level singletons preserved from current.
      let incomingData;
      try { incomingData = JSON.parse(incomingClean); }
      catch { continue; }  // malformed incoming — skip, don't poison existing

      if (!existingValue) {
        // No current data — just adopt the incoming wholesale.
        appStorage.setItem(key, incomingClean);
        variantsAdded += Object.keys(incomingData?.variants || {}).length;
        continue;
      }

      let existingData;
      try { existingData = JSON.parse(existingValue); }
      catch { continue; }  // malformed existing — leave alone, don't risk overwrite

      const existingVariants = existingData.variants || {};
      const incomingVariants = incomingData.variants || {};
      const mergedVariants = { ...incomingVariants, ...existingVariants };

      // Count only variants that were actually NEW (not present in current).
      for (const id of Object.keys(incomingVariants)) {
        if (!(id in existingVariants)) variantsAdded++;
      }

      const merged = {
        ...incomingData,                  // baseline = incoming's top-level shape
        ...existingData,                  // current wins for currentVariantId,
                                          //   userProfile, settings, etc.
        variants: mergedVariants,
      };
      // `settings` is replaced WHOLESALE by the current one just above, so
      // keeping the credential in the incoming blob was not enough on its own:
      // a user with existing Tauri-side data but no key, choosing "Merge
      // previous data", still lost the Electron credential before the
      // reload-time extraction could migrate it. Carry just that one field, and
      // only into a gap — current settings win everywhere else, and an existing
      // `openrouterKey` (including a deliberate '') is never overwritten.
      if (keepCredential) {
        const incomingKey = incomingData?.settings?.openrouterKey;
        const mergedSettings = merged.settings;
        if (incomingKey !== undefined
            && mergedSettings && typeof mergedSettings === 'object'
            && !('openrouterKey' in mergedSettings)) {
          merged.settings = { ...mergedSettings, openrouterKey: incomingKey };
        }
      }
      appStorage.setItem(key, JSON.stringify(merged));
    } else if (key === 'resume-designer-job-descriptions') {
      // Union job descriptions, dedupe by id. Handles both array and
      // legacy-object shapes (older Electron snapshots used objects).
      let incomingJds;
      try { incomingJds = JSON.parse(incomingValue); }
      catch { continue; }
      const incomingArr = Array.isArray(incomingJds)
        ? incomingJds
        : Object.values(incomingJds || {});

      if (!existingValue) {
        // ALWAYS write the normalized array shape — even when there's
        // nothing to merge with. jobDescriptions.js assumes an array
        // (uses .find / .unshift / .filter / spread on the parsed
        // value); writing the raw incoming object would crash the
        // next time the user opened the Job Descriptions panel.
        appStorage.setItem(key, JSON.stringify(incomingArr));
        jobDescriptionsAdded += incomingArr.length;
        continue;
      }

      let existingJds;
      try { existingJds = JSON.parse(existingValue); }
      catch { continue; }
      const existingArr = Array.isArray(existingJds)
        ? existingJds
        : Object.values(existingJds || {});
      const existingIds = new Set(existingArr.map((j) => j?.id).filter(Boolean));
      const toAdd = incomingArr.filter((j) => j?.id && !existingIds.has(j.id));
      jobDescriptionsAdded += toAdd.length;

      // Always emit as array (current canonical shape).
      const merged = [...existingArr, ...toAdd];
      appStorage.setItem(key, JSON.stringify(merged));
    } else {
      // All other owned keys (history, theme, settings, chat threads,
      // etc.): current wins. Only write incoming if no current value.
      // History keys are quota-tolerant (best-effort) since they can
      // easily blow past the localStorage cap; non-history fall back
      // to a normal setItem that propagates errors.
      //
      // The one branch of this function that does NOT go through
      // normalizeImportedValue, so the device-id strip is taken here too:
      // writing an incoming sync-state key into a gap is exactly the case that
      // adopts another machine's origin id wholesale. Today's only caller feeds
      // this an Electron envelope, which predates sync and cannot carry that key
      // — which is precisely why the guard belongs at the boundary rather than
      // resting on who happens to call it.
      if (existingValue === null) {
        if (key.startsWith(BACKUP_HISTORY_PREFIX)) {
          if (writeOwnedKeyOrSkip(key, incomingValue)) {
            settingsKeysAdded++;
          } else {
            historySkipped++;
          }
        } else {
          appStorage.setItem(key, withoutDeviceIdentity(key, incomingValue));
          settingsKeysAdded++;
        }
      }
    }
  }

  return { variantsAdded, jobDescriptionsAdded, settingsKeysAdded, historySkipped };
}

// Generate markdown from resume data
function generateMarkdown(data) {
  let md = '';
  
  // Header
  md += `# ${data.name}\n\n`;
  md += `**${data.tagline}**\n\n`;
  
  // Contact
  const contactParts = [];
  if (data.contact?.location) contactParts.push(data.contact.location);
  if (data.contact?.email) contactParts.push(data.contact.email);
  if (data.contact?.phone) contactParts.push(data.contact.phone);
  if (data.contact?.portfolio) contactParts.push(`Portfolio: ${data.contact.portfolio}`);
  if (data.contact?.instagram) contactParts.push(`Instagram: ${data.contact.instagram}`);
  if (contactParts.length > 0) {
    md += contactParts.join(' • ') + '\n\n';
  }
  
  // Summary
  if (data.summary) {
    md += `## Summary\n\n${data.summary}\n\n`;
  }
  
  // Sections (skills, highlights, etc.)
  if (data.sections && data.sections.length > 0) {
    for (const section of data.sections) {
      md += `## ${section.title}\n\n`;
      if (Array.isArray(section.content)) {
        if (section.type === 'list' || section.type === 'highlights') {
          for (const item of section.content) {
            md += `- ${item}\n`;
          }
        } else {
          md += section.content.join(' • ') + '\n';
        }
      }
      md += '\n';
    }
  }
  
  // Tools
  if (data.tools) {
    md += `## Tools\n\n${data.tools}\n\n`;
  }
  
  // Experience
  if (data.experience && data.experience.length > 0) {
    md += `## Experience\n\n`;
    for (const exp of data.experience) {
      // Dates go on their own bold line — the grammar the reader and
      // Templates/RESUME-TEMPLATE.md both document — so the round trip is lossless.
      md += `### ${exp.title} — ${exp.company}\n`;
      md += `**${exp.dates}**\n\n`;
      if (exp.bullets && exp.bullets.length > 0) {
        for (const bullet of exp.bullets) {
          md += `- ${bullet}\n`;
        }
      }
      md += '\n';
    }
  }
  
  // Education
  if (data.education && data.education.length > 0) {
    md += `## Education\n\n`;
    for (const edu of data.education) {
      md += `${edu}\n`;
    }
    md += '\n';
  }
  
  return md;
}

// Download file utility
export function downloadFile(content, filename, mimeType) {
  // iOS HAS NO DOWNLOAD. WKWebView does nothing with an `<a download>` blob
  // click — no file, no error, no sign that anything was asked for — so every
  // export here (résumé JSON, résumé Markdown, and the full backup, which all
  // funnel through this one call) silently produced nothing at all.
  //
  // Staged to a temp file and handed to the share sheet instead, which is the
  // same route the PDF export already takes and where "Save to Files" lives.
  // Fire-and-forget by necessity — this function's callers are synchronous —
  // so the failure path reports rather than throws into nobody's catch.
  if (shouldShareInsteadOfDownload()) {
    shareTextFile(content, filename).catch((error) => {
      console.error('[export] could not share the file:', error);
    });
    return;
  }
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Whether this build must share rather than download — iOS under the native
 * shell, which is the only place both halves are true.
 */
function shouldShareInsteadOfDownload() {
  // THE APP ON iOS, shell or no shell. Being unable to download is a property
  // of WKWebView, not of the shell: with `OP_NATIVE_SHELL=0` — a supported
  // control — or an install where the shell never came up, requiring it sent
  // every export straight back to the `<a download>` no-op, silently, in
  // exactly the fallback environment where the web UI is what the person is
  // using. Staging is a Tauri command and still works there; only the sheet is
  // missing, and `shareTextFile` says so rather than doing nothing.
  //
  // `isTauri` is the other half and it is not redundant: mobile Safari is also
  // iOS and CAN download, so the browser build must keep the ordinary path.
  return isTauri && isIOSPlatform();
}

/** Stage the text and hand it to the native share sheet, reporting a failure. */
async function shareTextFile(content, filename) {
  try {
    // ASKED BEFORE STAGING, not after. Staging writes a real file into the temp
    // directory, and with no shell to hand it to there is nothing left that
    // could clean it up — the share sheet's completion handler is what deletes
    // it, and that only exists once a sheet has been presented. Checking first
    // means the file is never created in the case that cannot use it.
    if (!isNativeShellAvailable()) throw new Error('the share sheet is unavailable');
    const staged = await stageTextForShare(filename, String(content));
    // A shell that disappeared during the staging await would leak this one
    // file. Nothing can be done about it from here — deleting by a
    // renderer-supplied path would be a wider hole than the leak — and iOS
    // reclaims the temp directory on its own.
    if (sharePdf(staged)) return;
    throw new Error('the share sheet is unavailable');
  } catch (error) {
    await notify({
      title: 'Export failed',
      type: 'error',
      message: `Could not share ${filename}: ${error.message || 'Unknown error'}.`,
    });
  }
}

// Import from JSON file
export async function importFromJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        // Basic validation
        if (!data.name || !data.contact) {
          throw new Error('Invalid resume JSON format');
        }
        resolve(data);
      } catch (err) {
        reject(new Error('Failed to parse JSON: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Import from Markdown file
export async function importFromMarkdown(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const markdown = e.target.result;
        const data = parseResume(markdown);
        resolve(data);
      } catch (err) {
        reject(new Error('Failed to parse Markdown: ' + err.message));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}

// Import file (auto-detect format)
export async function importFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  
  if (extension === 'json') {
    return importFromJSON(file);
  } else if (extension === 'md' || extension === 'markdown') {
    return importFromMarkdown(file);
  } else {
    throw new Error('Unsupported file format. Please use .json or .md files.');
  }
}

// Migrate built-in variants to storage (first-time setup)
export async function migrateBuiltInVariants(variants) {
  const storage = loadFromStorage();
  
  // Only migrate if no variants exist
  if (Object.keys(storage.variants).length > 0) {
    return false;
  }
  
  // In desktop builds we don't pre-load built-in variants since fetching from
  // bundled paths is handled differently in the webview — let the onboarding
  // wizard guide the user into creating or importing their own resumes.
  if (isTauri) {
    return false;
  }
  
  for (const variant of variants) {
    try {
      const response = await fetch(`/resumes/${variant.file}`);
      if (response.ok) {
        const markdown = await response.text();
        const data = parseResume(markdown);
        const id = generateId('variant');
        const now = new Date().toISOString();
        storage.variants[id] = {
          id,
          name: variant.name,
          data,
          builtIn: true,
          createdAt: now,
          updatedAt: now
        };
        
        // Set first as current
        if (!storage.currentVariantId) {
          storage.currentVariantId = id;
        }
      }
    } catch (e) {
      console.error(`Failed to migrate variant ${variant.name}:`, e);
    }
  }
  
  saveToStorage(storage);
  return true;
}
