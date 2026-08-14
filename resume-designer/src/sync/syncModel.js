/**
 * The sync layer's only contact with storage.
 *
 * Everything above this file is pure; everything below it is `appStorage`.
 * Swift calls into here through the bridge and never learns any of it: a unit
 * crosses as `{ id, kind, payload, modifiedAt }` with an opaque payload.
 */
import { appStorage } from '../appStorage.js';
import {
  splitPhysicalKey, physicalKey, BACKUP_HISTORY_PREFIX, SYNC_STATE_KEY, SYNC_ENABLED_KEY,
} from '../profileKeys.js';
import { getActiveProfileId, listProfiles } from '../profiles.js';
// The store owns the loaded variant's history IN MEMORY and rewrites the whole
// key from it on every edit, so parking a loser for that variant has to go
// through it — see parkLoser.
import { store, CHANGE_TYPES } from '../store.js';
// The four modules that hold their whole key in memory the way the store holds
// the loaded document — see KEY_OWNERS below.
import { adoptStoredApplications, landsAsApplications } from '../applications.js';
import { adoptStoredJobDescriptions, landsAsJobDescriptions } from '../jobDescriptions.js';
import { adoptStoredThreads, threadHolderBusy, landsAsThreads } from '../chatThreads.js';
import { adoptStoredLearnedAnswers, landsAsLearnedAnswers } from '../learnedAnswers.js';
// The same ownership, one field further in: `data:userProfile` is a unit too,
// and ProfileDialog holds a working copy of it. See the leaf for why it is one.
import { adoptStoredUserProfile, userProfileHolderBusy } from '../userProfileHolder.js';
import { classifyKey, keyScope, PROFILES_KEY } from './syncKeys.js';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from './syncUnits.js';
import {
  mergeTokenUsage, mergeHistory, mergeRegistry, resolveConflict,
} from './syncMerge.js';

const DATA_KEY = 'resume-designer-data';
const TOKEN_KEY = 'resume-designer-token-usage';
// This device's sync bookkeeping — per-unit modification times here, and the
// device id store.js stamps on history entries. One constant from profileKeys.js
// rather than a literal at each end, because store.js cannot import this file
// (this one imports it) and two spellings of a key are two keys.
const STATE_KEY = SYNC_STATE_KEY;
const KEY_UNIT_PREFIX = 'key:';
// The blob's non-résumé fields — `settings` and `userProfile` — as splitData
// emits them. Kept in step with syncUnits.js's own literal by construction:
// `landsAsDataField` asks mergeData what it accepts rather than repeating the
// list of fields.
const DATA_UNIT_PREFIX = 'data:';
// The one `data:` unit something holds a whole in-memory copy of — see
// ../userProfileHolder.js. `data:settings` needs no such treatment: every writer
// of it calls persistence.js's saveSettings with the ONE field it changed, and
// that merges into a freshly-read blob, so nothing ever writes a whole settings
// object back from a copy taken earlier.
const USER_PROFILE_UNIT_ID = `${DATA_UNIT_PREFIX}userProfile`;
// Undo/redo history key prefix. Re-exported from profileKeys.js rather than
// re-declared, same as store.js's own HISTORY_KEY_PREFIX: it has to stay
// byte-identical to what store.js reads (HISTORY_KEY_PREFIX + variantId), or
// a parked loser lands at a key the version-history dialog never reads from.
const HISTORY_PREFIX = BACKUP_HISTORY_PREFIX;

