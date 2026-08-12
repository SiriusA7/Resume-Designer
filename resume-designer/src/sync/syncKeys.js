/**
 * Which storage keys sync, and which stay on the device.
 *
 * Exhaustive over `BACKUP_FIXED_KEYS` by construction: anything not named here
 * comes back 'unknown', and the test above fails. That is deliberate — a key
 * added later without a sync decision must not default to either answer.
 * Defaulting to synced leaks device state (a synced `currentVariantId` makes
 * one device change documents because another did); defaulting to local loses
 * content silently.
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
];

/**
 * Also device-local, for the reasons in the CloudKit sync design doc, but
 * these are `SHARED_KEYS` in profileKeys.js, not `BACKUP_FIXED_KEYS` — the
 * backup/restore system never touches them, so they cannot be added to
 * DEVICE_LOCAL_KEYS above without failing the "every device-local key is a
 * real backup key" test. classifyKey still has to answer for them, since a
 * future sync pass may see these keys directly.
 */
const OTHER_LOCAL_KEYS = [
  // Which profile you are in is a property of a device.
  'resume-designer-active-profile',
  // A regenerable cache.
  'resume-designer-model-catalog',
  // A historical fact about one machine.
  'resume-designer-electron-migration-attempted',
];

const LOCAL = new Set([...DEVICE_LOCAL_KEYS, ...OTHER_LOCAL_KEYS]);

export function classifyKey(logicalKey) {
  if (typeof logicalKey !== 'string' || !logicalKey) return 'unknown';
  if (LOCAL.has(logicalKey)) return 'local';
  // Version history is per-variant and syncs: it is where a conflict's losing
  // edit is parked, and a loser stranded on one device is no use from another.
  if (logicalKey.startsWith(BACKUP_HISTORY_PREFIX)) return 'synced';
  if (BACKUP_FIXED_KEYS.includes(logicalKey)) return 'synced';
  return 'unknown';
}
