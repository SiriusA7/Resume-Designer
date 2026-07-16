/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (ProfileSwitcher).
 */
import { appStorage, setProfileMapping } from './appStorage.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY,
  isOwnedKey, isSharedKey, isPhysicalKey, isValidProfileId, physicalKey, splitPhysicalKey,
} from './profileKeys.js';

// Deliberately OUTSIDE the `resume-` owned keyspace (like appStorage's
// __adoption_pending__) so backups never carry it.
const PROFILE_ADOPTION_MARKER = '__profile_adoption_pending__';

// A registry entry is valid iff id is strictly alphanumeric (anything else —
// including '-' — could break the physical-key `--` separator parsing) and
// name is a string.
function isValidEntry(p) {
  return !!p && isValidProfileId(p.id) && typeof p.name === 'string';
}

export function loadRegistry() {
  try {
    const parsed = JSON.parse(appStorage.getItem(PROFILES_KEY) || 'null');
    if (!Array.isArray(parsed) || !parsed.length) return null;
    // ANY invalid entry marks the whole registry corrupt → null. Salvaging
    // the valid subset would silently orphan the invalid entry's workspace;
    // null instead routes boot through the registry rebuild, which recovers
    // every namespace found in storage.
    return parsed.every(isValidEntry) ? parsed : null;
  } catch {
    return null;
  }
}

function saveRegistry(registry) {
  appStorage.setItem(PROFILES_KEY, JSON.stringify(registry));
}

// Move every unprefixed per-profile owned key under the given profile's
// namespace, ONE KEY AT A TIME: copy → make it durable → delete the source,
// then move to the next. Mapping must be INACTIVE here — physical targets
// pass through mapKey untouched either way.
//
// Per-key (not copy-all-then-delete-all) because copying every source before
// deleting any would hold ~2× the data at peak. In browser passthrough mode
// appStorage writes straight to localStorage (a hard ~5MB cap), so doubling
// throws QuotaExceededError for anyone past ~half quota; moving one key at a
// time keeps the peak at ~1× (only the in-flight key is duplicated). Cached
// (Tauri) mode never hits that cap, but the per-key order costs nothing there.
//
// Crash-safety survives: the copy is flushed durable BEFORE its source is
// deleted, so a crash between the two leaves the source intact (the resume
// re-copies). Copy-if-ABSENT so a resume (marker survived a failed source
// delete, mapping already active last session) never overwrites edits the
// user has since saved to the physical key with the stale source.
async function migrateUnprefixedKeys(profileId) {
  let anyMoved = false;
  for (const k of appStorage.keys()) {
    if (!k || isSharedKey(k) || isPhysicalKey(k) || !isOwnedKey(k)) continue;
    const target = physicalKey(profileId, k);
    try {
      if (appStorage.getItem(target) === null) {
        const v = appStorage.getItem(k);
        if (v !== null) appStorage.setItem(target, v);
      }
    } catch (err) {
      // Passthrough localStorage quota (or any synchronous write failure). The
      // source is untouched; keep the marker and resume next boot — sources
      // already moved this pass have freed their space, so the retry proceeds.
      console.error('[profiles] adoption copy failed; will resume next boot:', err);
      await appStorage.flush();
      return false;
    }
    // Copy durable before the source delete (a crash between them in cached
    // mode would otherwise lose data), then free the source immediately.
    if (!(await appStorage.flush())) {
      console.error('[profiles] adoption copy did not reach disk — keeping sources; will resume next boot');
      return false;
    }
    appStorage.removeItem(k);
    anyMoved = true;
  }
  // Persist the final source delete; a failed flush keeps the marker so the
  // next boot resumes (copies are durable, so it just retries the deletes).
  return anyMoved ? appStorage.flush() : true;
}

// Best-effort profile name for adoption: the user's own name if they filled
// it in. Reads the UNPREFIXED blob (adoption runs before mapping activates).
function adoptionProfileName() {
  try {
    const data = JSON.parse(appStorage.getItem('resume-designer-data') || 'null');
    const name = data?.userProfile?.contactInfo?.fullName;
    return (typeof name === 'string' && name.trim()) ? name.trim() : 'My profile';
  } catch {
    return 'My profile';
  }
}

