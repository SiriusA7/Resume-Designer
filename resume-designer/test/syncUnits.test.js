import { describe, it, expect } from 'vitest';
import { splitData, mergeData, RESUME_UNIT_PREFIX } from '../src/sync/syncUnits.js';

const BLOB = {
  variants: {
    'v-1': { name: 'Design Engineer', data: { name: 'Ash' } },
    'v-2': { name: 'Product Lead', data: { name: 'Ash' } },
  },
  currentVariantId: 'v-1',
  settings: { pageSize: 'letter' },
  userProfile: { headline: 'Designer' },
};

describe('splitData', () => {
  it('emits one unit per résumé', () => {
    const ids = splitData(BLOB).filter((u) => u.kind === 'resume').map((u) => u.id);
    expect(ids.sort()).toEqual([`${RESUME_UNIT_PREFIX}v-1`, `${RESUME_UNIT_PREFIX}v-2`]);
  });

  it('gives settings and the user profile their own units', () => {
    const ids = splitData(BLOB).map((u) => u.id);
    expect(ids).toContain('data:settings');
    expect(ids).toContain('data:userProfile');
  });

  it('never leaks currentVariantId into a unit id or payload', () => {
    // Which résumé is open is device-local. Syncing it makes one device change
    // documents because another did.
    //
    // A string search on JSON.stringify(splitData(BLOB)) cannot catch the
    // realistic leak shape: every unit carries its data via JSON.stringify
    // (see payload: JSON.stringify(...) in syncUnits.js), so if
    // currentVariantId were ever folded into a unit's payload, the outer
    // serialisation double-escapes its quotes (`payload":"...\"v-1\"..."`).
    // Neither `v-1"` nor `"v-1"` then appears anywhere in the string being
    // searched, so a string-matching guard passes while the requirement is
    // violated. Parse each unit's payload back out and check it structurally
    // instead — that is the only check that actually holds.
    for (const unit of splitData(BLOB)) {
      expect(unit.id).not.toBe('data:currentVariantId');

      const payload = JSON.parse(unit.payload);
      expect(payload).not.toBe(BLOB.currentVariantId);
      if (payload && typeof payload === 'object') {
        expect(Object.prototype.hasOwnProperty.call(payload, 'currentVariantId')).toBe(false);
      }
    }
  });

  it('survives a blob with nothing in it', () => {
    expect(splitData({})).toEqual([]);
    expect(splitData(null)).toEqual([]);
  });
});

describe('mergeData', () => {
  it('round-trips a blob through split and merge unchanged', () => {
    const merged = mergeData(BLOB, splitData(BLOB));
    expect(merged).toEqual(BLOB);
  });

  it('keeps the local currentVariantId, which never travelled', () => {
    const local = { ...BLOB, currentVariantId: 'v-2' };
    expect(mergeData(local, splitData(BLOB)).currentVariantId).toBe('v-2');
  });

  it('preserves top-level keys the splitter did not know about', () => {
    // A future key added to the blob must not be destroyed by a sync round
    // trip written before it existed.
    const withExtra = { ...BLOB, futureThing: { a: 1 } };
    expect(mergeData(withExtra, splitData(BLOB)).futureThing).toEqual({ a: 1 });
  });

  it('adds a résumé that only exists remotely', () => {
    const units = splitData(BLOB);
    const merged = mergeData({ variants: {}, currentVariantId: null }, units);
    expect(Object.keys(merged.variants).sort()).toEqual(['v-1', 'v-2']);
  });

  it('does not mutate the blob it was given', () => {
    const local = JSON.parse(JSON.stringify(BLOB));
    mergeData(local, splitData({ ...BLOB, variants: { 'v-3': { name: 'New' } } }));
    expect(Object.keys(local.variants).sort()).toEqual(['v-1', 'v-2']);
  });
});
