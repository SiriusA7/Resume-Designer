/**
 * Splitting `resume-designer-data` into sync units, and putting it back.
 *
 * That one file holds every résumé plus `currentVariantId`, `settings` and
 * `userProfile`. A record per storage key would therefore make editing résumé
 * A on a phone collide with résumé B on a Mac and silently discard one — the
 * central case for a résumé app, not an edge case. So the blob is decomposed.
 *
 * The on-disk format is untouched: this is a view for the sync layer only, and
 * `mergeData` reassembles exactly what was there.
 *
 * Pure — no storage, no DOM.
 */

import { withoutSettingsCredential } from '../profileKeys.js';

export const RESUME_UNIT_PREFIX = 'resume:';

/** Top-level blob keys that become their own units. */
const PLAIN_FIELDS = ['settings', 'userProfile'];

/**
 * The credential never crosses this boundary, in EITHER direction.
 *
 * The API key lives in the OS keychain and syncs through iCloud Keychain, so
 * `settings.openrouterKey` is only ever a leftover — a blob whose plaintext
 * cleanup has not yet flushed, or an older backup restored over the top.
 * Leftover or not, it is a paid credential, and `splitData` would serialize it
 * into `data:settings` and put it in CloudKit. The standalone key's device-local
 * classification does not protect it here: that rule is about the key's OWN
 * storage key, and this is a different unit that merely contains it.
 *
 * Applied inbound as well, so a record uploaded by an older build cannot put
 * the plaintext copy back on a device that has already cleaned itself up.
 */
const withoutCredential = (field, value) =>
  (field === 'settings' ? withoutSettingsCredential(value) : value);

/**
 * `currentVariantId` is absent from this list ON PURPOSE and must stay absent:
 * which résumé is open is a property of a device.
 */
export function splitData(blob) {
  if (!blob || typeof blob !== 'object') return [];
  const units = [];

  const variants = blob.variants;
  if (variants && typeof variants === 'object') {
    for (const [id, variant] of Object.entries(variants)) {
      units.push({
        id: `${RESUME_UNIT_PREFIX}${id}`,
        kind: 'resume',
        payload: JSON.stringify(variant),
      });
    }
  }

  for (const field of PLAIN_FIELDS) {
    if (blob[field] !== undefined) {
      units.push({
        id: `data:${field}`,
        kind: 'plain',
        payload: JSON.stringify(withoutCredential(field, blob[field])),
      });
    }
  }

  return units;
}

/**
 * Reassemble, without mutating `blob`.
 *
 * Unknown top-level keys are carried through untouched: a key added to the
 * document after this code was written must survive a sync round trip.
 */
export function mergeData(blob, units) {
  const base = blob && typeof blob === 'object' ? blob : {};
  const next = { ...base, variants: { ...(base.variants || {}) } };

  for (const unit of Array.isArray(units) ? units : []) {
    if (!unit || typeof unit.payload !== 'string') continue;
    let value;
    try {
      value = JSON.parse(unit.payload);
    } catch {
      // A corrupt payload is skipped rather than allowed to throw: one bad
      // record must not stop the rest of a sync landing.
      continue;
    }
    if (unit.id.startsWith(RESUME_UNIT_PREFIX)) {
      next.variants[unit.id.slice(RESUME_UNIT_PREFIX.length)] = value;
    } else if (unit.id.startsWith('data:')) {
      const field = unit.id.slice('data:'.length);
      if (PLAIN_FIELDS.includes(field)) next[field] = withoutCredential(field, value);
    }
  }

  return next;
}
