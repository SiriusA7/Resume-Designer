/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (AccountSection).
 */
import { appStorage, setProfileMapping } from './appStorage.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY,
  isOwnedKey, isSharedKey, isPhysicalKey, isValidProfileId, physicalKey, splitPhysicalKey,
  withoutLegacyCredential, withoutDeadProviderCredentials,
} from './profileKeys.js';

// Starts with `resume-` ON PURPOSE so appStorage's one-time localStorage→disk
// adoption (OWNED_PREFIX = 'resume-') copies it too — otherwise an incomplete
// profile adoption that spans a passthrough→disk transition would lose the
// marker, and the next boot would treat adoption as complete and map onto a
// stale/absent physical copy. It is NOT an owned key (not in BACKUP_FIXED_KEYS,
// not a history key), so isOwnedKey is false → backups never carry it and the
// key mapping never namespaces it.
const PROFILE_ADOPTION_MARKER = 'resume-profile-adoption-pending';

// Fired on the window after a registry mutation that stays on the current page
// (rename; the switch/create paths reload instead). Header chrome that reads
// the registry independently — the AccountAvatar — listens to re-render, so a
// renamed active profile updates its initials/label without a reload.
export const PROFILES_CHANGED_EVENT = 'rd:profiles-changed';

// A degraded init can run mapping-off WITHOUT a persisted marker (the marker
// write itself failed, or the resolver threw unexpectedly). The marker check
// alone would then report "not pending" and unlock profile creation — which
// would persist a fresh registry over the un-adopted unprefixed workspace and
// hide it behind an empty namespace after reload. Session-scoped on purpose:
// the next boot re-runs init and either succeeds or re-enters this state.
let initDegraded = false;

// True while a first-profile adoption is incomplete — marker persisted, OR
// this session's init degraded without managing to persist one (see above).
// Mapping is left inactive in both states (see ensureProfilesInitialized).
// The UI hides the profile switcher and blocks create/import in this recovery
// state: switching/creating a profile would change the active id, and the
// next boot's resume would then move the still-unprefixed live workspace into
// the WRONG profile, leaving the original one empty.
export function isAdoptionPending() {
  return initDegraded || appStorage.getItem(PROFILE_ADOPTION_MARKER) !== null;
}

// True when any physical per-profile workspace exists in storage. Used by the
// legacy-migration guard: physical namespaces prove this store was profiled
// even when the registry file is lost or corrupt (loadRegistry() → null) —
// rebuildRegistryFromKeys() recovers them at profile-resolve time, so nothing
// may wipe them before that runs.
export function hasProfileNamespaces() {
  return appStorage.keys().some((k) => {
    const split = splitPhysicalKey(k);
    return !!split && isOwnedKey(split.logicalKey);
  });
}

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
    if (!parsed.every(isValidEntry)) return null;
    // Coerce a non-string emoji (hand-edited / corrupt storage) to the default:
    // the switcher renders it directly as a React child, so a non-string would
    // throw and blank the app. Defense in depth beyond the backup-restore check.
    return parsed.map((p) => (typeof p.emoji === 'string' ? p : { ...p, emoji: '🙂' }));
  } catch {
    return null;
  }
}

function saveRegistry(registry) {
  appStorage.setItem(PROFILES_KEY, JSON.stringify(registry));
}

