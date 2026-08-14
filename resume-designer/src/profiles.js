/**
 * Profile registry + lifecycle. Storage-only module: imports the appStorage
 * facade and pure key helpers, no DOM and no React, so vitest imports it
 * directly. The switch/reload orchestration lives in the UI (AccountSection).
 */
import { appStorage, setProfileMapping, getProfileMapping } from './appStorage.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, SYNC_STATE_KEY,
  isOwnedKey, isSharedKey, isPhysicalKey, isValidProfileId, physicalKey, splitPhysicalKey,
  withoutDeadProviderCredentials, withoutStoredCredentials, withoutDeviceIdentity,
} from './profileKeys.js';

// Starts with `resume-` ON PURPOSE so appStorage's one-time localStorage→disk
// adoption (OWNED_PREFIX = 'resume-') copies it too — otherwise an incomplete
// profile adoption that spans a passthrough→disk transition would lose the
// marker, and the next boot would treat adoption as complete and map onto a
// stale/absent physical copy. It is NOT an owned key (not in BACKUP_FIXED_KEYS,
// not a history key), so isOwnedKey is false → backups never carry it and the
// key mapping never namespaces it.
const PROFILE_ADOPTION_MARKER = 'resume-profile-adoption-pending';

// The profile THIS install created for itself because there was no registry at
// all (see resolveActiveProfile). Held because the bootstrap adoption below is
// allowed to discard exactly that one workspace and nothing else: a workspace
// the person deliberately created is empty and unstamped at the moment they
// make it, indistinguishable from the starter by every other clause, and
// "create a workspace, relaunch before putting anything in it, find it gone"
// is not a thing this feature may do.
//
// Same two properties as the marker above, for the same reasons: it starts
// with `resume-` so appStorage's one-time localStorage→disk adoption carries
// it, and it is NOT an owned key, so backups never carry it, the key mapping
// never namespaces it, and it never syncs. An install that predates this key
// simply never adopts — the conservative direction.
const STARTER_PROFILE_KEY = 'resume-profile-starter';

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

/**
 * The profiles a person should see. `loadRegistry` returns the raw array,
 * tombstones included, because the merge needs them; every UI and every
 * iteration over "the profiles" wants this instead.
 */
