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

// The per-profile data blob. Named here because the backup sanitizer below has
// to recognise it, and this module is the one both exporters can reach.
const RESUME_DATA_KEY = 'resume-designer-data';

/**
 * Strip a legacy credential out of a `resume-designer-data` blob crossing a
 * backup boundary — used by BOTH the full-backup paths in persistence.js and
 * the per-profile paths in profiles.js.
 *
 * It lives here rather than beside either exporter because persistence.js
 * already imports profiles.js, so a helper owned by one of them cannot be
 * reached by the other without an import cycle. This module is below both by
 * construction (see the file header).
 *
 * The API key moved to the OS keychain and is deliberately no longer backup
 * data. Dropping it from the shared-key list is not enough on its own:
 * getSettings still reads `settings.openrouterKey` as the pre-extraction
 * fallback, and extractSharedApiKey only clears that field for the ACTIVE
 * profile, and only once its flush is durable. So an INACTIVE profile — exactly
 * the kind a per-profile export targets — can still carry the key inside this
 * blob, and copying it verbatim puts the paid credential into clear-text JSON.
 *
 * Applied on import too, so restoring an older backup cannot reintroduce a
 * plaintext credential that the next boot's extraction would promote into the
 * keychain.
 *
 * Returns the value untouched when there is nothing to strip, including when
 * the blob will not parse: that is still the user's data and has to round-trip,
 * and an unparseable blob is not one this app could have read a key out of.
 */
export function withoutLegacyCredential(logicalKey, value) {
  if (logicalKey !== RESUME_DATA_KEY || typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || !parsed.settings) return value;
    if (!('openrouterKey' in parsed.settings)) return value;
    delete parsed.settings.openrouterKey;
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

// Pre-OpenRouter provider credentials. The app moved to OpenRouter on
// 2026-05-30 (7a9e6d6), five days AFTER the Electron app was deleted
// (535b24c, 2026-05-25) — so any blob carrying these came from that app, and
// nothing in the current codebase reads them: grepping the tree for these three
// names matches comments only. They are dead weight, and the kind of dead
// weight that is a paid credential in clear text under app_data_dir.
const DEAD_PROVIDER_CREDENTIALS = ['anthropicKey', 'openaiKey', 'geminiKey'];

/**
 * Strip the pre-OpenRouter provider credentials out of a `resume-designer-data`
 * blob. Same shape as withoutLegacyCredential, and deliberately NOT part of it.
 *
 * That function is skipped whenever `keepCredential` is set, because the
 * OpenRouter key is one the current app still USES and a same-machine migration
 * has to carry it. These have no such claim: no code path reads them, so there
 * is nothing to preserve and no reason to exempt any caller. Folding them in
 * would have meant the Electron migration — the one path that actually carries
 * them — was the one path that skipped removing them.
 *
 * Deletes only the fields it knows about, leaving the rest of `settings`
 * untouched: this runs over the user's live data, not just over backups.
 */
export function withoutDeadProviderCredentials(logicalKey, value) {
  if (logicalKey !== RESUME_DATA_KEY || typeof value !== 'string') return value;
  try {
    const parsed = JSON.parse(value);
    const settings = parsed?.settings;
    // Object check before `in`, which throws on a string operand — a
    // hand-edited or imported blob can hold `settings: "…"`.
    if (!settings || typeof settings !== 'object') return value;
    const present = DEAD_PROVIDER_CREDENTIALS.filter((k) => k in settings);
    if (!present.length) return value;
    for (const k of present) delete settings[k];
    return JSON.stringify(parsed);
  } catch {
    // Unparseable: still the user's data, and not a blob this app could have
    // read a credential out of. Round-trips untouched, as above.
    return value;
  }
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
