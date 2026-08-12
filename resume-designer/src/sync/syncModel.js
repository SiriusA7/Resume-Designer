/**
 * The sync layer's only contact with storage.
 *
 * Everything above this file is pure; everything below it is `appStorage`.
 * Swift calls into here through the bridge and never learns any of it: a unit
 * crosses as `{ id, kind, payload, modifiedAt }` with an opaque payload.
 */
import { appStorage } from '../appStorage.js';
import { splitPhysicalKey, BACKUP_HISTORY_PREFIX } from '../profileKeys.js';
import { classifyKey } from './syncKeys.js';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from './syncUnits.js';
import { mergeTokenUsage, resolveConflict } from './syncMerge.js';

const DATA_KEY = 'resume-designer-data';
const TOKEN_KEY = 'resume-designer-token-usage';
const STATE_KEY = 'resume-designer-sync-state';
const KEY_UNIT_PREFIX = 'key:';
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

/** Now, or the recorded time if this unit has one. */
function modifiedAtFor(unitId, recorded) {
  return recorded[unitId]?.modifiedAt || new Date().toISOString();
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
 * Everything this device would push.
 *
 * The data blob is decomposed rather than sent whole — see syncUnits.js.
 * Device-local keys are filtered out here rather than at the transport, so a
 * transport bug cannot leak them.
 */
export function collectUnits() {
  const recorded = state();
  const units = [];

  for (const unit of splitData(readJSON(DATA_KEY, null))) {
    units.push({ ...unit, modifiedAt: modifiedAtFor(unit.id, recorded) });
  }

  // `appStorage.keys()` returns PHYSICAL keys — profile-namespaced
  // (`resume-p--<id>--<logical>`) — while `getItem`/`setItem` take LOGICAL ones
  // and map them internally. Classifying a physical key returns 'unknown' and
  // would sync nothing at all, so every key is reduced to its logical name
  // first. A key that is not namespaced (a shared key) is already logical.
  for (const physical of appStorage.keys()) {
    const key = splitPhysicalKey(physical)?.logicalKey ?? physical;
    if (key === DATA_KEY) continue; // decomposed above
    if (classifyKey(key) !== 'synced') continue;
    const id = `${KEY_UNIT_PREFIX}${key}`;
    units.push({
      id,
      kind: key === TOKEN_KEY ? 'tokenUsage' : 'plain',
      payload: appStorage.getItem(key) ?? '',
      modifiedAt: modifiedAtFor(id, recorded),
    });
  }

  return units;
}

/**
 * Land units that arrived from another device.
 *
 * Résumé units are merged into the blob so `currentVariantId` — which never
 * travelled — is left alone. Token usage takes the union rule. A unit naming a
 * device-local key is refused: nothing should have sent it, and honouring it
 * would let one device's zoom overwrite another's.
 */
export function applyUnits(units) {
  const incoming = Array.isArray(units) ? units : [];
  const resumeUnits = incoming.filter((u) => u?.id?.startsWith(RESUME_UNIT_PREFIX));
  let applied = 0;

  if (resumeUnits.length > 0) {
    const blob = readJSON(DATA_KEY, {});
    appStorage.setItem(DATA_KEY, JSON.stringify(mergeData(blob, resumeUnits)));
    applied += resumeUnits.length;
  }

  for (const unit of incoming) {
    if (!unit?.id?.startsWith(KEY_UNIT_PREFIX)) continue;
    const key = unit.id.slice(KEY_UNIT_PREFIX.length);
    if (classifyKey(key) !== 'synced') continue;

    if (key === TOKEN_KEY) {
      let remote;
      try {
        remote = JSON.parse(unit.payload);
      } catch {
        continue;
      }
      const merged = mergeTokenUsage(readJSON(TOKEN_KEY, null), remote);
      appStorage.setItem(TOKEN_KEY, JSON.stringify(merged));
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
 * loss dressed up as a successful park. `historyIndex` is left pointing at
 * whatever was already current: this appends an archived entry, it does not
 * change what the live document considers "current".
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

  const key = `${HISTORY_PREFIX}${variantId}`;
  const raw = readJSON(key, null);
  const existingHistory = raw && typeof raw === 'object' && Array.isArray(raw.history)
    ? raw.history
    : [];
  // Mirrors store.js's own loadHistory() fallback (`historyData.historyIndex
  // ?? history.length - 1`) so a variant with no recorded index yet — or none
  // at all — comes out exactly as store.js would compute it on load.
  const historyIndex = Number.isInteger(raw?.historyIndex) ? raw.historyIndex : existingHistory.length - 1;

  const history = [...existingHistory, {
    data,
    timestamp: new Date().toISOString(),
    description: 'Conflicting edit synced from another device',
    changeType: 'sync-conflict',
  }];
  appStorage.setItem(key, JSON.stringify({ history, historyIndex }));
  return true;
}

export { resolveConflict };
