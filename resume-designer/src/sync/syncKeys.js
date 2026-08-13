/**
 * Which storage keys sync, and which stay on the device.
 *
 * Exhaustive by construction over TWO inventories from `profileKeys.js`:
 * `BACKUP_FIXED_KEYS` (the backup/restore system) and `SHARED_KEYS`
 * (machine-level keys — not exported directly; profileKeys.js exposes only
 * `isSharedKey`). A `SHARED_KEYS` member is not reached by the
 * `BACKUP_FIXED_KEYS` check below, so every one of them must appear in either
 * `DEVICE_LOCAL_KEYS` or `SYNCED_SHARED_KEYS`. Anything not named in one of
 * these three lists comes back 'unknown', and the exhaustiveness tests fail.
 * That is deliberate — a key added later without a sync decision must not
 * default to either answer. Defaulting to synced leaks device state (a
 * synced `currentVariantId` makes one device change documents because
 * another did); defaulting to local loses content silently.
 */
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX } from '../profileKeys.js';

/** Never leaves the machine. Each entry has a reason, because none is obvious. */
export const DEVICE_LOCAL_KEYS = [
  // A zoom that suits a phone is wrong on a Mac.
  'resume-zoom',
  // Commonly "follow the system", which a synced value fights on a device
  // whose system setting differs.
  'resume-designer-theme',
  // A beta Mac beside a stable phone is a legitimate setup.
  'resume-designer-update-channel',
  'resume-designer-auto-update-check',
  // The loopback companion bridge is machine-specific.
  'resume-designer-bridge-token',
  // Which profile you are in is a property of a device.
  'resume-designer-active-profile',
  // A regenerable cache.
  'resume-designer-model-catalog',
  // A historical fact about one machine.
  'resume-designer-electron-migration-attempted',
  // A credential. It must NEVER be sent to CloudKit — this is a deliberate
  // refusal, not an accident of leaving it unclassified.
  'resume-designer-openrouter-key',
  // This device's view of what it has synced.
  'resume-designer-sync-state',
  // Whether this device syncs at all. Its own switch is the last thing that
  // should travel: syncing it would let one device turn sync ON for another,
  // and the whole point of the preference is that the answer belongs to the
  // person holding this device.
  'resume-designer-sync-enabled',
];

// The profile registry's logical key. Defined once here — SYNCED_SHARED_KEYS
// below is built from it, and syncModel.js imports this rather than writing
// the string a second time, so PROFILES_KEY there is this constant.
export const PROFILES_KEY = 'resume-designer-profiles';

// SHARED_KEYS members that DO sync — the exception to DEVICE_LOCAL_KEYS
// above. `resume-designer-profiles` is a SHARED_KEYS member, so
// `BACKUP_FIXED_KEYS` membership below does not reach it; it needs its own
// classification here. It syncs because the CloudKit design puts each
// profile in its own record zone and reconciles the zone list against this
// registry — a device that never receives it cannot discover another
// device's profiles.
export const SYNCED_SHARED_KEYS = [PROFILES_KEY];

const LOCAL = new Set(DEVICE_LOCAL_KEYS);
const SYNCED_SHARED = new Set(SYNCED_SHARED_KEYS);

export function classifyKey(logicalKey) {
  if (typeof logicalKey !== 'string' || !logicalKey) return 'unknown';
  if (LOCAL.has(logicalKey)) return 'local';
  if (SYNCED_SHARED.has(logicalKey)) return 'synced';
  // Version history is per-variant and syncs: it is where a conflict's losing
  // edit is parked, and a loser stranded on one device is no use from another.
  if (logicalKey.startsWith(BACKUP_HISTORY_PREFIX)) return 'synced';
  if (BACKUP_FIXED_KEYS.includes(logicalKey)) return 'synced';
  return 'unknown';
}

/**
 * Which CloudKit zone a synced key's unit belongs in.
 *
 * SHARED keys describe the workspace set itself and cannot live inside a
 * per-profile zone — that is the bootstrap cycle: a clean device needs the
 * registry to learn the profile ids, and the ids to fetch the zone holding the
 * registry. See docs/superpowers/specs/2026-08-13-sync-bootstrap-design.md.
 *
 * Swift routes on this answer and never inspects a unit id, which is what keeps
 * zone choice a model decision.
 */
export function keyScope(logicalKey) {
  return SYNCED_SHARED_KEYS.includes(logicalKey) ? 'shared' : 'profile';
}
