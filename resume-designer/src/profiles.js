/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (ProfileSwitcher).
 */
import { appStorage } from './appStorage.js';
import { PROFILES_KEY, ACTIVE_PROFILE_KEY, PHYSICAL_PREFIX } from './profileKeys.js';

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
