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
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX, PROFILES_KEY } from '../profileKeys.js';

export const SYNC_SUSPENDED_KEY = 'resume-designer-sync-suspended';

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
  // Set when iCloud data was purged, so this device stops rather than
  // immediately re-uploading what the person just deleted. NOT a preference:
  // there is no longer a switch, and the two facts must not share a key —
  // "does not want sync" is permanent, "the server was emptied" is a prompt.
  SYNC_SUSPENDED_KEY,
];

// The profile registry's logical key. Re-exported from profileKeys.js rather
// than written again: that file already owns it, this one already imports from
// it, and a second literal is a second key the moment one of them is edited.
// SYNCED_SHARED_KEYS below is built from this, and syncModel.js imports it from
// here, so all three names are the same constant.
export { PROFILES_KEY };

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

/**
 * What a synced key holds when a REPLACEMENT restore leaves it out.
 *
 * Absence is not a message in this protocol — `collectKeyUnit` says so out
 * loud: "a key this device cannot read is one it has nothing to say about". So
 * a restore that wipes a key the backup omits deletes it here and tells nobody,
 * the server keeps the old record, and the next fetch (or any other device)
 * hands the content back. The same failure the résumé tombstones exist for, one
 * level up at whole keys — and the same answer: write the value the deletion
 * MEANS, which is a change the interceptor can see, rather than an absence it
 * cannot.
 *
 * Only keys whose empty is unambiguous are here, and the omissions are
 * deliberate rather than pending:
 *
 * - `resume-designer-token-usage` and the `resume-designer-history-*` keys are
 *   UNIONS on the way in (`landTokenUsage`, `landHistory`). An empty payload
 *   merges into what the receiver already holds and changes nothing, so
 *   clearing them cannot travel by newer-wins at all. That is a property of
 *   accumulating units, not a gap here.
 * - The design keys (`resume-accent-settings`, `resume-spacing-settings`,
 *   `resume-font-settings`, `resume-photo-settings`, `resume-header-style`) and
 *   the two dismissal flags hold module-private defaults, and absence reads as
 *   exactly that default to every reader. What survives on another device is a
 *   stale customisation, not resurrected content — and each module already owns
 *   the reset that makes its own clear travel (see resetSpacingSettings and
 *   resetAccentSettings). Guessing their default JSON from here would be a
 *   second copy of it, wrong the first time either changed.
 * - `resume-designer-data` is represented by its `resume:`/`data:` units and
 *   carries its own tombstones.
 */
export const CLEARED_PAYLOADS = new Map([
  ['resume-designer-job-descriptions', '[]'],
  ['resume-designer-applications', '[]'],
  ['resume-designer-chat-threads', '[]'],
  ['resume-designer-chat-history', '[]'],
  ['resume-designer-learned-answers', '[]'],
]);

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