/**
 * One-time move of settings.openrouterKey (per-profile blob) to the shared
 * key, so one configured key serves every profile. Idempotent; an existing
 * shared key wins (never clobbered by a stale key from an imported backup).
 * Runs with mapping ACTIVE (reads the active profile's blob).
 */
export function extractSharedApiKey() {
  try {
    const raw = appStorage.getItem('resume-designer-data');
    if (!raw) return;
    const data = JSON.parse(raw);
    if (!data?.settings || !('openrouterKey' in data.settings)) return;
    const inBlob = data?.settings?.openrouterKey;
    if (inBlob && appStorage.getItem(OPENROUTER_KEY_KEY) === null) {
      appStorage.setItem(OPENROUTER_KEY_KEY, inBlob);
    }
    delete data.settings.openrouterKey;
    appStorage.setItem('resume-designer-data', JSON.stringify(data));
  } catch {
    // Corrupt blob: leave it for loadFromStorage()'s own error handling.
  }
}

/**
 * Boot entry point (main.js, after initAppStorage + Electron migration,
 * before markStorageReady). Resolves the active profile, running the
 * one-time adoption when needed, then activates key mapping.
 */
// Registry lost/corrupt while namespaced workspaces exist: rebuild it from
// the profile ids observed in physical keys. Names are best-effort (each
// namespace's own userProfile fullName). NEVER adopt-as-new in this state —
// that would orphan every namespaced key behind an empty fresh profile.
function rebuildRegistryFromKeys() {
  const ids = new Set();
  for (const k of appStorage.keys()) {
    const split = splitPhysicalKey(k);
    if (split && isOwnedKey(split.logicalKey)) ids.add(split.profileId);
  }
  if (!ids.size) return null;
  const registry = [...ids].map((id) => {
    let name = 'Recovered profile';
    try {
      const data = JSON.parse(appStorage.getItem(physicalKey(id, 'resume-designer-data')) || 'null');
      const n = data?.userProfile?.contactInfo?.fullName;
      if (typeof n === 'string' && n.trim()) name = n.trim();
    } catch { /* keep the fallback name */ }
    return { id, name, emoji: '🙂', createdAt: new Date().toISOString() };
  });
  saveRegistry(registry);
  return registry;
}

export async function ensureProfilesInitialized() {
  let registry = loadRegistry() || rebuildRegistryFromKeys();

  if (!registry) {
    // Marker reaches disk FIRST; registry + pointer cross their own durability
    // barrier while it holds; copies reach disk before source deletes; and the
    // marker is deleted only after migration succeeds. A crash at any barrier
    // therefore either leaves sources intact or resumes under the same id.
    const id = generateProfileId();
    appStorage.setItem(PROFILE_ADOPTION_MARKER, '1');
    if (!(await appStorage.flush())) {
      appStorage.removeItem(PROFILE_ADOPTION_MARKER);
      console.error('[profiles] adoption aborted: marker write did not reach disk');
      return null;
    }
    const profile = { id, name: adoptionProfileName(), emoji: '🙂', createdAt: new Date().toISOString() };
    saveRegistry([profile]);
    appStorage.setItem(ACTIVE_PROFILE_KEY, id);
    if (!(await appStorage.flush())) {
      // No migration has run yet, so aborting leaves sources untouched. The
      // queued registry/marker writes either land later (next boot resumes
      // under this id) or never land (next boot redoes a fresh adoption).
      // Identity mapping this session matches whatever is on disk.
      console.error('[profiles] adoption aborted: registry write did not reach disk');
      return null;
    }
    const moved = await migrateUnprefixedKeys(id);
    if (moved) {
      appStorage.removeItem(PROFILE_ADOPTION_MARKER);
      await appStorage.flush();
    }
    setProfileMapping(id);
    extractSharedApiKey();
    return id;
  }

  let active = getActiveProfileId();
  if (!registry.some((p) => p.id === active)) {
    active = registry[0].id;
    appStorage.setItem(ACTIVE_PROFILE_KEY, active);
  }
  if (appStorage.getItem(PROFILE_ADOPTION_MARKER)) {
    const moved = await migrateUnprefixedKeys(active); // resume interrupted adoption, same id
    if (moved) {
      appStorage.removeItem(PROFILE_ADOPTION_MARKER);
      await appStorage.flush();
    }
  }
  setProfileMapping(active);
  extractSharedApiKey();
  return active;
}

