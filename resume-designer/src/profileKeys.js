/**
 * Profile key classification — pure, no imports (both appStorage.js and
 * profiles.js depend on this, so it must sit below both in the import graph).
 *
 * Physical layout: per-profile logical keys live at
 * `resume-p--<profileId>--<logicalKey>`. The prefix starts with `resume-`
 * deliberately so appStorage's one-time localStorage→disk adoption
 * (OWNED_PREFIX = 'resume-') still matches namespaced keys.
 *
 * `--` is the separator because physical keys become FILENAMES in the Rust
 * disk store, whose validate_key allows only [A-Za-z0-9._-] (':' broke every
 * namespaced write on device). Parsing stays unambiguous because profile ids
 * are strictly alphanumeric (no '-'): the first `--` after the prefix always
 * ends the id. `resume-p--` cannot collide with logical keys ('resume-photo-*'
 * shares only 'resume-p').
 */

export const PROFILES_KEY = 'resume-designer-profiles';
export const ACTIVE_PROFILE_KEY = 'resume-designer-active-profile';
export const OPENROUTER_KEY_KEY = 'resume-designer-openrouter-key';
export const PHYSICAL_PREFIX = 'resume-p--';
const PHYSICAL_SEPARATOR = '--';

// Machine-level keys: one value per install, never namespaced by profile.
const SHARED_KEYS = new Set([
  'resume-designer-theme',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  'resume-designer-model-catalog',
  'resume-designer-electron-migration-attempted',
  'resume-designer-bridge-token', // one loopback server per install, not per profile
  PROFILES_KEY,
  ACTIVE_PROFILE_KEY,
  OPENROUTER_KEY_KEY,
]);

// The exhaustive owned-key list (moved verbatim from persistence.js; that
// module re-exports isOwnedKey so its importers keep working). Listed
// explicitly rather than via a wildcard so future contributors notice if
// they add a new key and forget to include it in the backup.
export const BACKUP_FIXED_KEYS = [
  // Core data
  'resume-designer-data',
  'resume-designer-job-descriptions',
  'resume-designer-applications',
  'resume-designer-chat-threads',
  'resume-designer-chat-history',          // legacy, harmless to round-trip
  'resume-designer-token-usage',
  'resume-designer-learned-answers',       // per-person Q&A the extension learns
  // UI / personalization
  'resume-designer-theme',
  'resume-designer-onboarding-complete',
  'resume-edit-hint-dismissed',
  'resume-header-style',
  'resume-accent-settings',
  'resume-font-settings',
  'resume-spacing-settings',
  'resume-photo-settings',
  'resume-zoom',
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  // Shared machine-level key, but listed here too (like theme/update-channel
  // above) so isOwnedKey() accepts it; isSharedKey short-circuits namespacing
  // and BACKUP_SHARED_KEYS routes it to the shared backup section.
  'resume-designer-bridge-token',
];
// Undo/redo history lives at this prefix, one key per variant.
export const BACKUP_HISTORY_PREFIX = 'resume-designer-history-';

export function isOwnedKey(key) {
  return BACKUP_FIXED_KEYS.includes(key) || key.startsWith(BACKUP_HISTORY_PREFIX);
}

export function isSharedKey(key) {
  return SHARED_KEYS.has(key);
}

export function isPhysicalKey(key) {
  return typeof key === 'string' && key.startsWith(PHYSICAL_PREFIX);
}

// Profile ids must match this exactly — the alphanumeric guarantee is what
// keeps splitPhysicalKey unambiguous (an id can never contain the `--`
// separator). Enforced at creation (generateProfileId), registry load, and
// backup import.
export function isValidProfileId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id);
}

export function physicalKey(profileId, logicalKey) {
  return `${PHYSICAL_PREFIX}${profileId}${PHYSICAL_SEPARATOR}${logicalKey}`;
}

export function splitPhysicalKey(key) {
  if (!isPhysicalKey(key)) return null;
  const rest = key.slice(PHYSICAL_PREFIX.length);
  const i = rest.indexOf(PHYSICAL_SEPARATOR);
  if (i < 1) return null;
  return { profileId: rest.slice(0, i), logicalKey: rest.slice(i + PHYSICAL_SEPARATOR.length) };
}

/**
 * Logical → physical for the active profile. Identity when mapping is
 * inactive (null id), for shared keys, for already-physical keys, and for
 * keys the app doesn't own (markers like __adoption_pending__).
 */
export function mapKey(profileId, key) {
  if (!profileId || isSharedKey(key) || isPhysicalKey(key) || !isOwnedKey(key)) return key;
  return physicalKey(profileId, key);
}