// Adoption is a two-phase move, split so that NO unprefixed source is ever
// deleted while profile mapping is inactive. That ordering is load-bearing:
// while adoption is incomplete the app runs mapping-OFF and reads/writes the
// unprefixed keys, so a source deleted early would read back as missing (data
// looks lost) and a later resume could drop edits made in that window. Phase 1
// copies; the caller deletes only after every copy is durable AND right before
// it activates mapping (in finishAdoption).
//
// COPY-ALWAYS (not copy-if-absent): the unprefixed source is authoritative
// while adoption is incomplete — the user edits it mapping-off — so it must
// overwrite any physical copy left by an earlier failed pass.
//
// Phase 1 copies every source WITHOUT deleting it, so peak storage doubles
// briefly. That is unavoidable if the split above is to be prevented; in
// browser passthrough mode the doubling can throw QuotaExceededError, which is
// CAUGHT here — sources stay intact, mapping stays off, and the boot retries
// later (a graceful fallback, which is exactly what the storage-safety review
// accepted as the alternative to a non-doubling move).
async function copyUnprefixedToPhysical(profileId) {
  for (const k of appStorage.keys()) {
    if (!k || isSharedKey(k) || isPhysicalKey(k) || !isOwnedKey(k)) continue;
    const v = appStorage.getItem(k);
    if (v === null) continue;
    try {
      appStorage.setItem(physicalKey(profileId, k), v);
    } catch (err) {
      // Roll back EVERY physical copy for this profile before bailing — the
      // ones written in this pass AND any left by an earlier failed pass. In
      // passthrough mode the copy DOUBLES storage, so a partial set of leaked
      // duplicates pins localStorage at quota (flush() reclaims nothing there),
      // and every restart's retry then throws against the same full store and
      // fails again — the authoritative unprefixed workspace can no longer save
      // either. Removing the duplicates frees the space for the next boot; the
      // unprefixed sources are authoritative and untouched.
      console.error('[profiles] adoption copy failed; rolling back partial copies:', err);
      const prefix = physicalKey(profileId, '');
      for (const pk of appStorage.keys()) {
        if (pk && pk.startsWith(prefix)) {
          try { appStorage.removeItem(pk); } catch { /* keep going */ }
        }
      }
      await appStorage.flush();
      return false;
    }
  }
  // Every copy must be durable before the caller deletes any source.
  return appStorage.flush();
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
 *
 * Visits EVERY profile's blob, not only the active one. The key is shared
 * across profiles by design, so a credential left in an inactive profile's
 * blob is a stale duplicate — but it is a stale duplicate sitting in clear text
 * under app_data_dir, which is the exposure this whole module exists to close.
 * It could linger there indefinitely, since nothing visits a profile that is
 * never switched to. `withoutLegacyCredential` already sanitized these blobs at
 * the BACKUP boundary; that kept the key out of exported files and did nothing
 * about the file it is actually stored in.
 *
 * Active profile first, so its key is the one that wins the shared slot when
 * more than one blob still holds a credential — it is the one the user is
 * demonstrably using. Inactive keys are adopted rather than merely deleted when
 * no shared key exists yet, because deleting could destroy the user's only
 * credential; the migration invariant applies to them exactly as it does to the
 * active blob.
 */
export async function extractSharedApiKey() {
  // The active profile, however it currently resolves: the mapped physical key
  // with mapping on, the unprefixed key with mapping off (adoption degraded).
  // FIRST, and its result is the one kept: the active profile is the authority
  // on the user's current intent, including an intent to have no key.
  let stranded = await extractCredentialFromBlob('resume-designer-data');
  // Snapshot: the shared-key write below adds a key mid-sweep.
  for (const key of appStorage.keys()) {
    const split = splitPhysicalKey(key);
    if (split?.logicalKey === 'resume-designer-data') {
      const left = await extractCredentialFromBlob(key);
      // `=== null` — a genuine absence — and NOT falsiness. An active-profile
      // result of `''` is a Clear that could not be consolidated, and it is an
      // ANSWER: treating it as absence let an older key from a profile the user
      // has not opened fill the gap and undo the Clear. The inactive blobs are
      // still swept, they just cannot outvote the active profile.
      if (stranded === null) stranded = left;
    }
  }
  return stranded;
}

/**
 * Remove the dead pre-OpenRouter provider credentials from EVERY profile blob.
 *
 * Sanitising on import only helps FUTURE migrations. The Electron import has
 * been shipping since 2026-05-27, so anyone who already took it is carrying
 * `anthropicKey` / `openaiKey` / `geminiKey` in clear text under app_data_dir
 * right now — and nothing will ever visit them, precisely because nothing reads
 * them: no code path has a reason to rewrite the blob and drop them. Left
 * alone, they stay for the life of the install.
 *
 * Sweeps the same key set as extractSharedApiKey, and deliberately does NOT
 * reuse extractCredentialFromBlob: that returns early on a blob with no
 * `openrouterKey`, which is exactly the blob this is for.
 *
 * Synchronous and best-effort, unlike the credential extraction beside it.
 * Nothing here is a durability barrier — the whole operation is a DELETION of
 * data nothing depends on, so there is no "strip only after the new copy is
 * durable" rule to obey. A blob storage refuses to rewrite is simply retried on
 * the next boot.
 */
export function stripDeadProviderCredentials() {
  const keys = ['resume-designer-data'];
  for (const key of appStorage.keys()) {
    const split = splitPhysicalKey(key);
    if (split?.logicalKey === 'resume-designer-data') keys.push(key);
  }
  for (const key of keys) {
    try {
      const raw = appStorage.getItem(key);
      if (raw === null) continue;
      // Always the LOGICAL key: the helper matches on it, and every key here is
      // a `resume-designer-data` blob by construction.
      const cleaned = withoutDeadProviderCredentials('resume-designer-data', raw);
      if (cleaned === raw) continue;
      appStorage.setItem(key, cleaned);
    } catch {
      // Storage refused this one (passthrough quota). The next boot retries;
      // nothing else depends on it having happened.
    }
  }
}

/**
 * Move one blob's credential into the shared key and strip it. Per-blob rather
 * than per-sweep error handling, so one corrupt profile cannot stop the others
 * being sanitized.
 *
 * Returns the credential this call could not consolidate, or null when there is
 * nothing to report. A caught failure used to look identical to success from
 * outside, so boot went on to report protected storage while a readable copy sat
 * in the blob and getSettings quietly served it — see main.js.
 *
 * `''` is a RESULT, not an absence. It means the user's Clear could not be
 * consolidated, and collapsing it to null (via `inBlob || null`) let the caller
 * carry on scanning inactive profiles and adopt an older key out of one — the
 * Clear undone by a profile the user has not opened. Every caller must treat
 * `null` and `''` as different answers.
 */
async function extractCredentialFromBlob(blobKey) {
  let data;
  try {
    const raw = appStorage.getItem(blobKey);
    if (!raw) return null;
    data = JSON.parse(raw);
  } catch {
    // Corrupt blob: leave it for loadFromStorage()'s own error handling. NOT a
    // stranded credential — a blob this app cannot parse is not one it read a
    // key out of.
    return null;
  }
  // `in` on a truthy NON-object throws a TypeError, and this line sits outside
  // the parse catch since the catch was narrowed to distinguish a corrupt blob
  // from a storage refusal. A hand-edited or imported blob with
  // `settings: "…"` would therefore escape here — and boot awaits this before
  // initSecretStore, so one malformed profile aborted the rest of init rather
  // than being left to loadFromStorage's own fallback.
  const settings = data?.settings;
  if (!settings || typeof settings !== 'object') return null;
  if (!('openrouterKey' in settings)) return null;
  const inBlob = settings.openrouterKey;
  try {
    // PRESENCE, not truthiness. Reaching here means the field is present, so an
    // empty value is the user's explicit Clear and has to become the shared
    // masking sentinel. Skipping it deleted the Clear and left no shared entry
    // — after which the sweep below reached an inactive blob holding an older
    // paid key, found nothing stored, and resurrected the credential the user
    // had deleted. The same truthiness assumption did the same damage on the
    // keychain migration path earlier in this PR.
    if (appStorage.getItem(OPENROUTER_KEY_KEY) === null) {
      appStorage.setItem(OPENROUTER_KEY_KEY, inBlob);
    }
    // Cached mode reports write failures only at flush time. Never strip
    // the blob copy until the shared key is DURABLE — if the shared-key
    // file write failed while the (smaller) blob rewrite succeeded, the
    // only durable copy of the credential would vanish on restart. On a
    // failed flush the blob keeps the key and the next boot retries.
    //
    // The barrier gates the STRIP, not the write, which is why it sits
    // outside the `=== null` check. A shared value already present may be
    // this boot's own PENDING write from an earlier call whose flush failed:
    // getItem serves the write-behind cache, so a queued value and a durable
    // one read identically. Gating only the branch that wrote made a second
    // call skip the barrier and strip the blob against a value still sitting
    // in the cache — the one durable copy gone if the retry never lands.
    // Costs nothing in steady state: once extraction has run there is no
    // `openrouterKey` in the blob and the function returns above.
    if (!(await appStorage.flush())) return inBlob;
    delete data.settings.openrouterKey;
    appStorage.setItem(blobKey, JSON.stringify(data));
  } catch {
    // A storage refusal, not a corrupt blob: passthrough setItem throws
    // synchronously when localStorage is full. The blob still holds a readable
    // credential — or a readable CLEAR — and saying which is the whole point of
    // this return value. `inBlob` verbatim, never `inBlob || null`: an
    // unconsolidated '' is the user's Clear and must not read as absence.
    return inBlob;
  }
  return null;
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

/**
 * Boot entry point. Wraps the resolver so that ANY unexpected storage failure
 * during adoption (e.g. a passthrough QuotaExceededError thrown synchronously by
 * the very first marker/registry setItem when localStorage is already full)
 * NEVER escapes: main.js awaits this inside the try whose finally opens the
 * React gate, so a throw here would skip the rest of init() and every reload
 * would repeat against the same full store. On failure we degrade to mapping-off
 * — the app runs on the unprefixed workspace and a later boot retries.
 */
export async function ensureProfilesInitialized() {
  initDegraded = false;
  try {
    return await resolveActiveProfile();
  } catch (err) {
    console.error('[profiles] adoption failed unexpectedly; running on unprefixed data:', err);
    initDegraded = true; // markerless recovery state — see isAdoptionPending
    setProfileMapping(null);
    return null;
  }
}

async function resolveActiveProfile() {
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
      initDegraded = true; // markerless recovery state — see isAdoptionPending
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
    if (!(await finishAdoption(id))) {
      // Copies didn't all land (browser quota, or a Tauri disk failure). Leave
      // mapping INACTIVE so this session reads/writes the still-intact
      // unprefixed sources (pre-profile behavior); the marker persists so a
      // later boot resumes once space/disk allows. Activating mapping here would
      // point reads at an incomplete namespace and hide the user's resumes.
      console.warn('[profiles] adoption incomplete — running on unprefixed data this session');
      return id;
    }
    return id;
  }

  let active = getActiveProfileId();
  if (!registry.some((p) => p.id === active)) {
    active = registry[0].id;
    appStorage.setItem(ACTIVE_PROFILE_KEY, active);
  }
  if (appStorage.getItem(PROFILE_ADOPTION_MARKER)) {
    if (!(await finishAdoption(active))) { // resume interrupted adoption, same id
      console.warn('[profiles] adoption incomplete — running on unprefixed data this session');
      return active; // keep mapping off, run on the unprefixed sources
    }
    return active;
  }
  setProfileMapping(active);
  await extractSharedApiKey();
  return active;
}

/**
 * Complete an in-flight adoption for `profileId`: copy every unprefixed source
 * to its physical key, and only once every copy is durable delete the sources
 * (mapping still off) and activate mapping. Returns true on success (mapping is
 * now active), false if copies didn't all land (caller keeps mapping off and
 * the marker for a retry). The strict "delete only after all copies durable,
 * immediately before activating mapping" order is what prevents a mapping-off
 * session from ever seeing a half-migrated split.
 */
async function finishAdoption(profileId) {
  if (!(await copyUnprefixedToPhysical(profileId))) return false;

  // Delete the now-copied sources (mapping still off → removeItem hits the
  // unprefixed keys). Track them so we can restore on a non-durable delete.
  const sourceKeys = [];
  for (const k of appStorage.keys()) {
    if (!k || isSharedKey(k) || isPhysicalKey(k) || !isOwnedKey(k)) continue;
    sourceKeys.push(k);
    appStorage.removeItem(k);
  }
  if (!(await appStorage.flush())) {
    // The source deletes didn't reach disk. Do NOT activate mapping: the marker
    // lingers, and a mapping-on session's edits to the physical keys would be
    // overwritten by the still-present unprefixed sources on the next boot's
    // copy-always. Restore the sources to the cache from their durable physical
    // copies so this mapping-off session still reads them, keep the marker, and
    // retry on a later boot.
    for (const k of sourceKeys) {
      const v = appStorage.getItem(physicalKey(profileId, k));
      if (v !== null) appStorage.setItem(k, v);
    }
    await appStorage.flush();
    console.error('[profiles] adoption source cleanup did not reach disk; will retry next boot');
    return false;
  }

  // Sources are DURABLY gone — no stale source can clobber the physical keys
  // now, so it is finally safe to activate mapping. The marker removal is
  // best-effort: if its flush fails the marker lingers, but the next boot finds
  // no sources to copy and cleanly finalizes (removes the marker).
  setProfileMapping(profileId);
  await extractSharedApiKey();
  appStorage.removeItem(PROFILE_ADOPTION_MARKER);
  await appStorage.flush();
  return true;
}

/**
 * Print window: activate mapping WITHOUT writes or adoption (readOnly store).
 * A missing registry/pointer leaves mapping off — identical to the pre-profile
 * behavior. Also leave it off while an adoption is mid-recovery: the main
 * window is running mapping-off on the unprefixed live workspace, so the print
 * window must read the same unprefixed data — mapping to the (stale or absent)
 * physical copy would capture a blank or stale PDF.
 */
export function activateProfileMappingForPrint() {
  const registry = loadRegistry();
  const active = getActiveProfileId();
  if (registry && registry.some((p) => p.id === active) && !isAdoptionPending()) {
    setProfileMapping(active);
  }
}

// Cryptographically-secure base-36 suffix — replaces Math.random so CodeQL's
// js/insecure-randomness rule stays quiet, and matches store.js's convention.
// crypto.getRandomValues has no secure-context requirement, so it works in both
// the Tauri custom-scheme webview and the browser build. base-36 of a Uint32 is
// strictly [0-9a-z]: alphanumeric AND lowercase — exactly what isValidProfileId
// requires and what the backup case-fold-uniqueness check depends on.
function randomIdSuffix() {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return a[0].toString(36) + a[1].toString(36);
}

// Alphanumeric + lowercase ("--" separates the physical-key segments, and the
// id must never contain it). createProfile re-rolls on the (astronomically
// unlikely) collision with an existing registry id.
export function generateProfileId() {
  return `p${Date.now().toString(36)}${randomIdSuffix()}`;
}

export function getActiveProfileId() {
  return appStorage.getItem(ACTIVE_PROFILE_KEY) || null;
}

export function setActiveProfile(id) {
  const registry = loadRegistry() || [];
  if (!registry.some((p) => p.id === id)) throw new Error(`Unknown profile id: ${id}`);
  appStorage.setItem(ACTIVE_PROFILE_KEY, id);
}

/**
 * Point the app at `id` and make the pointer DURABLE before the caller
 * reloads. If the flush fails (disk full / permissions), restore `restoreId`
 * and report false: reloading would boot from the stale on-disk pointer (the
 * switch appears to undo itself), and the pending in-cache pointer would
 * otherwise ride along with a LATER successful flush and switch some future
 * boot unexpectedly. The restore write coalesces over the failed one, so the
 * cache and (eventually) disk both settle on `restoreId`.
 */
export async function activateProfileDurably(id, restoreId) {
  // A backup restore is mid-flight: the guard would only DEFER this pointer write
  // (flush() then reports false success), and the deferred pointer is discarded on
  // the restore's reload — so the switch would silently no-op. Refuse it instead.
  if (appStorage.isRestoreGuardActive()) return false;
  setActiveProfile(id);
  if (await appStorage.flush()) return true;
  setActiveProfile(restoreId);
  await appStorage.flush();
  return false;
}

export function createProfile({ name, emoji = '🙂' }) {
  // During a restore the registry write would only be deferred (and discarded on
  // reload); throw so callers (incl. importProfileBackup) surface it rather than
  // report a create that never persists. Matches the quota-throw contract.
  if (appStorage.isRestoreGuardActive()) {
    throw new Error('A backup restore is in progress — wait for it to finish before creating a profile.');
  }
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

/**
 * Rename `id` and make it DURABLE (same contract as the other *Durably
 * helpers): in cached mode registry-write failures surface only at flush(),
 * so a fire-and-forget rename could close the editor showing a name that
 * reverts after restart. On a failed flush the previous registry is restored
 * and false returned so the caller keeps the editor open.
 */
export async function renameProfileDurably(id, patch) {
  if (appStorage.isRestoreGuardActive()) return false; // see activateProfileDurably: a deferred write can't be reported durable
  const registryBefore = loadRegistry() || [];
  renameProfile(id, patch);
  if (await appStorage.flush()) return true;
  try { saveRegistry(registryBefore); } catch { /* keep going */ }
  await appStorage.flush();
  return false;
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

/**
 * Delete `id` and make it DURABLE. deleteProfile() only mutates the
 * write-behind cache in Tauri mode — disk failures surface at flush() — so a
 * fire-and-forget delete could report success and then resurrect the profile
 * (or leave orphaned workspace files) after a restart. On a failed flush the
 * pre-delete snapshot (registry entry + the profile's physical keys) is
 * restored and false returned, so callers keep the profile listed instead of
 * announcing a deletion that never reached disk.
 */
export async function deleteProfileDurably(id) {
  if (appStorage.isRestoreGuardActive()) return false; // see activateProfileDurably: a deferred write can't be reported durable
  const registryBefore = loadRegistry() || [];
  const prefix = physicalKey(id, '');
  const snapshot = new Map();
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) snapshot.set(k, appStorage.getItem(k));
  }
  deleteProfile(id);
  if (await appStorage.flush()) return true;
  for (const [k, v] of snapshot) {
    try { appStorage.setItem(k, v); } catch { /* keep going */ }
  }
  try { saveRegistry(registryBefore); } catch { /* keep going */ }
  await appStorage.flush();
  return false;
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
    // A per-profile export is the WORST case for a blob-held credential: it
    // targets a named profile, typically an inactive one, and
    // extractSharedApiKey only ever clears that field for the active profile.
    if (v !== null) keys[logical] = withoutLegacyCredential(logical, v);
  }
  // Incomplete-adoption recovery state (mapping off): the ACTIVE profile's live
  // data still sits under unprefixed owned keys, so include them here too —
  // otherwise a per-profile export of the recovering profile is empty. Only the
  // active profile can have unprefixed data (it is the one being adopted), and
  // it is authoritative (overrides any stale physical partial copy). A no-op in
  // the normal mapping-on case, where no unprefixed owned keys exist.
  if (profileId === getActiveProfileId()) {
    for (const k of appStorage.keys()) {
      if (!k || splitPhysicalKey(k) || isSharedKey(k) || !isOwnedKey(k)) continue;
      const v = appStorage.getItem(k);
      if (v !== null) keys[k] = withoutLegacyCredential(k, v);
    }
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
  const name = filename || `on-paper-profile-${slug}-${new Date().toISOString().slice(0, 10)}.json`;
  // persistence.js imports this module, so pull downloadFile late to keep the
  // static module graph acyclic.
  return import('./persistence.js').then(({ downloadFile }) => {
    downloadFile(JSON.stringify(envelope, null, 2), name, 'application/json');
    return { keysExported: Object.keys(keys).length, filename: name };
  });
}

// Remove a just-imported profile's partial keys and its registry entry so a
// failed import never leaves a half-written workspace the user can switch into.
function rollbackImportedProfile(id) {
  const prefix = physicalKey(id, '');
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  saveRegistry((loadRegistry() || []).filter((p) => p.id !== id));
}

export async function importProfileBackup(parsed) {
  if (!parsed || parsed.backupFormat !== 2 || parsed.kind !== 'profile'
      || !parsed.keys || typeof parsed.keys !== 'object') {
    throw new Error('Not an On Paper profile export (expected backupFormat 2, kind "profile").');
  }
  for (const [k, v] of Object.entries(parsed.keys)) {
    if (typeof v !== 'string') throw new Error(`Invalid profile export: key "${k}" must be a string value.`);
    if (!isOwnedKey(k)) throw new Error(`Invalid profile export: unrecognized key "${k}".`);
  }
  const profile = createProfile({
    name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : 'Imported profile',
    emoji: typeof parsed.emoji === 'string' ? parsed.emoji : '🙂',
  });
  try {
    for (const [k, v] of Object.entries(parsed.keys)) {
      // Profile exports written before the strip still carry the credential;
      // sanitize on the way in so it cannot land back in plaintext storage.
      appStorage.setItem(physicalKey(profile.id, k), withoutLegacyCredential(k, v));
    }
  } catch (err) {
    // Browser passthrough: setItem throws synchronously at localStorage quota
    // (bulky history keys are the usual trigger) after createProfile already
    // persisted the registry entry. Roll back and surface the failure.
    rollbackImportedProfile(profile.id);
    throw err;
  }
  // Cached (Tauri) disk store: setItem never throws on disk-full/permission —
  // that only surfaces through flush(). Confirm the writes are durable before
  // reporting success, or the profile survives the session in cache but is
  // missing/partial after a restart. Roll back a non-durable import.
  if (!(await appStorage.flush())) {
    rollbackImportedProfile(profile.id);
    await appStorage.flush();
    throw new Error('Could not save the imported profile to disk.');
  }
  return profile;
}