/**
 * Print window: activate mapping WITHOUT writes or adoption (readOnly store).
 * The main window has always completed adoption before a print window can
 * exist. A missing registry/pointer leaves mapping off — identical to the
 * pre-profile behavior.
 */
export function activateProfileMappingForPrint() {
  const registry = loadRegistry();
  const active = getActiveProfileId();
  if (registry && registry.some((p) => p.id === active)) setProfileMapping(active);
}

// Colon-free (":" separates the physical-key segments). createProfile
// re-rolls on the (unlikely) collision with an existing registry id.
export function generateProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function getActiveProfileId() {
  return appStorage.getItem(ACTIVE_PROFILE_KEY) || null;
}

export function setActiveProfile(id) {
  const registry = loadRegistry() || [];
  if (!registry.some((p) => p.id === id)) throw new Error(`Unknown profile id: ${id}`);
  appStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

export function createProfile({ name, emoji = '🙂' }) {
  const registry = loadRegistry() || [];
  let id = generateProfileId();
  while (registry.some((p) => p.id === id)) id = generateProfileId();
  const profile = { id, name: name || 'New profile', emoji, createdAt: new Date().toISOString() };
  saveRegistry([...registry, profile]);
  return profile;
}

export function renameProfile(id, { name, emoji }) {
  const registry = loadRegistry() || [];
  saveRegistry(registry.map((p) => (p.id === id
    ? { ...p, ...(name !== undefined ? { name } : {}), ...(emoji !== undefined ? { emoji } : {}) }
    : p)));
}

export function deleteProfile(id) {
  const registry = loadRegistry() || [];
  if (registry.length <= 1) throw new Error('Cannot delete the last profile.');
  if (id === getActiveProfileId()) throw new Error('Cannot delete the active profile — switch away first.');
  const prefix = physicalKey(id, '');
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  saveRegistry(registry.filter((p) => p.id !== id));
}

// Deliberately NOT async: an unknown id throws synchronously (programmer
// error), while the returned promise covers only the download itself.
export function exportProfileBackup(profileId, filename) {
  const registry = loadRegistry() || [];
  const profile = registry.find((p) => p.id === profileId);
  if (!profile) throw new Error(`Unknown profile id: ${profileId}`);
  const prefix = physicalKey(profileId, '');
  const keys = {};
  for (const k of appStorage.keys()) {
    if (!k || !k.startsWith(prefix)) continue;
    const logical = k.slice(prefix.length);
    if (!isOwnedKey(logical)) continue;
    const v = appStorage.getItem(k);
    if (v !== null) keys[logical] = v;
  }
  const envelope = {
    backupFormat: 2,
    kind: 'profile',
    createdAt: new Date().toISOString(),
    name: profile.name,
    emoji: profile.emoji,
    keys,
  };
  const slug = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'profile';
  const name = filename || `resume-designer-profile-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  // persistence.js imports this module, so pull downloadFile late to keep the
  // static module graph acyclic.
  return import('./persistence.js').then(({ downloadFile }) => {
    downloadFile(JSON.stringify(envelope, null, 2), name, 'application/json');
    return { keysExported: Object.keys(keys).length, filename: name };
  });
}

export function importProfileBackup(parsed) {
  if (!parsed || parsed.backupFormat !== 2 || parsed.kind !== 'profile'
      || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error('Not a Resume Designer profile export (expected backupFormat 2, kind "profile").');
  }
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (typeof v !== 'string') throw new Error(`Invalid profile export: key "${k}" must be a string value.`);
    if (!isOwnedKey(k)) throw new Error(`Invalid profile export: unrecognized key "${k}".`);
  }
  const profile = createProfile({
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported profile',
    emoji: typeof parsed.emoji === 'string' ? parsed.emoji : '🙂',
  });
  for (const [k, v] of Object.entries(parsed.keys)) {
    appStorage.setItem(physicalKey(profile.id, k), v);
  }
  return profile;
}