export function listProfiles() {
  return (loadRegistry() || []).filter((p) => !p?.deletedAt);
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

// The per-profile lists a person fills by using the app. Every one of them is
// written as a JSON array by its own module (applications.js,
// jobDescriptions.js, chatThreads.js, learnedAnswers.js) and every reader of
// them demands an array, so anything else stored here is a shape this cannot
// vouch for. `resume-designer-chat-history` is the pre-threads chat, migrated
// into threads on load and listed here for the window in between.
const WORKSPACE_LISTS = [
  'resume-designer-applications',
  'resume-designer-job-descriptions',
  'resume-designer-chat-threads',
  'resume-designer-chat-history',
  'resume-designer-learned-answers',
];

// The per-profile keys a starter workspace may hold and still BE a starter
// workspace: design and view preferences, this device's own sync bookkeeping,
// and flags the app sets for itself. Nothing here is anything a person would
// mourn, and a workspace picks all of it up just by being opened once.
//
// An ALLOWLIST, and that is the whole point of it. The predicate used to
// enumerate the CONTENT keys it checked, which silently vouched for every key
// nobody remembered to enumerate — `resume-photo-settings` holds `imageData`,
// the headshot somebody uploaded and cropped, savePhotoSettings records no
// version history for it, and the enumeration therefore called that workspace
// empty. holdsAuthoredContent below makes this argument one level down, about
// FIELDS; this is the same argument about keys. Anything not listed here
// refuses: a known content key, a key this predicate has never heard of, and
// any key a later release adds without touching this file.
//
// `resume-designer-bridge-token`, `resume-designer-theme`,
// `resume-designer-update-channel` and `resume-designer-auto-update-check` are
// deliberately absent, though all four are genuinely harmless. All four are
// SHARED keys (SHARED_KEYS, profileKeys.js) — `mapKey` never namespaces a
// shared key — so their ordinary, unprefixed form never reaches this list at
// all; it passes through the shared-key clause in the walk below instead. One
// of them showing up PREFIXED here did not arrive through the ordinary write
// path: it was written by something this predicate does not understand, and an
// unexplained key is doubt. (This list held the other three until they were
// found sitting here on a different rationale than bridge-token's, for no
// stated reason — same shared-key argument, opposite treatment. Moving them
// out costs nothing: their normal unprefixed form is unaffected.)
const STARTER_HARMLESS_KEYS = new Set([
  SYNC_STATE_KEY, // per-unit sync stamps + this device's id — written by sync, never by a person
  'resume-designer-onboarding-complete',
  'resume-edit-hint-dismissed',
  'resume-header-style',
  'resume-accent-settings',
  'resume-font-settings',
  'resume-spacing-settings',
  'resume-zoom',
]);

// The keys with a clause of their own below, so presence alone cannot judge
// them: they are allowed to EXIST and are then read. Every other key in the
// namespace is judged by presence.
const STARTER_INSPECTED_KEYS = new Set([
  'resume-designer-data',
  'resume-designer-token-usage',
  ...WORKSPACE_LISTS,
]);

// The top-level fields `resume-designer-data` may hold and still describe a
// starter workspace. Same argument as STARTER_HARMLESS_KEYS, one level down:
// the blob clause used to examine exactly `variants` and `userProfile` and let
// everything else — `settings`, `currentVariantId`, and any field a later
// release adds — pass unexamined. That is the defaults-to-innocent shape this
// module already eliminated at the key level; a field it has never heard of
// now refuses too.
//
// `settings` is a decided allowance, not an oversight. Every field in it
// (DEFAULT_STORAGE.settings, persistence.js) is a design/AI/view preference —
// palette, layout, page size, model choices, reasoning efforts, panel width.
// The most "authored" of them, `customModels`, is typed-in model ids:
// recreatable configuration, the same class as `resume-accent-settings` on
// STARTER_HARMLESS_KEYS.
//
// No credential can reach it on this platform, though the mechanism is not
// quite "stripped": `saveSettings` THROWS on `openrouterKey` rather than
// removing it, and a legacy pre-extraction blob deliberately KEEPS its
// `settings.openrouterKey` until `extractSharedApiKey` flushes successfully
// (persistence.js). What makes the allowance airtight here is the platform: no
// iOS release ever wrote the credential into the blob, the key lives in the OS
// keychain, and `withoutLegacyCredential` sanitises a desktop backup at the
// export boundary, so an imported one arrives clean.
//
// Refusing a field every settings interaction writes would fail adoption in
// ordinary use and strand people on the starter workspace — the confusion this
// feature exists to remove.
//
// `variants` and `userProfile` keep the treatment they already had below this
// clause (variants must be empty; userProfile must be unauthored).
// `currentVariantId` is a pointer, not content, so its presence needs no
// further check.
const BLOB_ALLOWED_FIELDS = new Set(['variants', 'currentVariantId', 'settings', 'userProfile']);

/**
 * Whether anything inside a stored structure was authored by a person.
 *
 * The user profile is a fixed skeleton of empty strings and empty arrays
 * (DEFAULT_STORAGE, persistence.js), so "anything at all in it" is the honest
 * test rather than a field-by-field one that a new field would silently escape.
 * A number or a boolean where the skeleton has neither counts as content: this
 * answers a question whose wrong answer deletes a workspace, so an unrecognised
 * value is content.
 */
function holdsAuthoredContent(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.values(value).some(holdsAuthoredContent);
  return true;
}

/**
 * Whether this workspace is the throwaway one `resolveActiveProfile` creates at
 * init and nothing has touched since.
 *
 * THE ONLY PLACE IN SYNC THAT CAN DISCARD ANYTHING, so it is deliberately
 * paranoid: any read that fails, any key that will not parse, and any doubt at
 * all answers false. A stray empty workspace is an annoyance someone can
 * delete; absorbing real work is the failure this whole feature exists to
 * prevent.
 *
 * It is an ALLOWLIST over the workspace's keys, not a list of content keys to
 * check: a key it has never heard of refuses, so the next content key added to
 * this app is safe from it without anyone having to remember this file exists.
 * See STARTER_HARMLESS_KEYS. The same allowlist shape applies one level down,
 * to the FIELDS of the `resume-designer-data` blob — see BLOB_ALLOWED_FIELDS.
 *
 * Version history is the load-bearing clause — the store records an entry on
 * every change, so an absent history is the strongest evidence available that
 * nothing was ever edited. Comparing the résumé to the default template was
 * considered and rejected: the template changes between releases, so a byte
 * comparison would silently start absorbing every workspace the moment the
 * default changed. There is no default to compare against anyway — init seeds
 * no résumé at all on Tauri and iOS, which is why ANY résumé refuses.
 */
export function isUntouchedWorkspace(profileId) {
  // Only ever asked of the ACTIVE profile — the one init just created — so
  // ordinary `appStorage` reads resolve to its namespace. Refusing anything
  // else keeps this from being pointed at a workspace whose keys it would
  // silently read from the wrong namespace and judge empty.
  if (!profileId || profileId !== getActiveProfileId()) return false;
  // And the pointer is not enough on its own. It says which workspace the app
  // is IN; the key mapping says which namespace a read LANDS in, and the two
  // come apart in every degraded state this module has (an adoption that could
  // not finish runs mapping-off on the unprefixed keys). With them apart, every
  // read below returns null and a full workspace reads back as untouched.
  if (getProfileMapping() !== profileId) return false;

  try {
    const entry = (loadRegistry() || []).find((p) => p.id === profileId);
    if (!entry || entry.updatedAt) return false;

    // Every key the workspace holds has to be one this can affirmatively vouch
    // for (STARTER_HARMLESS_KEYS). Version history is still the load-bearing
    // case — the store records an entry on every change, so an absent history is
    // the strongest evidence available that nothing was ever edited — but it is
    // no longer SPECIAL: it refuses because it is not on the harmless list,
    // exactly like a headshot, or like a key from a release that does not exist
    // yet.
    for (const physical of appStorage.keys()) {
      if (!physical) continue;
      const split = splitPhysicalKey(physical);
      if (split) {
        if (split.profileId !== profileId) continue; // another workspace's key
        if (STARTER_HARMLESS_KEYS.has(split.logicalKey)) continue;
        if (STARTER_INSPECTED_KEYS.has(split.logicalKey)) continue;
        return false;
      }
      // Unprefixed, with the mapping proven active above: adoption has finished,
      // so no per-profile key should still be sitting unprefixed, and one that
      // is means a half-finished adoption — which is doubt. Shared keys are
      // unprefixed BY DESIGN and say nothing about this workspace, and neither
      // do the app's own markers, which are not owned keys at all.
      if (isOwnedKey(physical) && !isSharedKey(physical)) return false;
    }

    // NO résumé. Not "at most the one init created": on Tauri and iOS —
    // the platforms this feature runs on — migrateBuiltInVariants seeds nothing
    // (persistence.js), so init leaves no résumé behind and any variant present
    // was AUTHORED. The allowance this started with described a state no
    // shipping platform produces, and it absorbed the ordinary no-AI onboarding
    // path: saveOnboardingResume writes exactly one variant, writes no history
    // (only pushHistory does, on edits), never touches userProfile and spends no
    // tokens, so a résumé somebody had just imported passed every other clause.
    //
    // A device nobody has given a résumé to yet has no blob at all, and absence
    // is only readable as emptiness because the mapping was proven above.
    const rawBlob = appStorage.getItem('resume-designer-data');
    if (rawBlob !== null) {
      const blob = JSON.parse(rawBlob);
      // An ARRAY is typeof 'object' and has no `variants`, so `[]` used to sail
      // through this entire clause. A blob shaped like nothing this app writes
      // is a corrupt blob, and a corrupt blob is doubt.
      if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return false;
      // A field this predicate has never heard of refuses, same as an unknown
      // physical key one level up. See BLOB_ALLOWED_FIELDS.
      for (const field of Object.keys(blob)) {
        if (!BLOB_ALLOWED_FIELDS.has(field)) return false;
      }
      const { variants } = blob;
      if (variants !== undefined) {
        if (!variants || typeof variants !== 'object' || Array.isArray(variants)) return false;
        if (Object.keys(variants).length > 0) return false;
      }
      // The Profile screen writes straight into this blob and records NO
      // version history, so someone who filled in their contact details and
      // work history without ever opening a résumé passes every other clause.
      if (holdsAuthoredContent(blob.userProfile)) return false;
    }

    // Every list empty or absent.
    for (const key of WORKSPACE_LISTS) {
      const raw = appStorage.getItem(key);
      if (raw === null) continue;
      const list = JSON.parse(raw);
      if (!Array.isArray(list) || list.length > 0) return false;
    }

    // No tokens spent.
    const usageRaw = appStorage.getItem('resume-designer-token-usage');
    if (usageRaw !== null) {
      const usage = JSON.parse(usageRaw);
      if (Array.isArray(usage?.events) ? usage.events.length > 0 : usage != null) return false;
    }

    return true;
  } catch {
    // A key that will not parse is a key this cannot vouch for.
    return false;
  }
}

/**
 * Absorb this install's starter workspace into the account it has since
 * discovered, and return the workspace to open instead — or null to keep what
 * is already active, which is every path but one.
 *
 * The registry it reads has already been unioned with the account's by a
 * landing (landRegistry, syncModel.js) in an earlier session: the shared zone
 * is fetched at start, and this runs at the next boot's resolve, which is the
 * one moment the active profile can still be changed without a reload.
 *
 * THE TOMBSTONE IS NOT AN IMPLEMENTATION DETAIL. If this device's own registry
 * ever reached the server ahead of that shared fetch — a retry, a reordering, a
 * future change to the enable path — a bare local removal is undone by the next
 * union merge and the empty workspace comes back for good. The tombstone is
 * harmless when the starter never reached the server and correct when it did.
 * See the spec's §4 ordering rules.
 */
async function adoptAccountWorkspaces(activeId) {
  // Only the workspace init created for itself, never one the person made.
  if (appStorage.getItem(STARTER_PROFILE_KEY) !== activeId) return null;
  const others = listProfiles().filter((p) => p.id !== activeId);
  if (!others.length) return null;
  // A restore is mid-flight, so both writes below would be recorded and skipped
  // while flush() still answered true — see activateProfileDurably.
  if (appStorage.isRestoreGuardActive()) return null;
  if (!isUntouchedWorkspace(activeId)) return null;

  // Least-recently-created, with the id breaking a tie: the same order
  // mergeRegistry sorts by, so two devices bootstrapping against one account
  // open the same workspace. `<` on strings compares by code unit —
  // localeCompare calls Unicode-equivalent strings equal, which has already
  // cost this feature one ordering bug (syncMerge.js).
  const next = others.reduce((best, p) => {
    const a = String(p.createdAt ?? '');
    const b = String(best.createdAt ?? '');
    if (a !== b) return a < b ? p : best;
    return p.id < best.id ? p : best;
  });

  const registryBefore = loadRegistry() || [];
  const stamp = new Date().toISOString();
  saveRegistry(registryBefore.map((p) => (p.id === activeId
    ? { ...p, deletedAt: stamp, updatedAt: stamp }
    : p)));
  appStorage.setItem(ACTIVE_PROFILE_KEY, next.id);
  setProfileMapping(next.id);

  if (!(await appStorage.flush())) {
    // Restore BOTH. The pair has to move together: a tombstone that reached
    // disk without its pointer leaves the next boot active in a workspace
    // nothing lists, and no later boot can adopt out of it either — the
    // tombstone stamps `updatedAt`, which the predicate above refuses for ever.
    console.error('[profiles] workspace adoption did not reach disk; keeping the starter workspace');
    setProfileMapping(activeId);
    appStorage.setItem(ACTIVE_PROFILE_KEY, activeId);
    try { saveRegistry(registryBefore); } catch { /* keep going */ }
    await appStorage.flush();
    return null;
  }

  // Only now the namespace, and only its own keys. Nothing in it is content —
  // that is exactly what the predicate proved — so unlike deleteProfileDurably
  // there is nothing here worth snapshotting for a rollback, and a delete that
  // does not reach disk costs some empty files.
  const prefix = physicalKey(activeId, '');
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  // The marker named a workspace that no longer exists.
  appStorage.removeItem(STARTER_PROFILE_KEY);
  await appStorage.flush();
  return next.id;
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
    // THIS is the workspace nobody asked for — the one a later boot may absorb
    // into the account, once a landing has shown there is an account to absorb
    // it into. Written with the registry it names and crossing the same
    // durability barrier; a marker that does not land only costs this install
    // its ability to adopt, which is the safe direction.
    appStorage.setItem(STARTER_PROFILE_KEY, id);
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
  // A TOMBSTONED entry does not count as membership, which is not the same
  // check as "is it in the array": the entry is still physically there (see
  // deleteProfile), and the app would map into a workspace no listing shows and
  // no switcher can leave. Two things reach that state — another device
  // deleting the workspace this one is sitting in, and the adoption below
  // landing its tombstone without its pointer — and the heal below is what gets
  // out of both.
  if (!registry.some((p) => p.id === active && !p?.deletedAt)) {
    // Prefer the first NON-tombstoned entry: registry[0] can itself be a
    // tombstone now (deleteProfile no longer drops entries), and this branch
    // fires exactly when the membership check above already failed — landing
    // on a deleted profile would map the app onto an empty namespace and hide
    // the active id from listProfiles(). Fall back to registry[0] only if
    // every entry is somehow tombstoned, matching the prior unconditional
    // behavior rather than leaving `active` unset.
    active = (registry.find((p) => !p?.deletedAt) || registry[0]).id;
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
  // The account's own workspaces, if a landing has unioned them into this
  // device's registry since the last boot and this device's starter workspace
  // is provably untouched. AFTER the mapping is active, because the predicate
  // reads through it and answers "untouched" to everything while it is off;
  // BEFORE extractSharedApiKey, so the sweep runs over the namespace the app is
  // actually going to spend the session in.
  try {
    const adopted = await adoptAccountWorkspaces(active);
    if (adopted) active = adopted;
  } catch (err) {
    // Its own catch, not ensureProfilesInitialized's: that one degrades the
    // whole boot to mapping-off, which for a workspace that IS namespaced looks
    // like every résumé disappearing. Nothing here is worth that. Re-read the
    // pointer rather than assuming which side of the writes the throw landed
    // on, so the mapping matches the workspace that is actually stored, and let
    // the next boot try again — a tombstone that landed without its pointer is
    // healed by the membership check above.
    console.error('[profiles] workspace adoption failed; keeping the stored active profile:', err);
    active = getActiveProfileId() || active;
    setProfileMapping(active);
  }
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
  // listProfiles(), not loadRegistry(): a tombstoned entry is still physically
  // present in the raw registry (see deleteProfile), so validating against the
  // raw array would let a person switch into a workspace they just deleted.
  if (!listProfiles().some((p) => p.id === id)) throw new Error(`Unknown profile id: ${id}`);
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
    ? {
      ...p,
      ...(name !== undefined ? { name } : {}),
      ...(emoji !== undefined ? { emoji } : {}),
      // mergeRegistry settles a collision on this stamp. Without it a rename on
      // one device loses to an unstamped entry on another.
      updatedAt: new Date().toISOString(),
    }
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
  // listProfiles(), not the raw array: a tombstone still occupies a slot in
  // `registry` (see below), so counting it here stops this guard from firing
  // once any tombstone exists — silently handing protection of the last
  // VISIBLE profile to the active-profile guard, which only holds while the
  // active id is itself a listed profile.
  if (listProfiles().length <= 1) throw new Error('Cannot delete the last profile.');
  if (id === getActiveProfileId()) throw new Error('Cannot delete the active profile — switch away first.');
  const prefix = physicalKey(id, '');
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  // TOMBSTONE, not a drop. Under a union merge a dropped entry is restored by
  // the other device's copy on the next sync, and the workspace reappears
  // forever. This is metadata: it hides a listing and destroys no content —
  // the profile's résumés are removed locally by the code above exactly as
  // before, and its CloudKit zone is left alone.
  const stamp = new Date().toISOString();
  saveRegistry(registry.map((p) => (p.id === id
    ? { ...p, deletedAt: stamp, updatedAt: stamp }
    : p)));
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
  // listProfiles(): a tombstoned entry's physical keys are already gone (see
  // deleteProfile), so finding it in the raw registry would silently produce
  // an empty export instead of the "unknown profile" error a stale id should get.
  const profile = listProfiles().find((p) => p.id === profileId);
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
    if (v !== null) keys[logical] = withoutStoredCredentials(logical, v);
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
      if (v !== null) keys[k] = withoutStoredCredentials(k, v);
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

// Remove a just-imported profile's partial keys and TOMBSTONE its registry
// entry — not drop it — so a failed import never leaves a half-written
// workspace the user can switch into. Same reasoning as deleteProfile, and it
// applies here now that the registry syncs via a union merge (landRegistry,
// syncModel.js): createProfile's write above races the storage interceptor's
// dirty notification, and the import loop between it and this rollback is
// long enough a window for another device to have already pulled the
// "with this id" registry off CloudKit. A dropped entry is exactly what that
// device's own next push — still carrying the id, untombstoned — resurrects
// on the following union. A tombstone is retained by every merge instead.
function rollbackImportedProfile(id) {
  const prefix = physicalKey(id, '');
  for (const k of appStorage.keys()) {
    if (k && k.startsWith(prefix)) appStorage.removeItem(k);
  }
  const stamp = new Date().toISOString();
  saveRegistry((loadRegistry() || []).map((p) => (p.id === id
    ? { ...p, deletedAt: stamp, updatedAt: stamp }
    : p)));
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
      //
      // And drop the exporting device's `deviceId` out of the sync-state key:
      // this is the boundary that carries ONE workspace between two machines, so
      // it is the most direct way for both of them to end up claiming the same
      // origin id — the thing undo scopes itself by. The per-unit stamps beside
      // it are per-profile data and stay. See withoutDeviceIdentity.
      appStorage.setItem(
        physicalKey(profile.id, k),
        withoutDeviceIdentity(k, withoutStoredCredentials(k, v)),
      );
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
