/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (ProfileSwitcher).
 */
import { appStorage, setProfileMapping } from './appStorage.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, PHYSICAL_PREFIX,
  isOwnedKey, isSharedKey, isPhysicalKey, physicalKey, splitPhysicalKey,
} from './profileKeys.js';

// Deliberately OUTSIDE the `resume-` owned keyspace (like appStorage's
// __adoption_pending__) so backups never carry it.
const PROFILE_ADOPTION_MARKER = '__profile_adoption_pending__';

// A registry entry is valid iff id is a non-empty colon-free string (":" is
// the physical-key separator) and name is a string.
function isValidEntry(p) {
  return !!p && typeof p.id === 'string' && p.id !== '' && !p.id.includes(':')
    && typeof p.name === 'string';
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
// namespace. Idempotent: re-running overwrites the copy and skips
// already-moved (now missing) sources. Mapping must be INACTIVE here —
// physical targets pass through mapKey untouched either way.
function migrateUnprefixedKeys(profileId) {
  for (const k of appStorage.keys()) {
    if (!k || isSharedKey(k) || isPhysicalKey(k) || !isOwnedKey(k)) continue;
    const v = appStorage.getItem(k);
    if (v !== null) appStorage.setItem(physicalKey(profileId, k), v);
    appStorage.removeItem(k);
  }
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
    const inBlob = data?.settings?.openrouterKey;
    if (!inBlob) return;
    if (!appStorage.getItem(OPENROUTER_KEY_KEY)) appStorage.setItem(OPENROUTER_KEY_KEY, inBlob);
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
    // True first boot with profile support (or an adoption killed before the
    // registry write — no keys moved yet in that case). Marker FIRST, then
    // registry + pointer, THEN the key moves: a crash mid-move resumes
    // under the same id via the marker branch below.
    const id = generateProfileId();
    appStorage.setItem(PROFILE_ADOPTION_MARKER, '1');
    const profile = { id, name: adoptionProfileName(), emoji: '🙂', createdAt: new Date().toISOString() };
    saveRegistry([profile]);
    appStorage.setItem(ACTIVE_PROFILE_KEY, id);
    migrateUnprefixedKeys(id);
    appStorage.removeItem(PROFILE_ADOPTION_MARKER);
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
    migrateUnprefixedKeys(active); // resume interrupted adoption, same id
    appStorage.removeItem(PROFILE_ADOPTION_MARKER);
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
  const prefix = `${PHYSICAL_PREFIX}${id}:`;
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  saveRegistry(registry.filter((p) => p.id !== id));
}
