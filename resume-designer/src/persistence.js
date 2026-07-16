/**
 * Persistence Layer
 * Handles appStorage auto-save and JSON/Markdown export/import
 */

import { store, generateId } from './store.js';
import { parseResume } from './parser.js';
import { isTauri } from './native.js';
import { appStorage } from './appStorage.js';
import { storageErrorToast } from './storageToast.js';

const STORAGE_KEY = 'resume-designer-data';
export const SETTINGS_UPDATED_EVENT = 'resume-designer-settings-updated';

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

// Get all variants
export function getVariants() {
  const storage = loadFromStorage();
  return storage.variants || {};
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
  const existingVariant = storage.variants[id];
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
  delete storage.variants[id];
  
  // If deleted variant was current, switch to another
  if (storage.currentVariantId === id) {
    const variantIds = Object.keys(storage.variants);
    storage.currentVariantId = variantIds.length > 0 ? variantIds[0] : null;
  }
  
  saveToStorage(storage);
  return storage.currentVariantId;
}

// Rename a variant
export function renameVariant(id, newName) {
  const storage = loadFromStorage();
  if (storage.variants[id]) {
    storage.variants[id].name = newName;
    storage.variants[id].updatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Save job analysis results for a specific variant
export function saveVariantAnalysis(variantId, analysis) {
  const storage = loadFromStorage();
  if (storage.variants[variantId]) {
    storage.variants[variantId].jobAnalysis = analysis;
    storage.variants[variantId].analysisUpdatedAt = new Date().toISOString();
    saveToStorage(storage);
  }
}

// Get job analysis results for a specific variant
export function getVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  const variant = storage.variants[variantId];
  return variant?.jobAnalysis || null;
}

// Clear job analysis results for a specific variant
export function clearVariantAnalysis(variantId) {
  const storage = loadFromStorage();
  if (storage.variants[variantId]) {
    storage.variants[variantId].jobAnalysis = null;
    storage.variants[variantId].analysisUpdatedAt = null;
    saveToStorage(storage);
  }
}

// Save settings. openrouterKey is machine-level (shared across profiles) and
// routes to its own key; everything else merges into the per-profile blob.
export function saveSettings(settings) {
  const { openrouterKey, ...rest } = settings;
  if (openrouterKey !== undefined) {
    appStorage.setItem(OPENROUTER_KEY_KEY, openrouterKey);
  }
  const storage = loadFromStorage();
  storage.settings = { ...storage.settings, ...rest };
  delete storage.settings.openrouterKey; // never persists in the blob anymore
  saveToStorage(storage);

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_UPDATED_EVENT, {
      detail: { settings: { ...storage.settings, openrouterKey: getSettings().openrouterKey } }
    }));
  }
}

