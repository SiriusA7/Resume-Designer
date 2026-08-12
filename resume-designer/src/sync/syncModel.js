/**
 * The sync layer's only contact with storage.
 *
 * Everything above this file is pure; everything below it is `appStorage`.
 * Swift calls into here through the bridge and never learns any of it: a unit
 * crosses as `{ id, kind, payload, modifiedAt }` with an opaque payload.
 */
import { appStorage } from '../appStorage.js';
import { splitPhysicalKey, BACKUP_HISTORY_PREFIX, SYNC_STATE_KEY } from '../profileKeys.js';
import { getActiveProfileId } from '../profiles.js';
// The store owns the loaded variant's history IN MEMORY and rewrites the whole
// key from it on every edit, so parking a loser for that variant has to go
// through it — see parkLoser.
import { store, CHANGE_TYPES } from '../store.js';
import { classifyKey } from './syncKeys.js';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from './syncUnits.js';
import { mergeTokenUsage, mergeHistory, resolveConflict } from './syncMerge.js';

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
// Undo/redo history key prefix. Re-exported from profileKeys.js rather than
// re-declared, same as store.js's own HISTORY_KEY_PREFIX: it has to stay
// byte-identical to what store.js reads (HISTORY_KEY_PREFIX + variantId), or
// a parked loser lands at a key the version-history dialog never reads from.
const HISTORY_PREFIX = BACKUP_HISTORY_PREFIX;

const readJSON = (key, fallback) => {
  const raw = appStorage.getItem(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const state = () => readJSON(STATE_KEY, {});

/**
 * The recorded modification time, or `null` when this device never stamped one.
 *
 * NOT `new Date()`. An unstamped unit would then claim to have been modified at
 * the instant it was collected — newer than any real remote stamp — so the
 * collecting device would win EVERY conflict and park or discard the other
 * device's genuine edit on a timestamp it never earned. Nothing calls
 * `touchUnit` yet, so today that is every unit this device sends.
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
 */
function landsAsDataField(unit) {
  const landed = mergeData({}, [unit]);
  return Object.keys(landed).some((field) => field !== 'variants' && landed[field] !== null);
}

/**
 * Stamp a unit as changed locally. Called when the app writes something the
 * sync layer cares about; without it, units other than résumés have no
 * timestamp anywhere in storage and conflicts could not be resolved.
 */
export function touchUnit(unitId) {
  const next = state();
  next[unitId] = { modifiedAt: new Date().toISOString() };
  appStorage.setItem(STATE_KEY, JSON.stringify(next));
}

/**
 * Install the successful-save callback without importing persistence here or
 * importing this module from persistence. main.js owns that graph edge.
 */
export function registerPersistedSaveHandler(register) {
  register((variantId) => {
    const unitIds = [
      `${RESUME_UNIT_PREFIX}${variantId}`,
      `${KEY_UNIT_PREFIX}${HISTORY_PREFIX}${variantId}`,
    ];
    for (const unitId of unitIds) touchUnit(unitId);
    return unitIds;
  });
}

function withModifiedAt(unit, recorded) {
  return { ...unit, modifiedAt: modifiedAtFor(unit.id, recorded) };
}

function collectDataUnits(recorded) {
  return splitData(readJSON(DATA_KEY, null))
    .map((unit) => withModifiedAt(unit, recorded));
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
 * Land units that arrived from another device.
 *
 * Résumé and `data:` units are merged into the blob so `currentVariantId` —
 * which never travelled — is left alone. Token usage and version history, the
 * two units that accumulate, take the union rule; everything else is a
 * snapshot and is written as it arrived. A unit naming a device-local key is
 * refused: nothing should have sent it, and honouring it would let one device's
 * zoom overwrite another's.
 */
export function applyUnits(units) {
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
  const landing = incoming.filter((unit) => {
    const id = typeof unit?.id === 'string' ? unit.id : '';
    if (!id.startsWith(RESUME_UNIT_PREFIX) && !id.startsWith(DATA_UNIT_PREFIX)) return false;
    if (!parsesAsJSON(unit.payload)) return false;
    return id.startsWith(RESUME_UNIT_PREFIX) || landsAsDataField(unit);
  });
  if (landing.length > 0) {
    const blob = readJSON(DATA_KEY, {});
    appStorage.setItem(DATA_KEY, JSON.stringify(mergeData(blob, landing)));
    applied += landing.length;
  }

  for (const unit of incoming) {
    if (!unit?.id?.startsWith(KEY_UNIT_PREFIX)) continue;
    const key = unit.id.slice(KEY_UNIT_PREFIX.length);
    if (classifyKey(key) !== 'synced') continue;
    // `appStorage.setItem` does `String(value)`, so a malformed unit off the
    // native bridge would write the literal text `undefined` into a real
    // storage key — data that looks valid and parses nowhere. `mergeData`
    // guards résumé payloads the same way (syncUnits.js).
    if (typeof unit.payload !== 'string') continue;

    if (key === TOKEN_KEY) {
      let remote;
      try {
        remote = JSON.parse(unit.payload);
      } catch {
        continue;
      }
      const merged = mergeTokenUsage(readJSON(TOKEN_KEY, null), remote);
      appStorage.setItem(TOKEN_KEY, JSON.stringify(merged));
    } else if (key.startsWith(HISTORY_PREFIX)) {
      // Version history accumulates, so it merges rather than replaces — and
      // it is the one unit where replacing was self-defeating: a `setItem`
      // here overwrote local history wholesale, destroying a loser parkLoser
      // had just parked to make newer-wins safe.
      let remote;
      try {
        remote = JSON.parse(unit.payload);
      } catch {
        continue;
      }
      const variantId = key.slice(HISTORY_PREFIX.length);
      // The loaded variant's history lives in store.js's in-memory array and
      // saveHistory rewrites the whole key from it, so a merge written to
      // storage here is undone by the next edit — the same trap parkLoser
      // documents, and the same answer: hand it to the store, which is the
      // only thing that can tell (currentVariantId is private to it).
      if (!store.adoptHistory(variantId, remote)) {
        appStorage.setItem(key, JSON.stringify(mergeHistory(readJSON(key, null), remote)));
      }
    } else {
      appStorage.setItem(key, unit.payload);
    }
    applied += 1;
  }

  return { applied };
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
export function parkLoser(unitId, payload) {
  if (typeof unitId !== 'string' || !unitId.startsWith(RESUME_UNIT_PREFIX)) return false;
  const variantId = unitId.slice(RESUME_UNIT_PREFIX.length);
  if (!variantId) return false;

  let data;
  try {
    data = JSON.parse(payload);
  } catch {
    return false;
  }

  const entry = {
    data,
    timestamp: new Date().toISOString(),
    description: 'Conflicting edit synced from another device',
    // The string store.js's undo/redo traversal steps over, taken from there
    // rather than written twice.
    changeType: CHANGE_TYPES.SYNC_CONFLICT,
  };

  // The loaded variant: only the store can make this stick (see above). It
  // reports false for any other variant, and this is the one call that can tell
  // — `currentVariantId` is private to store.js.
  if (store.adoptHistoryEntry(variantId, entry)) return true;

  // Any other variant: nothing holds its history in memory, so the key is ours
  // to write.
  const key = `${HISTORY_PREFIX}${variantId}`;
  const raw = readJSON(key, null);
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
  appStorage.setItem(key, JSON.stringify({ history, historyIndex: Math.max(0, current + 1) }));
  return true;
}

export { resolveConflict };