const parseJSON = (raw, fallback) => {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const readJSON = (key, fallback) => parseJSON(appStorage.getItem(key), fallback);

/**
 * The storage key a fetched unit's bytes belong under.
 *
 * A unit names the profile whose ZONE it arrived in. For the open profile that
 * is the ordinary logical key, which `appStorage` maps as usual. For any other
 * it is that profile's PHYSICAL key: `mapKey` short-circuits on an already
 * physical key, so this writes exactly there rather than through the active
 * mapping — which would put another person's résumé in the open workspace and
 * lose it from its own, neither visible until somebody switches.
 */
function storageKeyFor(profileId, logicalKey) {
  if (!profileId || profileId === getActiveProfileId()) return logicalKey;
  return physicalKey(profileId, logicalKey);
}

const stateFor = (profileId) => readJSON(storageKeyFor(profileId, STATE_KEY), {});
const state = () => stateFor('');

/** Fetched units bucketed by the profile whose zone each arrived in. */
function groupByProfile(units) {
  const groups = new Map();
  for (const unit of units) {
    const id = typeof unit?.profileId === 'string' ? unit.profileId : '';
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(unit);
  }
  return groups;
}

/**
 * Whether this device syncs at all.
 *
 * **Off until the person turns it on**, and that is a product decision, not a
 * default nobody got round to changing: turning it on writes their resumes into
 * their iCloud account, and that is not a thing to assume on someone's behalf.
 *
 * Anything other than the string `'true'` reads as off, so an absent or garbled
 * value fails closed — the direction that never puts data somewhere unasked.
 */
export function isSyncEnabled() {
  return appStorage.getItem(SYNC_ENABLED_KEY) === 'true';
}

/**
 * Record the answer, and report whether it reached the DISK. The transport is
 * started or stopped by whoever asked.
 *
 * The answer means here what it means for `applyUnits`, and for the same
 * reason: `appStorage.setItem` is a write-behind cache (appStorage.js), so a
 * bare set is true of a Map and says nothing about the file the next launch
 * reads. One caller acts on it and it is the one that cannot be wrong — an
 * iCloud purge holds a persisted refusal open until this answers `true`
 * (`tellPageSyncIsOff`, OPShell.swift). Answering off the cache let a process
 * death inside the drain window relaunch into a stored preference still saying
 * ON with the refusal already cleared, and the next start put the workspace
 * back into the account whose owner had just deleted it.
 *
 * `false` is never "the write was lost": the value is in the cache and stays
 * there. It means "not durable yet", and the only caller reading it treats that
 * as "keep the flag and ask again at the next start".
 *
 * The switch in the native sheet ignores the answer, as it did before, and pays
 * one drain it would have paid 250ms later anyway.
 */
export async function setSyncEnabled(enabled) {
  appStorage.setItem(SYNC_ENABLED_KEY, enabled ? 'true' : 'false');
  // A restore is mid-flight, so the write above reached NEITHER the cache nor
  // the disk — it was recorded and skipped (beginRestoreGuard) — while
  // `flush()` would still answer `true`, because nothing is dirty. That is the
  // hole `applyUnits` refuses at its top, in the one shape where the disk
  // cannot be asked: the restore ends in a reload from the backup, whose own
  // copy of this preference is whatever it was when the backup was taken.
  if (appStorage.isRestoreGuardActive()) return false;
  return appStorage.flush();
}

/**
 * The recorded modification time, or `null` when this device never stamped one.
 *
 * NOT `new Date()`. An unstamped unit would then claim to have been modified at
 * the instant it was collected — newer than any real remote stamp — so the
 * collecting device would win EVERY conflict and park or discard the other
 * device's genuine edit on a timestamp it never earned. A résumé and its
 * history are stamped on every persisted save (registerPersistedSaveHandler);
 * every other unit is unstamped until something calls `touchUnit` for it.
 *
 * It is the last PERSISTED time, which is not the same as the document's — the
 * save debounce has no max wait, so under continuous editing this stamp goes
 * arbitrarily stale. `applyUnits` does not lean on it alone for that reason:
 * a variant with an edit in flight is refused before any comparison runs (see
 * store.isBusyEditing).
 *
 * `null` says "unknown", and `resolveConflict` already gives an unparseable or
 * absent stamp -Infinity: it loses to any real one, which is the honest meaning
 * of not knowing. Two unknowns tie, and its tie-break (remote wins) keeps both
 * devices computing the same winner.
 *
 * Sent as an explicit `null` rather than an omitted field so the unit crossing
 * the bridge keeps the shape the header documents.
 */
function modifiedAtFor(unitId, recorded) {
  return recorded[unitId]?.modifiedAt ?? null;
}

/**
 * `mergeData`'s own skip rule (syncUnits.js), applied here so `applied` counts
 * what actually landed rather than what was offered.
 */
function parsesAsJSON(payload) {
  if (typeof payload !== 'string') return false;
  try {
    JSON.parse(payload);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `mergeData` will actually take a `data:` unit.
 *
 * The set of top-level fields it accepts is private to syncUnits.js, and a copy
 * of that list here is how the two drift: `data:currentVariantId` is refused
 * there ON PURPOSE — which résumé is open is a property of a device — and a
 * stale copy that let it through would land another device's open document AND
 * count it as applied. So mergeData is asked instead: merging a unit into an
 * empty blob touches nothing but `variants` unless the field is one it knows.
 *
 * The VALUE has to land too, not just the field: `null` parses fine and
 * mergeData writes it, so the payload `'null'` blanked `settings` or
 * `userProfile` wholesale off one malformed remote unit — and counted as
 * applied. Both are objects in every shape the app writes, so a null there is a
 * broken record, not a value.
 *
 * `null` was only the reachable half of that, though — the one `String(null)`
 * coercion produces. Refusing it alone still let `'[]'`, `'5'` and `'"x"'`
 * through, and the chain past the write is the same one `landsAsResume` and
 * KEY_OWNERS close for their units, a field further in: the garbage lands on
 * disk and counts applied, so this device keeps the change tag; `getUserProfile`
 * returns it because it is TRUTHY; `completeProfile` normalises it to a
 * defaults-shaped EMPTY profile; and the next debounced save persists that empty
 * profile and pushes it up as a clean, uncontested update. Absence became
 * deletion one restart later. `data:settings` is the lower-stakes twin —
 * `saveSettings`' `{ ...[], ...rest }` degrades every preference to its default.
 *
 * So the question asked is the honest one — is this a value of the shape the
 * field holds — and both fields hold an OBJECT in every shape the app writes.
 * An array is refused with the scalars: `typeof [] === 'object'` is a fact about
 * JavaScript, not about a settings blob. An explicitly EMPTY object still lands;
 * that is a profile someone cleared, not an absence, exactly as an explicitly
 * empty list lands for a KEY_OWNERS key.
 *
 * Deliberately NOT extended to non-owner plain keys like
 * `resume-designer-profiles`: `loadRegistry` already reads a corrupt registry as
 * `null` and routes boot through the registry rebuild, which recovers every
 * namespace.
 */
function landsAsDataField(unit) {
  const landed = mergeData({}, [unit]);
  return Object.keys(landed).some((field) => field !== 'variants' && isFieldValue(landed[field]));
}

/** The shape both `data:` fields hold — see `landsAsDataField`. */
function isFieldValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The document inside a `resume:` unit, or `null` when the unit carries none.
 *
 * A résumé unit's payload is the whole variant RECORD as splitData emits it —
 * `{ id, name, data, ... }` — and the document is its `.data`, one level in.
 * Confusing the two is not a cosmetic mistake: a record put where a document
 * belongs reads as a near-empty résumé named after the variant, because the
 * only field the two shapes share is `name`.
 *
 * ONE reader for every place that has to answer it, deliberately. The disk
 * write (mergeData) and the in-memory adoption (store.adoptDocument) must
 * accept exactly the same units or they disagree about what this device holds —
 * see `applyUnits`, which refuses on this before `mergeData` is reached — and
 * `parkLoser` unwraps the same way, version-history entries holding the
 * document too.
 */
function resumeDocument(payload) {
  let record;
  try {
    record = JSON.parse(payload);
  } catch {
    return null;
  }
  const document = record?.data;
  return document && typeof document === 'object' ? document : null;
}

/**
 * Whether a fetched résumé is one this device can land at all.
 *
 * A record with no document is a broken unit, not an empty résumé, and letting
 * it through wrote the data-less record over the blob's good copy AND counted
 * it applied — so the transport kept the change tag while the store, which
 * applies the same rule, refused it. Disk and memory then disagreed, which is
 * the exact state this path exists to prevent, and the app reloaded data-less
 * if it quit before that variant's next save. Absence is never deletion: the
 * same class of malformed unit is what blanked `settings` wholesale before
 * `landsAsDataField` was written.
 */
function landsAsResume(unit) {
  return resumeDocument(unit.payload) !== null;
}

// Whether a person is typing into the résumé right now. Installed by main.js
// (registerEditingProbe) for the same reason registerPersistedSaveHandler is
// installed there: the answer lives in the DOM — src/inlineEditor.js's active
// contentEditable node — and this module must not import it. A shell that
// never registers one has no inline editor to interrupt, so "no" is right.
let inlineEditingProbe = () => false;

/**
 * Install the "someone is typing right now" probe. main.js owns this graph edge.
 */
export function registerEditingProbe(probe) {
  inlineEditingProbe = typeof probe === 'function' ? probe : () => false;
}

/**
 * Whether landing this résumé would land on top of work in flight.
 *
 * Adoption repaints: `store.adoptDocument` emits 'change', and every renderer
 * rebuilds `#resume`'s innerHTML from it. An inline edit lives ONLY in the DOM
 * until blur commits it (src/inlineEditor.js), so a fetch arriving mid-word
 * destroyed exactly the characters the person was typing, with no history entry
 * anywhere. That exposure is new: before the store adopted, a fetch never
 * repainted the screen.
 *
 * REFUSED, not deferred, and refusing is not a loss. A deferred unit would have
 * to be held somewhere, go stale there, and still be re-offered by the transport
 * — while the count returned now would claim it landed, which is the very
 * disagreement between disk and memory this filter exists to stop. Refusing
 * shortens the applied count instead, the transport forfeits the record's change
 * tag, and the imminent save of the edit in flight meets the conflict path with
 * a FRESH stamp, where both copies are compared and the loser is parked. The
 * remote copy is still on the server and on the device that wrote it throughout.
 */
function interruptsLiveEditing(unit) {
  return store.isBusyEditing(unit.id.slice(RESUME_UNIT_PREFIX.length), inlineEditingProbe());
}

/**
 * The same question for the one `data:` unit somebody holds a copy of.
 *
 * Asked in the filter beside `landsAsDataField`, so it is decided BEFORE the
 * blob write like every other refusal here — a unit that reaches storage is on
 * disk whatever the holder then does with it. See ../userProfileHolder.js.
 */
function interruptsProfileEditing(unit) {
  return unit.id === USER_PROFILE_UNIT_ID && userProfileHolderBusy();
}

/**
 * The keys something holds a whole in-memory copy of.
 *
 * A `key:` unit lands by overwriting its key — which is enough only while the
 * key is nobody's cache. These four are somebody's: applications.js,
 * jobDescriptions.js and learnedAnswers.js each keep the parsed list in a module
 * array and serialize THAT array back over the key on every local change, and
 * the chat's thread list lives in useChat's React state, which `persistThreads`
 * writes back the same way. So content this device applied lasted exactly until
 * that module's next ordinary write, which put the stale copy back, stamped the
 * unit, and — this device legitimately holding the record's change tag, because
 * the page had confirmed the apply — pushed the revert up as a clean,
 * uncontested update. No conflict was raised and nothing was parked: the other
 * device's content was simply gone. The résumé had exactly this bug and
 * `store.adoptDocument` is exactly this answer.
 *
 * `adopt()` re-reads storage rather than being handed the payload, so the
 * module's copy is by construction the bytes that reached the key — one source
 * of truth, and no second parser to disagree with the module's own.
 *
 * `lands()` is `landsAsResume` for these keys, and it exists because refusing in
 * `adopt()` alone protects only MEMORY. A payload the owner cannot read was
 * still written, and still counted — so the bad bytes sat on the key while the
 * cache quietly kept the good list. That is survivable exactly as long as the
 * process lives: restart before that module's next local write and its init
 * reads the garbage, degrades it to `[]` — every one of these owners degrades
 * the same way, and loadThreads goes further and manufactures a fresh empty
 * conversation — and the first save afterwards persists the empty list and
 * pushes it up as a clean, uncontested update. Absence became deletion one
 * restart later. So the question is asked BEFORE the write, on the owner's own
 * reader, and a refusal shortens `applied` the way every other refusal here
 * does: the transport forfeits the change tag and re-offers the unit.
 *
 * `isBusy()` is the résumé's `interruptsLiveEditing` rule for a different
 * screen, and only the chat needs one: adopting there replaces the thread list
 * a streamed reply commits into, and that reply exists nowhere else until it
 * does. It is asked BEFORE the write, never after — a unit that reaches storage
 * is on disk whatever the owner then does with it, and disk disagreeing with
 * memory is the failure this whole path exists to avoid.
 *
 * `resume-designer-chat-history` is deliberately absent: the legacy
 * single-thread key is read once by loadThreads() when there are no threads at
 * all, and nothing caches it.
 */
const KEY_OWNERS = new Map([
  ['resume-designer-applications', { lands: landsAsApplications, adopt: adoptStoredApplications }],
  ['resume-designer-job-descriptions', {
    lands: landsAsJobDescriptions, adopt: adoptStoredJobDescriptions,
  }],
  ['resume-designer-chat-threads', {
    lands: landsAsThreads, isBusy: threadHolderBusy, adopt: adoptStoredThreads,
  }],
  ['resume-designer-learned-answers', {
    lands: landsAsLearnedAnswers, adopt: adoptStoredLearnedAnswers,
  }],
]);

/**
 * Whether a fetched SNAPSHOT unit is newer than the copy this device holds.
 *
 * Newer wins — on THIS path too. The fetch path merged every résumé
 * unconditionally, which was survivable only because of the bug below it: the
 * loaded variant's stale in-memory document wrote itself back afterwards. With
 * the store adopting, an older record would land on screen mid-edit and take
 * the newer local version with it. That happens whenever this device edited
 * while the transport was down, or between a send and this pull.
 *
 * IT ASKS THE QUESTION FOR EVERY SNAPSHOT UNIT, not just `resume:`, and that
 * generalisation is the whole of this rule. Guarding the résumés alone left
 * `data:settings`, `data:userProfile`, the applications and job lists, the chat
 * threads, the learned answers and the profile registry landing unconditionally
 * — and the race that costs is worse than losing the newer copy, because it
 * LEGITIMISES the older one:
 *
 *  1. A local edit writes the key, which stamps the unit here and queues the
 *     native dirty notification, which waits for the storage drain.
 *  2. An OLDER server record arrives inside that window and is applied. The
 *     newer local value is overwritten and the module that owns the key adopts
 *     the old one.
 *  3. The already-pending notification then uploads that STALE payload carrying
 *     the NEWER local timestamp, under the change tag the apply just earned. It
 *     goes up as a clean, uncontested update, and no later comparison can undo
 *     it: the old version is now the newest one everywhere.
 *
 * `resolveConflict` rather than a comparison written out here, so the fetch
 * path and the save-time conflict path (`resolveConflicts`) cannot disagree
 * about who won — there is now exactly one copy of that rule in the whole app,
 * the transport having stopped keeping a second one in Swift. Including on the
 * two cases that decide it: an unknown local time LOSES to a real one, and the
 * remote takes an exact tie.
 * A device that has never stamped a unit scores -Infinity for it, so a fresh
 * install still receives everything.
 *
 * NOT asked of the two append-shaped units — see `accumulatorFor`. They union,
 * and a union does not need to be newer to be right.
 *
 * Refusing costs nothing that is not already designed for: the short `applied`
 * count makes the transport forfeit the record's change tag, so the next save
 * of this unit meets the conflict path, where both copies are compared and the
 * loser is parked. Nothing is destroyed by a refusal — the remote copy is still
 * on the server and on the device that wrote it.
 */
function outranksLocalCopy(unit, recorded) {
  const local = { id: unit.id, modifiedAt: modifiedAtFor(unit.id, recorded) };
  return resolveConflict(local, unit).winner !== local;
}

/**
 * How an append-shaped key lands, or `null` when the key is a snapshot.
 *
 * ONE list, used for both halves of the decision — which units are exempt from
 * newer-wins above, and how those units are written below. Two lists would be
 * the way a third accumulating unit gets a merge branch and silently keeps the
 * snapshot guard, which would drop exactly the entries the merge exists to
 * keep.
 *
 * WHICH UNITS BELONG HERE is decided by the spec's rule (see syncMerge.js's
 * header): a unit whose payload GROWS by accumulation cannot take newer-wins,
 * because the newer document is missing whatever the other device appended.
 * The test that separates the two in this app is whether the app ever REMOVES
 * an element on purpose. The lists that look append-shaped — applications, job
 * descriptions, chat threads, learned answers, the profile registry — all have
 * an authored delete (`deleteApplication`, `deleteJobDescription`, the chat's
 * delete, `deleteLearnedAnswer`, `deleteProfile`), so unioning them would
 * resurrect what somebody deliberately deleted, and the newest whole-list write
 * is the authoritative state. The two below have no such delete: token events
 * are never pruned (`tokenTrackingService.js`), and a version-history entry is
 * never individually removed — which is also why a conflict's loser can be
 * PARKED in one.
 *
 * `resume-designer-profiles` is the one the bootstrap design moves across
 * (docs/superpowers/specs/2026-08-13-sync-bootstrap-design.md §2): it earns a
 * union by adding the tombstones that stop one, which is the general shape of
 * the answer for any list that wants to accumulate. When it moves, it moves
 * HERE — adding a merge branch without adding it to this function would leave
 * the union guarded by newer-wins, which drops exactly what the union is for.
 */
function accumulatorFor(key) {
  if (key === TOKEN_KEY) return landTokenUsage;
  if (key.startsWith(HISTORY_PREFIX)) return landHistory;
  // The registry is append-shaped for creation and snapshot-shaped per entry;
  // mergeRegistry is the only merge that reads both.
  if (key === PROFILES_KEY) return landRegistry;
  return null;
}

/**
 * Union token usage into what this device holds. Both devices append events, so
 * the newer document is not the whole truth — see mergeTokenUsage.
 *
 * `false` when the payload will not parse, which shortens `applied` exactly as
 * every other refusal here does.
 */
function landTokenUsage(key, unit, profileId) {
  let remote;
  try {
    remote = JSON.parse(unit.payload);
  } catch {
    return false;
  }
  const storageKey = storageKeyFor(profileId, key);
  appStorage.setItem(storageKey, JSON.stringify(mergeTokenUsage(readJSON(storageKey, null), remote)));
  return true;
}

/**
 * Union version history into what this device holds.
 *
 * History accumulates, so it merges rather than replaces — and it is the one
 * unit where replacing was self-defeating: a `setItem` here overwrote local
 * history wholesale, destroying a loser parkLoser had just parked to make
 * newer-wins safe.
 *
 * The loaded variant's history lives in store.js's in-memory array and
 * saveHistory rewrites the whole key from it, so a merge written to storage
 * here is undone by the next edit — the same trap parkLoser documents, and the
 * same answer: hand it to the store, which is the only thing that can tell
 * (currentVariantId is private to it).
 */
function landHistory(key, unit, profileId) {
  let remote;
  try {
    remote = JSON.parse(unit.payload);
  } catch {
    return false;
  }
  const storageKey = storageKeyFor(profileId, key);
  const variantId = key.slice(HISTORY_PREFIX.length);
  if (storageKey !== key || !store.adoptHistory(variantId, remote)) {
    appStorage.setItem(storageKey, JSON.stringify(mergeHistory(readJSON(storageKey, null), remote)));
  }
  return true;
}

/**
 * Union an incoming registry into what this device holds.
 *
 * `false` when the payload will not parse or is not an array, which shortens
 * `applied` exactly as every other refusal here does — absence is never
 * deletion, and a registry that cannot be read is one this device has nothing
 * to say about.
 */
function landRegistry(key, unit, profileId) {
  let incoming;
  try {
    incoming = JSON.parse(unit.payload);
  } catch {
    return false;
  }
  if (!Array.isArray(incoming)) return false;
  const storageKey = storageKeyFor(profileId, key);
  appStorage.setItem(storageKey, JSON.stringify(mergeRegistry(readJSON(storageKey, null), incoming)));
  return true;
}

/**
 * Hand a fetched résumé to the store when it is the variant the app has open.
 *
 * The blob write above is not enough for that one variant: store.js holds its
 * document in memory and the debounced save writes that back over the blob, so
 * an applied résumé lasted until the next save, which then pushed the stale
 * document up as a clean, uncontested update — the same trap parkLoser and the
 * history merge document, and the same answer. The store is asked rather than
 * told, because `currentVariantId` is private to it.
 *
 * The store holds the DOCUMENT, one level into the variant record the unit
 * carries — see resumeDocument, which the filter above uses on the same unit so
 * a record this cannot read never reaches the blob either.
 */
function adoptLoadedDocument(unit) {
  const variantId = unit.id.slice(RESUME_UNIT_PREFIX.length);
  if (!variantId) return;

  const document = resumeDocument(unit.payload);
  if (!document) return;

  store.adoptDocument(variantId, document);
}

/**
 * Stamp several units as changed locally, in ONE read-modify-write of the
 * bookkeeping key.
 *
 * One call rather than one per unit because the whole key is re-serialized
 * every time: two units stamped separately parse and stringify the same object
 * twice, and either write can fail on its own, leaving half a save stamped.
 * The single write is also atomic against that.
 *
 * Every unit stamped together gets the SAME instant, which is the honest
 * reading — they were made dirty by one storage write.
 */
function touchUnitsForProfile(profileId, unitIds) {
  if (unitIds.length === 0) return;
  const next = stateFor(profileId);
  const modifiedAt = new Date().toISOString();
  for (const unitId of unitIds) next[unitId] = { modifiedAt };
  appStorage.setItem(storageKeyFor(profileId, STATE_KEY), JSON.stringify(next));
}

function touchUnits(unitIds) {
  touchUnitsForProfile('', unitIds);
}

/**
 * Stamp a unit as changed locally. Called when the app writes something the
 * sync layer cares about; without it, units other than résumés have no
 * timestamp anywhere in storage and conflicts could not be resolved.
 */
export function touchUnit(unitId) {
  touchUnits([unitId]);
}

/**
 * Install the successful-save callback without importing persistence here or
 * importing this module from persistence. main.js owns that graph edge.
 *
 * This path knows what the storage layer cannot: WHICH variant a
 * `resume-designer-data` write was for. The storage interceptor below therefore
 * leaves both of these unit kinds — `resume:<id>` and its history key — alone.
 */
export function registerPersistedSaveHandler(register) {
  register((variantId) => {
    const unitIds = [
      `${RESUME_UNIT_PREFIX}${variantId}`,
      `${KEY_UNIT_PREFIX}${HISTORY_PREFIX}${variantId}`,
    ];
    touchUnits(unitIds);
    return unitIds;
  });
}

// ── the storage-write interceptor ──────────────────────────────────────────
//
// Everything below serves one rule: a write to a key `classifyKey` calls
// 'synced' stamps its unit and names it to the transport. It is installed on
// `appStorage.setItem` (see setStorageWriteObserver there) rather than at the
// individual call sites, so the set of stamped keys is `classifyKey`'s list by
// construction and cannot drift from it.

/**
 * True while `applyUnits` is landing content that came FROM another device.
 *
 * `applyUnits` writes through the same `setItem` the interceptor sits on, so
 * without this an apply would stamp everything it landed and push it straight
 * back — an echo, and worse than a wasted round trip: the echo would carry a
 * modifiedAt minted HERE, newer than the origin device's, so this device would
 * then win the next conflict over content it never authored and park the real
 * author's edit.
 */
let applying = false;

/** Unit ids stamped since the last notification — see `onStorageFlush`. */
const pendingDirty = new Set();

let dirtyNotifier = null;

/**
 * Install the "tell the native shell what changed" callback. main.js owns this
 * graph edge, and hands over the same notifier persistence.js gets. Nothing is
 * registered on desktop or in the browser, where there is no native shell, so
 * the notification is a no-op there.
 */
export function setStorageDirtyNotifier(notify) {
  dirtyNotifier = typeof notify === 'function' ? notify : null;
}

/**
 * The `data:` unit payloads inside a raw `resume-designer-data` blob.
 *
 * `splitData` is ASKED which non-résumé fields become units rather than that
 * list being repeated here — a field added to it later is covered without this
 * function changing, which is the same anti-drift argument that put the
 * interceptor at the choke point at all. The variants are dropped before the
 * call so it never re-serializes every résumé just to answer this.
 */
function dataFieldPayloads(raw) {
  const payloads = new Map();
  const blob = parseJSON(raw, null);
  if (!blob || typeof blob !== 'object') return payloads;
  for (const unit of splitData({ ...blob, variants: undefined })) {
    payloads.set(unit.id, unit.payload);
  }
  return payloads;
}

/**
 * The `data:` units a blob write actually changed.
 *
 * Compared rather than stamped unconditionally, because `resume-designer-data`
 * is rewritten whole on every résumé auto-save. Stamping `data:settings` there
 * would give an UNCHANGED settings record a fresh time on every keystroke's
 * save — and that record would then beat a real settings edit made on another
 * device, which is a silent loss, not just wasted traffic.
 *
 * A field that vanished is not stamped: absence is not deletion here either.
 */
function changedDataUnits(previous, next) {
  const before = dataFieldPayloads(previous);
  const changed = [];
  for (const [id, payload] of dataFieldPayloads(next)) {
    if (before.get(id) !== payload) changed.push(id);
  }
  return changed;
}

/**
 * Which units a write to `logicalKey` makes locally modified.
 *
 * The blob and the history keys are the two the persistence path already
 * covers, and each is handled here by exactly the half it does NOT:
 *
 * - `resume-designer-data` holds every résumé plus `settings` and
 *   `userProfile`. Its `resume:<id>` units are stamped by
 *   registerPersistedSaveHandler, which knows the variant id this layer never
 *   sees, so they are left to it — stamping them here as well would name every
 *   résumé on every save. There is no `key:resume-designer-data` unit at all
 *   (`collectKeyUnit` refuses the blob), so the write maps to its `data:`
 *   fields or to nothing.
 * - `HISTORY_PREFIX + variantId` is left alone too, but the premise is narrower
 *   than "saveHistory for the loaded variant is its only writer". THREE things
 *   write a history key, and each is already answered for: store.js's
 *   saveHistory rides the persisted save that stamps both its units, so
 *   stamping here would name the same unit twice; `applyUnits` is an apply and
 *   must not stamp at all (see `applying`); and `parkLoser` runs from the
 *   conflict path, outside any save AND outside `applying`, so it stamps the
 *   unit itself. Unstamped, the parked loser went up carrying no modification
 *   time — which `resolveConflict` reads as -Infinity, so the archive that
 *   makes newer-wins safe would have lost every conflict it ever met.
 */
function unitsFor(logicalKey, value, previous) {
  if (classifyKey(logicalKey) !== 'synced') return [];
  if (logicalKey === DATA_KEY) return changedDataUnits(previous, value);
  if (logicalKey.startsWith(HISTORY_PREFIX)) return [];
  return [`${KEY_UNIT_PREFIX}${logicalKey}`];
}

function onStorageWrite(logicalKey, value, previous) {
  if (applying) return;
  const unitIds = unitsFor(logicalKey, value, previous);
  // Stamped BEFORE it is queued for notification: a unit named to the transport
  // but never stamped goes up with no modification time, and `resolveConflict`
  // reads that as -Infinity — it would lose every conflict it met. If the stamp
  // throws, nothing is queued and appStorage logs it.
  touchUnits(unitIds);
  for (const unitId of unitIds) pendingDirty.add(unitId);
}

/**
 * One notification per storage coalescing window, carrying every unit stamped
 * in it. Called from appStorage's drain, which every durability barrier forces
 * — so nothing sits here unannounced across a close.
 */
function onStorageFlush() {
  if (pendingDirty.size === 0) return;
  // HELD, not dropped, until there is somewhere to send them. The interceptor is
  // installed at module load and the shell installs the notifier during init(),
  // so the boot steps that write real content in between — the legacy Electron
  // migration, a profile adoption's source restore — land in that window. Their
  // ids are the only record that those bytes changed; persistence names a unit
  // once and will not name it again until it is edited again. The set is bounded
  // by the number of units, so holding costs nothing.
  if (!dirtyNotifier) return;
  // Notified BEFORE the set is cleared, for the same reason onStorageWrite
  // stamps before it queues: the bookkeeping that says "this is handled" must
  // come after the thing it claims. Cleared first, a notifier that threw took a
  // whole window's uploads with it — appStorage only logs the throw — and
  // nothing would name those units again until they were edited again. Today's
  // notifier is guarded and effectively cannot throw; this ordering is what
  // makes that fact not load-bearing. A throw leaves the ids in place and they
  // ride the next drain.
  //
  // Only the SNAPSHOT's ids are removed, never `clear()`: notifying can reach
  // the native shell, and anything that writes a synced key while it runs — a
  // re-entrant drain, a shell callback that saves — queues an id this drain
  // never announced. A blanket clear dropped exactly those, and a dropped id is
  // not re-announced until that unit is edited again.
  const unitIds = [...pendingDirty];
  dirtyNotifier(unitIds);
  for (const unitId of unitIds) pendingDirty.delete(unitId);
}

/** Wire the interceptor onto the storage facade. main.js owns this edge too. */
export function installStorageStamping(setObserver) {
  pendingDirty.clear();
  setObserver({ onWrite: onStorageWrite, onFlush: onStorageFlush });
}

function withModifiedAt(unit, recorded) {
  return { ...unit, modifiedAt: modifiedAtFor(unit.id, recorded) };
}

function collectDataUnits(recorded) {
  // Every `resume:` and `data:` unit lives inside the active profile's own
  // CloudKit zone — there is no shared variant of either kind.
  return splitData(readJSON(DATA_KEY, null))
    .map((unit) => withModifiedAt({ ...unit, scope: 'profile' }, recorded));
}

function collectKeyUnit(key, recorded) {
  // The data blob is represented by its `resume:` / `data:` units, never by
  // one key snapshot, and every other key must pass the shared sync policy.
  if (key === DATA_KEY || classifyKey(key) !== 'synced') return null;

  // Absent is not empty. An empty payload CLEARS the key on every receiving
  // device; a key this device cannot read is one it has nothing to say about.
  const payload = appStorage.getItem(key);
  if (payload == null) return null;

  const id = `${KEY_UNIT_PREFIX}${key}`;
  return withModifiedAt({
    id,
    kind: key === TOKEN_KEY ? 'tokenUsage' : 'plain',
    payload,
    scope: keyScope(key),
  }, recorded);
}

/**
 * Everything this device would push.
 *
 * The data blob is decomposed rather than sent whole — see syncUnits.js.
 * Device-local keys are filtered out here rather than at the transport, so a
 * transport bug cannot leak them.
 */
export function collectUnits() {
  const recorded = state();
  const units = collectDataUnits(recorded);

  // `appStorage.keys()` returns PHYSICAL keys — profile-namespaced
  // (`resume-p--<id>--<logical>`) — while `getItem`/`setItem` take LOGICAL ones
  // and map them internally. Classifying a physical key returns 'unknown' and
  // would sync nothing at all, so every key is reduced to its logical name
  // first. A key that is not namespaced (a shared key) is already logical.
  //
  // The cache holds EVERY profile's keys, not just the active one, so the
  // profile filter is not optional: reducing another profile's key to its
  // logical name emits it as if it belonged to the active profile, and reads it
  // back through `getItem`, which maps to the ACTIVE profile — so the unit
  // carries the wrong profile's value, or none at all. Same filter as
  // persistence.js's collectActiveOwnedKeys: namespaced keys must match the
  // active profile, unnamespaced ones (shared keys, and pre-adoption
  // unprefixed keys, which are the live workspace while mapping is off) pass.
  const activeProfile = getActiveProfileId();
  for (const physical of appStorage.keys()) {
    const split = splitPhysicalKey(physical);
    if (split && split.profileId !== activeProfile) continue;
    const key = split?.logicalKey ?? physical;
    const unit = collectKeyUnit(key, recorded);
    if (unit) units.push(unit);
  }

  return units;
}

/**
 * The one unit this device would push for `unitId`, or `null` when it has no
 * matching syncable value. Uses the same constructors and skip rules as the
 * full collection above so the two entry points cannot classify differently.
 */
export function collectUnit(unitId) {
  if (typeof unitId !== 'string') return null;
  const recorded = state();

  if (unitId.startsWith(RESUME_UNIT_PREFIX) || unitId.startsWith(DATA_UNIT_PREFIX)) {
    // One splitData pass over the blob is intentional: it keeps the exact same
    // decomposition rules as collectUnits without introducing a second parser.
    return collectDataUnits(recorded).find((unit) => unit.id === unitId) ?? null;
  }

  if (unitId.startsWith(KEY_UNIT_PREFIX)) {
    // Direct logical-key read; single-unit lookup never enumerates storage.
    return collectKeyUnit(unitId.slice(KEY_UNIT_PREFIX.length), recorded);
  }

  return null;
}

/**
 * Which CloudKit zone each named unit belongs in — `'shared'` or `'profile'`,
 * keyed by unit id.
 *
 * Asked by the transport when it QUEUES a save, and asked by ID because that is
 * all it has at that moment: a `CKRecord.ID` carries its zone, so the zone is
 * fixed when the change is queued rather than later, when the unit itself is
 * finally in hand — and what names a unit for send is an id, from `syncDirty`,
 * from the deferred set a failed send holds, or from a conflict re-offered at
 * the next start. The `scope` each collector stamps on a unit is the same answer
 * for the one path that carries whole units.
 *
 * ASKED rather than worked out in Swift. Which zone a unit belongs in follows
 * from what the unit IS, and no id-shaped rule on the native side is anything
 * but a second copy of that knowledge, kept in the one file that is not supposed
 * to hold any (see OPSync.swift's header, and the boundary correction that
 * moved conflict resolution here).
 *
 * Every answer comes from `keyScope`, the same one `collectKeyUnit` stamps on
 * the unit it builds, so a unit cannot be queued into one zone and collected as
 * if it belonged in the other. An id in no shape this module issues is
 * profile-scoped, which is what every unit was before the shared zone existed.
 */
export function unitScopes(unitIds) {
  const scopes = {};
  if (!Array.isArray(unitIds)) return scopes;
  for (const unitId of unitIds) {
    if (typeof unitId !== 'string') continue;
    scopes[unitId] = unitId.startsWith(KEY_UNIT_PREFIX)
      ? keyScope(unitId.slice(KEY_UNIT_PREFIX.length))
      : 'profile';
  }
  return scopes;
}

/**
 * Land units that arrived from another device.
 *
 * Résumé and `data:` units are merged into the blob so `currentVariantId` —
 * which never travelled — is left alone, and a résumé for the variant the app
 * has OPEN is handed to the store as well, because that document lives in
 * memory too (adoptLoadedDocument). A résumé is refused outright when it
 * carries no document (landsAsResume) and when it would land on an edit still
 * in flight (interruptsLiveEditing); a refusal destroys nothing — see
 * interruptsLiveEditing for where a refused unit goes.
 *
 * Token usage and version history, the two units that accumulate, take the
 * union rule (accumulatorFor). EVERY OTHER unit is a snapshot, and every
 * snapshot must be newer than the copy this device holds or it is refused
 * (outranksLocalCopy) — résumés, both `data:` fields and every plain key alike.
 * A unit naming a device-local key is refused: nothing should have sent it, and
 * honouring it would let one device's zoom overwrite another's.
 *
 * A key something holds a whole in-memory copy of — the applications list, the
 * job list, the chat threads — is not finished by the storage write either, for
 * the same reason the résumé is not: the owner is asked to adopt what was just
 * written, and asked FIRST whether it can. See KEY_OWNERS.
 *
 * Every write below goes through the storage interceptor, so the whole landing
 * runs with stamping suppressed — see `applying` for what an echo would cost.
 * The flag is restored in a `finally`: this reaches store.js, which can throw,
 * and suppression left on would silently stop every later local edit from ever
 * being uploaded — a failure with no symptom until another device is missing
 * a day's work.
 *
 * ── WHAT `applied` MEANS, AND WHY THIS FUNCTION IS ASYNC ──────────────────
 *
 * `applied` is how many units are DURABLY this device's — on disk, not in a
 * cache — and that is the whole of this function's answer to the transport.
 * The count is the only thing `deliver` (OPSync.swift) keeps the server's
 * change tags on, and a change tag is a claim to know which server version this
 * device is editing.
 *
 * It used to be the count that reached STORAGE, which on every shipped desktop
 * and iOS build is a write-behind cache: `appStorage.setItem` updates a Map and
 * schedules the disk write 250ms later, and a failed write is deliberately kept
 * in memory rather than dropped (see appStorage.js). So the count was true of
 * the cache and said nothing about the disk. Kill the app inside that window —
 * or let the write fail — and it relaunches holding its OLD content paired with
 * the NEW change tag; its next edit of that unit is accepted by CloudKit as a
 * clean update and destroys the other device's newer version. No
 * `serverRecordChanged`, nothing parked, nothing logged. Apple states the
 * requirement directly: CKSyncEngine state must be persisted alongside the app
 * data and the fetched changes it was earned from (CKSyncEngineEvent.h). Here
 * the content and the sync state are two independent stores, and this await is
 * the durability barrier between them.
 *
 * `appStorage.flush()` is that barrier, and it already answers exactly the right
 * question — `true` when every awaited write reached disk, `false` when any of
 * them failed. Its answer is whole-store rather than per-key, so a failure
 * anywhere makes this report ZERO: which units landed is not knowable, and the
 * only honest reading of that is "none of them are confirmed". Over-forfeiting
 * costs one round trip (the next save quotes no tag, CloudKit answers
 * `serverRecordChanged`, both copies are compared and the loser is parked);
 * under-forfeiting is the silent overwrite above. Nothing is destroyed by a
 * `0` — the content is still on the server, still on the device that wrote it,
 * and still in this device's cache on its way to disk.
 *
 * ── THE AWAIT IS OUTSIDE THE SUPPRESSED WINDOW, DELIBERATELY ──────────────
 *
 * `landFetchedUnits` stays entirely synchronous and the `applying` flag is
 * restored in the `finally` BEFORE anything is awaited, so the suppressed window
 * is still one run-to-completion turn of the event loop: no local write can
 * interleave with it and be swallowed as an echo, which is what makes the flag
 * safe at all. Nothing below the `finally` may ever move above it.
 */
export async function applyUnits(units) {
  // A restore is mid-flight. `appStorage` is RECORDING every external write and
  // skipping both the cache and the disk (beginRestoreGuard), so a landing here
  // writes nothing at all — and `flush()` would still answer `true`, because
  // nothing is dirty. That is this same bug one layer further out: a tag kept
  // for content that was never stored, and the reload the restore ends with
  // boots from the backup. Refusing is the safe direction, and these units are
  // offered again at the next start.
  if (appStorage.isRestoreGuardActive()) return { applied: 0 };

  const wasApplying = applying;
  applying = true;
  let landed;
  try {
    landed = landFetchedUnits(units);
  } finally {
    applying = wasApplying;
  }

  // Nothing landed means nothing was written, so there is no disk to wait for —
  // and forcing a drain here would only push somebody else's coalescing window
  // early. Every path that increments the count writes first.
  if (landed.applied === 0) return landed;

  return (await appStorage.flush()) ? landed : { applied: 0 };
}

function landFetchedUnits(units) {
  const incoming = Array.isArray(units) ? units : [];
  let applied = 0;

  // Both halves of the blob, not just the résumés: `data:settings` and
  // `data:userProfile` are emitted by splitData and reassembled by mergeData,
  // but matching only `resume:` here dropped them silently — settings synced
  // out of this device and never into it.
  //
  // `mergeData` silently skips a payload that is not a string or will not parse
  // (syncUnits.js), and skips a `data:` field it does not know, so the offered
  // count reports records that never landed — and this count is how a caller
  // tells a no-op from a failure. Filtering by the same rules makes the number
  // the truth, and leaves the blob untouched when nothing at all can land.
  //
  // Four more rules, for four different reasons and to the same effect — the
  // unit must not land, and the count has to say so. Every one of them is
  // decided HERE rather than downstream, because a unit that reaches `mergeData`
  // is on disk whatever the store then does with it, and disk disagreeing with
  // memory is the failure this whole path is written to avoid. A résumé must
  // carry a document (landsAsResume) and must not land on top of an edit in
  // flight (interruptsLiveEditing); a `data:` field must be a value of the shape
  // that field holds (landsAsDataField) and must not land on top of an open
  // profile edit (interruptsProfileEditing). BOTH kinds are snapshots, so both
  // must also be newer than the copy this device holds (outranksLocalCopy).
  const landing = incoming.filter((unit) => {
    const id = typeof unit?.id === 'string' ? unit.id : '';
    if (!id.startsWith(RESUME_UNIT_PREFIX) && !id.startsWith(DATA_UNIT_PREFIX)) return false;
    if (!parsesAsJSON(unit.payload)) return false;
    const profileId = typeof unit?.profileId === 'string' ? unit.profileId : '';
    // A profile the registry does not list cannot be opened or listed, so its
    // namespace would be unreachable bytes. The registry lands from opShared and
    // this unit comes back on the next fetch.
    if (profileId && !listProfiles().some((p) => p.id === profileId)) return false;
    const dataKey = storageKeyFor(profileId, DATA_KEY);
    const recordedForUnit = stateFor(profileId);
    if (!id.startsWith(RESUME_UNIT_PREFIX)) {
      return landsAsDataField(unit)
        && (dataKey !== DATA_KEY || !interruptsProfileEditing(unit))
        && outranksLocalCopy(unit, recordedForUnit);
    }
    return landsAsResume(unit)
      && (dataKey !== DATA_KEY || !interruptsLiveEditing(unit))
      && outranksLocalCopy(unit, recordedForUnit);
  });
  for (const [profileId, group] of groupByProfile(landing)) {
    const dataKey = storageKeyFor(profileId, DATA_KEY);
    const blob = readJSON(dataKey, {});
    appStorage.setItem(dataKey, JSON.stringify(mergeData(blob, group)));
    applied += group.length;
    // AFTER the storage write, never before: the store is what the screen
    // reads, and putting a résumé there that the write then failed to persist
    // (quota) would show the user content this device does not hold.
    //
    // Only for the OPEN profile. Another profile has no mounted editor and no
    // loaded document, so there is nothing to hand these bytes to — and
    // handing them over anyway would show one workspace's résumé inside
    // another.
    if (dataKey !== DATA_KEY) continue;
    for (const unit of group) {
      if (unit.id.startsWith(RESUME_UNIT_PREFIX)) adoptLoadedDocument(unit);
      else if (unit.id === USER_PROFILE_UNIT_ID) adoptStoredUserProfile();
    }
  }

  for (const unit of incoming) {
    if (!unit?.id?.startsWith(KEY_UNIT_PREFIX)) continue;
    const key = unit.id.slice(KEY_UNIT_PREFIX.length);
    if (classifyKey(key) !== 'synced') continue;
    const profileId = typeof unit?.profileId === 'string' ? unit.profileId : '';
    // A profile the registry does not list cannot be opened or listed, so its
    // namespace would be unreachable bytes. The registry lands from opShared and
    // this unit comes back on the next fetch.
    if (profileId && !listProfiles().some((p) => p.id === profileId)) continue;
    const storageKey = storageKeyFor(profileId, key);
    // `appStorage.setItem` does `String(value)`, so a malformed unit off the
    // native bridge would write the literal text `undefined` into a real
    // storage key — data that looks valid and parses nowhere. `mergeData`
    // guards résumé payloads the same way (syncUnits.js).
    if (typeof unit.payload !== 'string') continue;

    // Both decided BEFORE the write, exactly as the résumé's guards are, and for
    // the same reason: a unit that reaches storage is on disk whatever its owner
    // then does with it, and every one of these owners turns garbage on its key
    // into an empty list on the next boot. See KEY_OWNERS, and
    // interruptsLiveEditing for where a refused unit goes.
    const owner = KEY_OWNERS.get(key);
    if (owner && !owner.lands(unit.payload)) continue;
    if (storageKey === key && owner?.isBusy?.()) continue;

    const accumulate = accumulatorFor(key);
    if (accumulate) {
      if (!accumulate(key, unit, profileId)) continue;
    } else {
      // A snapshot, so newer wins — decided BEFORE the write like every other
      // refusal here, and by the same `resolveConflict` the résumés and the
      // save-time conflict path use. See `outranksLocalCopy` for the race an
      // unguarded write loses, which destroys the local edit AND promotes the
      // stale copy to newest.
      const recordedForUnit = stateFor(profileId);
      if (!outranksLocalCopy(unit, recordedForUnit)) continue;
      appStorage.setItem(storageKey, unit.payload);
    }
    // AFTER the write, never before — the same ordering adoptLoadedDocument
    // takes: a module told to adopt bytes the write then failed to persist
    // (quota) would show the user content this device does not hold.
    if (storageKey === key) owner?.adopt();
    applied += 1;
  }

  return { applied };
}

/** Every conflict refused: the shape of an answer that resolves nothing. */
const nothingResolved = () => ({ resolved: [], parked: 0 });

/** Whether a side of a conflict is a unit at all. */
function isUnit(unit) {
  return !!unit && typeof unit.id === 'string' && !!unit.id && typeof unit.payload === 'string';
}

/**
 * Resolve save conflicts, and land the resolutions durably.
 *
 * CloudKit rejects a save whose record moved underneath it and hands back the
 * version it holds. The transport used to resolve that ITSELF — a Swift copy of
 * `resolveConflict`, run for every kind — and that was two mistakes in one. It
 * was a second copy of a rule both devices have to compute identically, and it
 * was simply wrong for the two units that do not take newer-wins at all: the
 * loser of a token-usage or version-history conflict went to `parkLoser`, which
 * has nowhere to put a unit that is not a résumé, so CloudKit ended up holding
 * ONE SIDE rather than the union. The other device's events survived only in
 * this device's local copy, and a reinstall before the next local append made
 * them unrecoverable. The fetch path had honoured the union rule all along;
 * only the save path did not.
 *
 * So the transport carries both opaque versions across and decides nothing.
 * Each conflict is `{ local, server }` — the unit this device tried to send and
 * the one the server answered with — and the answer is, per unit:
 *
 *     { id, retry }   `retry`: does the SERVER still owe an update?
 *
 * plus `parked`, the number of losers that reached a version history. That
 * count is the only thing the conflict notice is raised on, and only this side
 * can produce it: a union has no loser, and a snapshot whose loser is not a
 * résumé has nowhere to park one.
 *
 * A unit MISSING from `resolved` is a refusal, and refusing is the safe
 * direction: the transport forfeits that record's change tag, queues no save,
 * and offers the unit again at the next start, where the whole comparison
 * happens over. Nothing is destroyed by one — both versions are still where
 * they were.
 *
 * ── WHAT THE RETRY ACTUALLY SENDS ─────────────────────────────────────────
 *
 * Not a payload handed back over the bridge. The resolution is written to
 * STORAGE here, and the transport re-queues the record and asks for it again at
 * send time (`recordToSend` → `collectUnit`). That is the only reading of "the
 * resolved unit" that cannot go stale: a local edit landing between the
 * resolution and the send collapses into the same queued change, so a payload
 * cached on the Swift side would be sent INSTEAD of that edit and the edit would
 * never be named again. Asking at send time yields the resolution, or something
 * newer built on top of it, and both are correct — what matters for the change
 * tag is that the SERVER'S version is accounted for here, which it is: merged,
 * applied, or parked.
 *
 * ── THE SAME TWO RULES `applyUnits` RUNS UNDER, FOR THE SAME REASONS ───────
 *
 * Everything below runs SYNCHRONOUSLY inside the `applying` window, and the one
 * await is textually after the `finally` that restores the flag — so the
 * suppressed region is still a single run-to-completion turn and no local write
 * can interleave with it and be swallowed as an echo. `mergeHistory`,
 * `mergeTokenUsage`, `landFetchedUnits` and `parkLoser` are all synchronous,
 * which is what makes that possible. Nothing here may ever move above that
 * `finally`.
 *
 * And the durability barrier: a resolution that reached the write-behind cache
 * is not a resolution. The transport keeps the SERVER's change tag on this
 * answer, and a tag is a claim to know which server version this device is
 * editing — a claim a device that relaunches without the bytes cannot make. So
 * the answer waits for the disk, and a failed flush forfeits the WHOLE batch,
 * including the units that wrote nothing: which ones landed is not knowable, and
 * over-forfeiting costs one round trip while under-forfeiting is a silent
 * overwrite.
 */
export async function resolveConflicts(conflicts) {
  // The same refusal `applyUnits` opens with, for the same reason: under a
  // restore guard `setItem` records the write and touches neither the cache nor
  // the disk, while `flush()` would still answer `true` over nothing dirty. The
  // restore ends in a reload from the backup, so a tag kept here would describe
  // content that is about to be replaced wholesale.
  if (appStorage.isRestoreGuardActive()) return nothingResolved();

  const wasApplying = applying;
  applying = true;
  let answer;
  try {
    answer = resolveEachConflict(conflicts);
  } finally {
    applying = wasApplying;
  }

  // Every acknowledged resolution waits for the disk, including a local winner
  // that wrote nothing while resolving: the winner may exist only in the
  // write-behind cache. A failed flush forfeits the WHOLE batch because which
  // units reached disk is not knowable. UNCONDITIONALLY — there is deliberately
  // no "did this resolution write anything" flag to branch on, because the
  // version that had one skipped the barrier for exactly the case that needed
  // it: a local winner with nowhere to park writes nothing and can still be
  // cache-only.
  return (await appStorage.flush()) ? answer : nothingResolved();
}

function resolveEachConflict(conflicts) {
  const resolved = [];
  let parked = 0;

  for (const conflict of Array.isArray(conflicts) ? conflicts : []) {
    const local = conflict?.local;
    const server = conflict?.server;
    // Both sides, or nothing. A resolution compares two versions of ONE unit,
    // and a pair that does not agree on the id is a transport bug — refusing it
    // costs a round trip, while guessing would write one unit's content over
    // another's.
    if (!isUnit(local) || !isUnit(server) || local.id !== server.id) continue;

    const outcome = resolveOneConflict(local, server);
    if (!outcome) continue;
    resolved.push({ id: server.id, retry: outcome.retry });
    if (outcome.parked) parked += 1;
  }

  return { resolved, parked };
}

/**
 * One conflict, or `null` when this device cannot resolve it.
 *
 * The split is `accumulatorFor`'s and no other: the ONE list that already says
 * which units accumulate is what decides whether this is a union or a
 * comparison, so a third append-shaped unit cannot get a merge on the fetch path
 * and keep newer-wins here.
 */
function resolveOneConflict(local, server) {
  const accumulate = server.id.startsWith(KEY_UNIT_PREFIX)
    ? accumulatorFor(server.id.slice(KEY_UNIT_PREFIX.length))
    : null;

  if (accumulate) {
    // The union, through the same function the fetch path lands one with — one
    // merge for both directions, so a save conflict and a fetch cannot disagree
    // about what two documents come to. The other side is read from STORAGE
    // rather than from `local`: the payload the transport tried to send is a
    // snapshot taken before the send, the disk may have moved on since, and a
    // union of both is still a union. There is no loser, so nothing is parked
    // and nothing needs to be — which is the fact only this side can know.
    const key = server.id.slice(KEY_UNIT_PREFIX.length);
    // Nothing should ever have sent a device-local key, and honouring one here
    // would let one device's zoom overwrite another's — the same refusal
    // `landFetchedUnits` makes.
    if (classifyKey(key) !== 'synced') return null;
    // A payload that will not parse is refused rather than written: absence is
    // never deletion, and half a merge is not a merge.
    if (!accumulate(key, server, server.profileId)) return null;
    return { retry: true, parked: false };
  }

  // A snapshot. Newer wins, by the same `resolveConflict` the fetch path
  // compares with, over the two versions the transport actually had in hand.
  if (server.id.startsWith(KEY_UNIT_PREFIX)
      && classifyKey(server.id.slice(KEY_UNIT_PREFIX.length)) !== 'synced') return null;
  if (resolveConflict(local, server).winner === local) {
    // Ours is newer, so the server owes an update and its copy is the loser.
    // `parkLoser` takes it where there is a version history to take it — which
    // is résumés and nothing else — and refuses otherwise, which is precisely
    // what newer-wins MEANS for a snapshot with nowhere to park: the older copy
    // is discarded. Refusing the whole resolution over that would be worse than
    // the discard: the tag would be forfeited, the same record would come back,
    // and this device's newer content would never reach iCloud.
    const wasParked = parkLoser(server.id, server.payload, server.profileId);
    return { retry: true, parked: wasParked };
  }

  // Theirs is newer, or the two tie and the tie goes to the server so both
  // devices break it the same way. It lands through the FETCH path's own
  // filters, so a unit that could not land from a fetch cannot land from a
  // conflict either — including the case that matters most here, a local edit
  // that landed between the send and this answer: `outranksLocalCopy` re-asks
  // against the stamp recorded NOW, so the newer local copy refuses the landing
  // instead of being overwritten by the comparison above.
  if (landFetchedUnits([server]).applied !== 1) return null;
  // Our copy is the loser, parked AFTER the write for the same reason
  // `landFetchedUnits` adopts after its own: the entry records a version this
  // device has just stopped holding. Nothing is retried — the server already
  // holds the winner, and sending our copy back would push this device's stamp
  // over the version it has only just taken.
  return { retry: false, parked: parkLoser(local.id, local.payload, local.profileId) };
}

/**
 * Park a conflict's losing version in that résumé's history.
 *
 * This is what makes newer-wins safe: nothing is destroyed, and recovery is a
 * restore the app already supports. Only résumés have history, so a non-résumé
 * unit returns false rather than inventing somewhere to put it.
 *
 * The stored value at `HISTORY_PREFIX + variantId` is NOT a bare array — it is
 * `{ history: [...], historyIndex }`, written and read by store.js
 * (saveHistory/loadHistory) and rendered by HistoryDialog.jsx, whose entries
 * carry `{ data, timestamp, description, changeType }`. Writing any other
 * shape — or writing to any other key — would park the loser somewhere the
 * version-history dialog can never read it back from, which is a silent data
 * loss dressed up as a successful park.
 *
 * An entry's `data` is the DOCUMENT, and the unit's payload is the whole
 * variant RECORD around it (resumeDocument). Parking the record put the wrong
 * shape one level up: the entry listed and restored fine, and restoring it
 * produced a near-empty résumé named after the variant, because `name` is the
 * only field the two shapes share. That is the same silent loss as writing the
 * wrong key, only harder to see — the whole conflict design rests on a parked
 * loser being RESTORABLE, or "newer wins, nothing is discarded" is not true.
 * A payload with no document is refused for that reason rather than parked:
 * `resolveConflicts` counts what actually landed, and a version that is not in
 * Version history must not be announced as being there.
 *
 * WHERE in that array the entry goes decides whether it survives at all, and
 * both halves of this function are written to the same rule — the entry goes in
 * BELOW `historyIndex`, at `historyIndex - 1`:
 *
 * - Everything after `historyIndex` is store.js's redo future, and pushHistory
 *   (store.js) splices the future away on the very next local edit. Appending
 *   there and leaving the index alone — the obvious reading of "don't change
 *   what's current" — parks the loser exactly where one keystroke deletes it.
 * - In the past it is out of that splice's reach, and the index still points at
 *   the same ENTRY it pointed at before, so the live document's notion of
 *   "current" is unchanged. Only its numeric position moved.
 * - Below the index rather than AT it, because the index moves up with it: an
 *   entry at `historyIndex` would make the LOSER what `historyIndex` points at,
 *   and that has to stay the entry the document is on. See store.js's
 *   adoptHistoryEntry, which the loaded-variant path shares this rule with, for
 *   why it is not index 0 either.
 *
 * Undo staying away from the parked entry is store.js's job, not this rule's:
 * it skips `sync-conflict` entries wherever they ended up, which is the only
 * thing that covers the arrangements no placement here can (a history whose
 * index is already 0, and a variant with no history at all — below).
 *
 * That is necessary but not sufficient for the variant the app currently has
 * open: store.js holds that variant's history in memory and saveHistory rewrites
 * the whole key from that array, which never saw this entry. So the loaded
 * variant is handed to the store instead of written here.
 */
export function parkLoser(unitId, payload, profileId = '') {
  if (typeof unitId !== 'string' || !unitId.startsWith(RESUME_UNIT_PREFIX)) return false;
  const variantId = unitId.slice(RESUME_UNIT_PREFIX.length);
  if (!variantId) return false;

  const data = resumeDocument(payload);
  if (!data) return false;

  const entry = {
    data,
    timestamp: new Date().toISOString(),
    // Says which two versions existed and which one this is, and NOT whose it
    // was: the loser is this device's own copy whenever the remote one is
    // newer, and even the server's copy is often this device's earlier upload.
    // See TYPE_LABELS['sync-conflict'] in ../historyEntryLabels.js, which the
    // web dialog and the iOS sheet both draw the badge from.
    description: 'Two devices edited this resume; this is the earlier version.',
    // The string store.js's undo/redo traversal steps over, taken from there
    // rather than written twice.
    changeType: CHANGE_TYPES.SYNC_CONFLICT,
  };

  // Both branches below CHANGE that variant's history unit, and this is the one
  // history write no persisted save accompanies: `resolveConflicts` calls this
  // from the conflict path, which is not a save. The storage interceptor skips
  // history keys (see `unitsFor`) on the premise that the persistence path
  // stamps them, and this is the counterexample — so the stamp is taken here.
  // That it now runs INSIDE the `applying` window changes nothing about it:
  // `applying` suppresses the interceptor, the interceptor was never going to
  // stamp a history key, and `touchUnit` is a direct write rather than a
  // reaction to one. Without the stamp the unit went up with no modification
  // time, which resolveConflict reads as -Infinity: the parked loser, which is
  // the whole reason newer-wins destroys nothing, would lose every conflict it
  // ever met and be overwritten by any device that had not seen the park.
  const stampParked = () => touchUnitsForProfile(
    profileId, [`${KEY_UNIT_PREFIX}${HISTORY_PREFIX}${variantId}`],
  );

  // The loaded variant: only the store can make this stick (see above). It
  // reports false for any other variant, and this is the one call that can tell
  // — `currentVariantId` is private to store.js.
  const key = `${HISTORY_PREFIX}${variantId}`;
  const storageKey = storageKeyFor(profileId, key);
  if (storageKey === key && store.adoptHistoryEntry(variantId, entry)) {
    stampParked();
    return true;
  }

  // Any other variant: nothing holds its history in memory, so the key is ours
  // to write.
  const raw = readJSON(storageKey, null);
  const existingHistory = raw && typeof raw === 'object' && Array.isArray(raw.history)
    ? raw.history
    : [];
  // Mirrors store.js's own loadHistory() fallback (`historyData.historyIndex
  // ?? history.length - 1`) so a variant with no recorded index yet — or none
  // at all — comes out exactly as store.js would compute it on load.
  //
  // A variant this device has never opened has NO history, so `current` is -1
  // and the park becomes the whole document, `{ history: [loser],
  // historyIndex: 0 }` — the loser marked current, there being nothing else to
  // mark. There is no better number to write here: an explicit -1 would make
  // pushHistory() splice the entry away on the first edit, which is the one
  // thing parking must survive. store.js's setData() corrects it on load, by
  // recording the state actually on screen.
  const current = Number.isInteger(raw?.historyIndex) ? raw.historyIndex : existingHistory.length - 1;
  const at = Math.max(0, current - 1);

  const history = [...existingHistory.slice(0, at), entry, ...existingHistory.slice(at)];
  appStorage.setItem(storageKey, JSON.stringify({ history, historyIndex: Math.max(0, current + 1) }));
  // AFTER the write, so a quota throw above leaves no unit claiming a change
  // that never landed — the same ordering appStorage's own observer takes.
  stampParked();
  return true;
}

export { resolveConflict };