// Get settings. The shared machine-level key is authoritative when PRESENT
// (null-check, not truthiness: an existing empty value means the user cleared
// the key and must mask any stale blob value); the blob is only a fallback
// for pre-extraction installs (adoption strips it on the next boot).
export function getSettings() {
  const storage = loadFromStorage();
  const s = storage.settings || DEFAULT_STORAGE.settings;
  const shared = appStorage.getItem(OPENROUTER_KEY_KEY);
  // Legacy OpenRouter-era guarantees preserved (see original comment).
  return {
    autoFallback: false,
    customModels: [],
    ...s,
    openrouterKey: shared !== null ? shared : (s.openrouterKey || ''),
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
  console.log('[Persistence] saveUserProfile called with:', profile);
  const storage = loadFromStorage();
  storage.userProfile = { ...DEFAULT_STORAGE.userProfile, ...profile };
  console.log('[Persistence] Saving userProfile:', storage.userProfile);
  const success = saveToStorage(storage);
  console.log('[Persistence] Save success:', success);
}

// Initialize persistence - connect store to auto-save
export function initPersistence(variantId) {
  store.onSave((data) => {
    if (variantId) {
      const storage = loadFromStorage();
      const variant = storage.variants[variantId];
      if (variant) {
        // The debounced auto-save is the path that persists ongoing EDITS.
        // When the write fails (browser passthrough at storage quota), the
        // user must hear about it once — otherwise everything typed from now
        // on silently evaporates on quit/reload.
        const ok = saveVariant(variantId, variant.name, data);
        if (!ok) {
          storageErrorToast(
            'Storage is full — your recent edits are NOT being saved. Free up '
            + 'space (delete resumes you no longer need) or export a backup now '
            + 'via Settings → Data → Export Backup.',
            { once: true },
          );
        }
      }
    }
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
} from './profileKeys.js';
import { loadRegistry, getActiveProfileId } from './profiles.js';

export { isOwnedKey }; // re-export: backupKeys.test.js and others import it from here

// Shared machine-level keys that belong in a backup (parity with the old
// BACKUP_FIXED_KEYS entries for theme/updates, plus the shared api key and the
// companion-bridge pairing token — one loopback server per install, so the
// token is not per-profile. model-catalog and migration flags stay
// cache/flag-only, never backed up).
const BACKUP_SHARED_KEYS = [
  'resume-designer-theme',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  'resume-designer-bridge-token',
  OPENROUTER_KEY_KEY,
];

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
 * user's résumés, not just registry/settings.
 * Returns { keysExported, filename } for the caller to surface in UI.
 */
export function exportFullBackup(filename) {
  const profiles = {};
  const shared = {};
  const activeId = getActiveProfileId();
  for (const k of appStorage.keys()) {
    if (!k) continue;
    const split = splitPhysicalKey(k);
    if (split && isOwnedKey(split.logicalKey)) {
      const v = appStorage.getItem(k);
      if (v !== null) ((profiles[split.profileId] ||= { keys: {} }).keys)[split.logicalKey] = v;
    } else if (BACKUP_SHARED_KEYS.includes(k)) {
      const v = appStorage.getItem(k);
      if (v !== null) shared[k] = v;
    }
  }
  // Recovery state: unprefixed owned keys (non-shared) are the active profile's
  // authoritative live data — edits since the failed adoption went here, so
  // they OVERRIDE any stale physical partial copy. A no-op in the normal case
  // (mapping on → no unprefixed owned keys exist).
  if (activeId) {
    for (const k of appStorage.keys()) {
      if (!k || splitPhysicalKey(k) || BACKUP_SHARED_KEYS.includes(k) || !isOwnedKey(k)) continue;
      const v = appStorage.getItem(k);
      if (v !== null) ((profiles[activeId] ||= { keys: {} }).keys)[k] = v;
    }
  }
  const backup = {
    backupFormat: 2,
    kind: 'full',
    createdAt: new Date().toISOString(),
    source: 'in-app',
    registry: loadRegistry() || [],
    activeProfile: getActiveProfileId(),
    shared,
    profiles,
  };
  const stamp = new Date().toISOString().slice(0, 10);
  const name = filename || `resume-designer-backup-${stamp}.json`;
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
// Legacy Electron stores can hold job descriptions as an id-keyed OBJECT map —
// a shape the Rust migration probe explicitly counts as valid and the envelope
// passes through verbatim — but jobDescriptions.js requires an array (it
// spreads/filters the parsed value). Canonicalize on import; anything else
// (already an array, unparseable) is written unchanged.
function normalizeImportedValue(key, value) {
  if (key !== 'resume-designer-job-descriptions') return value;
  try {
    const jd = JSON.parse(value);
    if (jd && typeof jd === 'object' && !Array.isArray(jd)) {
      return JSON.stringify(Object.values(jd));
    }
  } catch { /* leave malformed JSON as-is; initJobDescriptions handles it */ }
  return value;
}

function importFullBackupV2(parsed) {
  const registry = parsed.registry;
  const validRegistry = Array.isArray(registry) && registry.length > 0
    && registry.every((p) => p && isValidProfileId(p.id) && typeof p.name === 'string');
  const uniqueIds = validRegistry && new Set(registry.map((p) => p.id)).size === registry.length;
  if (!validRegistry || !uniqueIds) {
    throw new Error('Invalid format-2 backup: registry entries must have unique valid ids and string names.');
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
  const profileEntries = [];
  for (const { id: pid } of registry) {
    const entry = parsed.profiles[pid];
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
    if (typeof v !== 'string') {
      throw new Error(`Invalid backup: shared key "${k}" must be a string value.`);
    }
  }

  // Clean slate across ALL namespaces (full restore replaces everything).
  let removedExistingKeys = 0;
  for (const k of appStorage.keys()) {
    const split = splitPhysicalKey(k);
    const owned = split ? isOwnedKey(split.logicalKey) : isOwnedKey(k);
    if (owned || k === PROFILES_KEY || k === ACTIVE_PROFILE_KEY || k === OPENROUTER_KEY_KEY) {
      appStorage.removeItem(k);
      removedExistingKeys++;
    }
  }

  appStorage.setItem(PROFILES_KEY, JSON.stringify(registry));
  const active = registry.some((p) => p.id === parsed.activeProfile)
    ? parsed.activeProfile : registry[0].id;
  appStorage.setItem(ACTIVE_PROFILE_KEY, active);

  for (const [k, v] of Object.entries(parsed.shared || {})) {
    if (BACKUP_SHARED_KEYS.includes(k) && typeof v === 'string') appStorage.setItem(k, v);
  }

  // Same quota strategy as format 1, globally across every profile: critical
  // keys first, then bulky history best-effort. Per-profile passes could let
  // an early profile's history consume quota needed by a later profile's
  // critical data.
  let keysImported = 0;
  let historySkipped = 0;
  const nonHistory = profileEntries.filter(
    ({ logicalKey }) => !logicalKey.startsWith(BACKUP_HISTORY_PREFIX)
  );
  const history = profileEntries.filter(
    ({ logicalKey }) => logicalKey.startsWith(BACKUP_HISTORY_PREFIX)
  );
  for (const { physicalKey: key, logicalKey, value } of nonHistory) {
    appStorage.setItem(key, normalizeImportedValue(logicalKey, value));
    keysImported++;
  }
  for (const { physicalKey: key, value } of history) {
    if (writeOwnedKeyOrSkip(key, value)) keysImported++;
    else historySkipped++;
  }
  return { keysImported, removedExistingKeys, historySkipped };
}

export function importFullBackupFromEnvelope(parsed) {
  if (parsed && parsed.backupFormat === 2 && parsed.kind === 'full') {
    return importFullBackupV2(parsed);
  }
  if (!parsed || parsed.backupFormat !== 1 ||
      !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(
      'Not a Resume Designer backup envelope (missing "backupFormat: 1" or a format-2 "kind: full").'
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
  const removed = collectActiveOwnedKeys();
  for (const k of removed) appStorage.removeItem(k);

  // Two-pass write to handle the localStorage quota safely:
  //
  //   Pass 1: every NON-history key (resume-designer-data, JDs, chat
  //   threads, all settings keys). These are small in aggregate
  //   (~250 KB for the typical user), well under any WebView's
  //   per-origin localStorage cap. We write them first so they
  //   ALWAYS land — even if pass 2 runs out of room. A
  //   QuotaExceededError here would be unrecoverable and bubbles up.
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
  const entries = allEntries.filter(([k]) => isOwnedKey(k));
  if (entries.length !== allEntries.length) {
    console.warn(
      `[backup] Ignored ${allEntries.length - entries.length} unrecognized key(s) in imported backup.`
    );
  }
  const nonHistory = entries.filter(([k]) => !k.startsWith(BACKUP_HISTORY_PREFIX));
  const history = entries.filter(([k]) => k.startsWith(BACKUP_HISTORY_PREFIX));

  for (const [k, v] of nonHistory) {
    appStorage.setItem(k, normalizeImportedValue(k, v));
  }
  let historySkipped = 0;
  for (const [k, v] of history) {
    if (!writeOwnedKeyOrSkip(k, v)) historySkipped++;
  }

  return {
    keysImported: entries.length - historySkipped,
    removedExistingKeys: removed.length,
    historySkipped,
  };
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
export function importFullBackupMerge(parsed) {
  if (!parsed || parsed.backupFormat !== 1 ||
      !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error(
      'Not a Resume Designer backup envelope (missing "backupFormat: 1").'
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
  const sortedEntries = Object.entries(parsed.keys).sort(([a], [b]) => {
    const aHist = a.startsWith(BACKUP_HISTORY_PREFIX);
    const bHist = b.startsWith(BACKUP_HISTORY_PREFIX);
    if (aHist === bHist) return 0;
    return aHist ? 1 : -1;
  });

  for (const [key, incomingValue] of sortedEntries) {
    const existingValue = appStorage.getItem(key);

    if (key === 'resume-designer-data') {
      // Merge the data blob: variants union (current wins on
      // collision), all top-level singletons preserved from current.
      let incomingData;
      try { incomingData = JSON.parse(incomingValue); }
      catch { continue; }  // malformed incoming — skip, don't poison existing

      if (!existingValue) {
        // No current data — just adopt the incoming wholesale.
        appStorage.setItem(key, incomingValue);
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
      if (existingValue === null) {
        if (key.startsWith(BACKUP_HISTORY_PREFIX)) {
          if (writeOwnedKeyOrSkip(key, incomingValue)) {
            settingsKeysAdded++;
          } else {
            historySkipped++;
          }
        } else {
          appStorage.setItem(key, incomingValue);
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
      md += `### ${exp.title} — ${exp.company} **${exp.dates}**\n\n`;
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
