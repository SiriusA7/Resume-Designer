import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
} from '../src/appStorage.js';
import { __resetSecretStoreForTests, initSecretStore, getSecret } from '../src/secretStore.js';
import {
  loadRegistry, listProfiles, getActiveProfileId, setActiveProfile,
  createProfile, renameProfile, deleteProfile, exportProfileBackup,
  ensureProfilesInitialized, extractSharedApiKey, isAdoptionPending, hasProfileNamespaces,
  activateProfileMappingForPrint, isUntouchedWorkspace, adoptAccountWorkspaces,
} from '../src/profiles.js';
import {
  PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY, SYNC_STATE_KEY, physicalKey,
} from '../src/profileKeys.js';
import { getSettings, saveSettings, saveApiKey } from '../src/persistence.js';
import { applyUnits } from '../src/sync/syncModel.js';

beforeEach(() => {
  __resetAppStorageForTests();
  __resetSecretStoreForTests();
  localStorage.clear();
});

function makeBackend(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => { files.set(key, value); }),
    delete: vi.fn(async (key) => { files.delete(key); }),
    clear: vi.fn(async () => { files.clear(); }),
  };
}

function seedRegistry() {
  const a = createProfile({ name: 'Ash', emoji: '🦊' });
  const b = createProfile({ name: 'Partner', emoji: '🐙' });
  appStorage.setItem(ACTIVE_PROFILE_KEY, a.id);
  return { a, b };
}

describe('registry CRUD', () => {
  it('creates profiles with unique colon-free ids', () => {
    const { a, b } = seedRegistry();
    expect(a.id).not.toContain(':');
    expect(a.id).not.toBe(b.id);
    expect(loadRegistry().map((p) => p.name)).toEqual(['Ash', 'Partner']);
  });

  it('loadRegistry returns null for absent or corrupt data', () => {
    expect(loadRegistry()).toBeNull();
    appStorage.setItem(PROFILES_KEY, 'not json');
    expect(loadRegistry()).toBeNull();
    appStorage.setItem(PROFILES_KEY, '[]');
    expect(loadRegistry()).toBeNull();
  });

  it('treats a registry with ANY invalid entry as corrupt (null)', () => {
    // Partial salvage would silently orphan the invalid entry's workspace;
    // null routes boot through the rebuild-from-keys recovery instead.
    appStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'pgood', name: 'Ash', emoji: '🙂', createdAt: 'x' },
      { id: 42, name: 'Broken' },
    ]));
    expect(loadRegistry()).toBeNull();
  });

  it('rejects non-alphanumeric ids as corrupt (physical-key separator safety)', () => {
    for (const id of ['p:evil', 'p-evil', 'p--evil', 'p evil', '']) {
      appStorage.setItem(PROFILES_KEY, JSON.stringify([
        { id, name: 'X', emoji: '🙂', createdAt: 'x' },
      ]));
      expect(loadRegistry(), `id "${id}" must be rejected`).toBeNull();
    }
  });

  it('createProfile re-rolls a colliding generated id', () => {
    // Deterministic generateProfileId: freeze time and step crypto.getRandomValues
    // so the first roll collides with a seeded id, the second roll differs.
    vi.spyOn(Date, 'now').mockReturnValue(1000000);
    let call = 0;
    vi.spyOn(crypto, 'getRandomValues').mockImplementation((arr) => {
      // Rolls #1 and #2 fill the SAME bytes (same id → collision); roll #3 differs.
      const val = (++call <= 2) ? 111 : 222;
      for (let i = 0; i < arr.length; i += 1) arr[i] = val;
      return arr;
    });
    try {
      const seeded = createProfile({ name: 'Seed' }); // uses roll #1
      const next = createProfile({ name: 'Next' });   // roll #2 collides, roll #3 wins
      expect(next.id).not.toBe(seeded.id);
      const ids = loadRegistry().map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('coerces a non-string emoji on load (switcher never renders a bad child)', () => {
    appStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'pcorrupt', name: 'Ash', emoji: {}, createdAt: 'x' },
    ]));
    const reg = loadRegistry();
    expect(reg).toHaveLength(1);
    expect(typeof reg[0].emoji).toBe('string'); // coerced to the default, not {}
  });

  it('renames and re-emojis a profile', () => {
    const { a } = seedRegistry();
    renameProfile(a.id, { name: 'Ash S', emoji: '🦉' });
    const reg = loadRegistry();
    expect(reg.find((p) => p.id === a.id)).toMatchObject({ name: 'Ash S', emoji: '🦉' });
  });

  it('setActiveProfile validates membership', () => {
    const { b } = seedRegistry();
    setActiveProfile(b.id);
    expect(getActiveProfileId()).toBe(b.id);
    expect(() => setActiveProfile('nope')).toThrow();
  });

  it('deleteProfile removes the workspace keys and guards active/last', () => {
    const { a, b } = seedRegistry();
    appStorage.setItem(`resume-p--${b.id}--resume-designer-data`, '{}');
    appStorage.setItem(`resume-p--${b.id}--resume-designer-history-v1`, '[]');
    expect(() => deleteProfile(a.id)).toThrow(/active/i);
    deleteProfile(b.id);
    expect(appStorage.keys().some((k) => k.includes(b.id))).toBe(false);
    // Tombstoned, not dropped: the raw registry still carries b's entry (a
    // union merge would otherwise resurrect it), but it is hidden from the
    // listing a person sees.
    expect(loadRegistry()).toHaveLength(2);
    expect(loadRegistry().find((p) => p.id === b.id).deletedAt).toEqual(expect.any(String));
    expect(listProfiles()).toHaveLength(1);
    // Names the guard, not merely "something threw". A bare toThrow() here
    // survived the guard changing from counting raw entries to counting
    // visible ones — the branch that fires and the message both changed, and
    // the assertion could not tell. Raw count is 2 and visible is 1 at this
    // point, so this is exactly where the two guards disagree.
    expect(() => deleteProfile(a.id)).toThrow(/last profile/i);
  });
});

describe('registry entry stamps', () => {
  it('stamps updatedAt on rename', () => {
    const created = createProfile({ name: 'Work' });
    expect(created.updatedAt).toBeUndefined();
    renameProfile(created.id, { name: 'Renamed' });
    const entry = loadRegistry().find((p) => p.id === created.id);
    expect(entry.name).toBe('Renamed');
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('tombstones on delete instead of dropping the entry', () => {
    createProfile({ name: 'Keep' }); // deleteProfile refuses to drop the last profile
    const created = createProfile({ name: 'Doomed' });
    deleteProfile(created.id);
    const entry = loadRegistry().find((p) => p.id === created.id);
    expect(entry).toBeDefined();
    expect(typeof entry.deletedAt).toBe('string');
    expect(typeof entry.updatedAt).toBe('string');
  });

  it('hides tombstoned profiles from the listing', () => {
    const kept = createProfile({ name: 'Kept' });
    const gone = createProfile({ name: 'Gone' });
    deleteProfile(gone.id);
    const ids = listProfiles().map((p) => p.id);
    expect(ids).toContain(kept.id);
    expect(ids).not.toContain(gone.id);
  });

  // Regression: the last-profile guard used to count the raw registry array,
  // which was equivalent to "visible profiles" before tombstones stuck
  // around. With a tombstone present the raw count no longer reflects what a
  // person can see, so it must count listProfiles() instead — otherwise the
  // guard stops firing once any tombstone exists and the last visible profile
  // becomes deletable, leaving listProfiles() empty with no path back.
  //
  // Neither profile here is active, so the active-profile guard cannot be
  // what blocks the second delete — only the last-VISIBLE-profile guard can.
  it('still refuses to delete the last visible profile when a tombstone is present', () => {
    const ghost = createProfile({ name: 'Ghost' });
    const solo = createProfile({ name: 'Solo' });
    deleteProfile(ghost.id); // 2 live profiles at this point -> guard allows it
    expect(loadRegistry()).toHaveLength(2); // ghost's tombstone still occupies a slot
    expect(listProfiles()).toHaveLength(1); // but only solo is visible

    expect(() => deleteProfile(solo.id)).toThrow(/last profile/i);
    expect(listProfiles()).toHaveLength(1);
    expect(listProfiles()[0].id).toBe(solo.id);
  });

  // Regression: before tombstoning, a deleted profile's entry was gone from
  // the registry outright, so setActiveProfile could never target it. Now the
  // entry still physically exists (deletedAt set) — validation must check
  // listProfiles(), not the raw registry, or a person could switch back into
  // a workspace they just deleted.
  it('setActiveProfile refuses a tombstoned profile', () => {
    const { b } = seedRegistry(); // a is active, b is not
    deleteProfile(b.id);
    expect(() => setActiveProfile(b.id)).toThrow();
  });

  // Same regression, for export: a tombstoned entry's physical keys are
  // already gone, so finding it in the raw registry would silently produce
  // an empty backup instead of the "unknown profile" error a stale id
  // deserves.
  it('exportProfileBackup refuses a tombstoned profile', () => {
    const { b } = seedRegistry();
    deleteProfile(b.id);
    // Deliberately NOT async — an unknown id throws synchronously.
    expect(() => exportProfileBackup(b.id)).toThrow(/unknown profile/i);
  });
});

describe('adoption migration', () => {
  it('copies EVERY source before deleting any (no mapping-off split), marker cleared last', async () => {
    const operations = [];
    const backend = makeBackend({
      'resume-designer-data': '{"variants":{}}',
      'resume-designer-job-descriptions': '[]',
    });
    backend.write.mockImplementation(async (key, value) => {
      operations.push(`write:${key}`);
      backend.files.set(key, value);
    });
    backend.delete.mockImplementation(async (key) => {
      operations.push(`delete:${key}`);
      backend.files.delete(key);
    });
    await initAppStorage({ backend });

    const id = await ensureProfilesInitialized();

    // Marker is durable before the registry/pointer writes (crash-safe start).
    const markerWrite = operations.indexOf('write:resume-profile-adoption-pending');
    expect(markerWrite).toBeGreaterThanOrEqual(0);
    expect(markerWrite).toBeLessThan(operations.indexOf(`write:${PROFILES_KEY}`));
    expect(markerWrite).toBeLessThan(operations.indexOf(`write:${ACTIVE_PROFILE_KEY}`));

    // EVERY source copy lands before ANY source is deleted. Deleting a source
    // while some are still unprefixed would split the workspace across both
    // namespaces — fatal because the recovery session reads mapping-off.
    const copyIdx = operations
      .map((o, i) => ({ o, i })).filter(({ o }) => o.startsWith(`write:resume-p--${id}--`)).map(({ i }) => i);
    const delIdx = operations
      .map((o, i) => ({ o, i })).filter(({ o }) => /^delete:resume-designer-(data|job-descriptions)$/.test(o)).map(({ i }) => i);
    expect(copyIdx).toHaveLength(2);
    expect(delIdx).toHaveLength(2);
    expect(Math.max(...copyIdx)).toBeLessThan(Math.min(...delIdx));

    // Marker cleared last; sources gone; copies present.
    expect(operations.at(-1)).toBe('delete:resume-profile-adoption-pending');
    expect(backend.files.get(`resume-p--${id}--resume-designer-data`)).toBe('{"variants":{}}');
    expect(backend.files.get(`resume-p--${id}--resume-designer-job-descriptions`)).toBe('[]');
    expect(backend.files.has('resume-designer-data')).toBe(false);
    expect(backend.files.has('resume-designer-job-descriptions')).toBe(false);
    expect(backend.files.has('resume-profile-adoption-pending')).toBe(false);
  });

  it('leaves print mapping OFF while an adoption is pending (reads unprefixed live data)', () => {
    // Recovery state: main window runs mapping-off on unprefixed data, so the
    // print window must too — else a PDF captures the stale physical copy.
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'prec', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'prec');
    localStorage.setItem('resume-profile-adoption-pending', '1');
    localStorage.setItem('resume-designer-data', '{"variants":{"LIVE":{}}}');
    localStorage.setItem('resume-p--prec--resume-designer-data', '{"variants":{"STALE":{}}}');

    activateProfileMappingForPrint();

    expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"LIVE":{}}}');
  });

  it('activates print mapping once adoption is complete (reads the namespaced data)', () => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'pdone', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pdone');
    localStorage.setItem('resume-p--pdone--resume-designer-data', '{"variants":{"REAL":{}}}');

    activateProfileMappingForPrint();

    expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"REAL":{}}}');
  });

  it('reports adoption pending while the marker is present (drives switcher hiding)', async () => {
    localStorage.setItem('resume-designer-data', '{"variants":{"KEEP":{}}}');
    const realSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      if (String(key).startsWith('resume-p--')) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(isAdoptionPending()).toBe(false); // nothing started yet
      await ensureProfilesInitialized();        // fails mid-adoption, marker persists
      expect(isAdoptionPending()).toBe(true);
    } finally {
      setItemSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('survives a passthrough localStorage quota error during adoption', async () => {
    // Browser/passthrough mode writes straight to localStorage (~5MB cap). A
    // per-profile copy hitting quota must NOT crash init(): the source data and
    // the marker are kept so a later boot (after the user frees space) resumes.
    localStorage.setItem('resume-designer-data', '{"variants":{"KEEP":{}}}');
    const realSetItem = Storage.prototype.setItem;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      if (String(key).startsWith('resume-p--')) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized(); // must resolve, not throw
      expect(id).not.toBeNull();
      expect(localStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      expect(localStorage.getItem('resume-profile-adoption-pending')).toBe('1');

      // Mapping must stay INACTIVE after a failed adoption — otherwise reads
      // hit the empty namespace and the user's data appears lost. Prove it:
      // reads resolve to the unprefixed source, and a new write stays unprefixed.
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      appStorage.setItem('resume-designer-data', '{"variants":{"NEW":{}}}');
      expect(localStorage.getItem('resume-designer-data')).toBe('{"variants":{"NEW":{}}}');
      expect(localStorage.getItem(`resume-p--${id}--resume-designer-data`)).toBeNull();
    } finally {
      setItemSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('rolls back partial physical copies when adoption hits quota mid-copy (no leak)', async () => {
    // Regression (PR #90 Codex P1): the copy DOUBLES storage, so a browser user
    // near quota gets SOME namespaced duplicates written before a later setItem
    // throws. Leaving them pins localStorage at quota (flush is a no-op in
    // passthrough) and every restart re-fails — the unprefixed workspace can no
    // longer save either. The failed copy must leave ZERO physical duplicates.
    localStorage.setItem('resume-designer-data', '{"variants":{"KEEP":{}}}');
    localStorage.setItem('resume-designer-job-descriptions', '[]');
    const realSetItem = Storage.prototype.setItem;
    let physWrites = 0;
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      // Let the FIRST physical copy land (a leaked duplicate), throw on the next.
      if (String(key).startsWith('resume-p--') && ++physWrites >= 2) {
        throw new DOMException('quota', 'QuotaExceededError');
      }
      return realSetItem.call(this, key, value);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized();
      expect(id).not.toBeNull();
      // At least one physical copy was written before the throw…
      expect(physWrites).toBeGreaterThanOrEqual(2);
      // …yet none survive: the rollback removed every resume-p-- duplicate.
      const leaked = Object.keys(localStorage).filter((k) => k.startsWith('resume-p--'));
      expect(leaked).toEqual([]);
      // Sources intact + adoption still pending for a later retry.
      expect(localStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      expect(isAdoptionPending()).toBe(true);
    } finally {
      setItemSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('keeps sources and the marker durable when adoption copies fail', async () => {
    const backend = makeBackend({ 'resume-designer-data': '{"variants":{}}' });
    backend.write.mockImplementation(async (key, value) => {
      if (key.startsWith('resume-p--')) throw new Error('disk full');
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized();

      expect(id).not.toBeNull();
      expect(backend.files.get('resume-designer-data')).toBe('{"variants":{}}');
      expect(backend.files.get('resume-profile-adoption-pending')).toBe('1');
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{}}');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('resumes a cached-mode adoption with copies durable before source deletes', async () => {
    const operations = [];
    const backend = makeBackend({
      'resume-profile-adoption-pending': '1',
      [PROFILES_KEY]: JSON.stringify([{ id: 'pfixed', name: 'Ash', emoji: '🙂', createdAt: 'x' }]),
      [ACTIVE_PROFILE_KEY]: 'pfixed',
      'resume-designer-data': '{"variants":{}}',
    });
    backend.write.mockImplementation(async (key, value) => {
      operations.push(`write:${key}`);
      backend.files.set(key, value);
    });
    backend.delete.mockImplementation(async (key) => {
      operations.push(`delete:${key}`);
      backend.files.delete(key);
    });
    await initAppStorage({ backend });

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pfixed');
    const copyWrite = operations.indexOf('write:resume-p--pfixed--resume-designer-data');
    const sourceDelete = operations.indexOf('delete:resume-designer-data');
    expect(copyWrite).toBeGreaterThanOrEqual(0);
    expect(copyWrite).toBeLessThan(sourceDelete);
    expect(operations.at(-1)).toBe('delete:resume-profile-adoption-pending');
    expect(backend.files.get('resume-p--pfixed--resume-designer-data')).toBe('{"variants":{}}');
    expect(backend.files.has('resume-designer-data')).toBe(false);
    expect(backend.files.has('resume-profile-adoption-pending')).toBe(false);
  });

  it('resume copies the authoritative unprefixed edit over a stale physical', async () => {
    // The recovery session runs mapping-OFF, so the user's edits land on the
    // UNPREFIXED source; a stale physical lingers from an earlier failed pass.
    // Copy-ALWAYS: the resume must overwrite the stale physical with the
    // authoritative unprefixed edit, not skip it (copy-if-absent would keep the
    // stale value and then delete the newer source — the finding-14 clobber).
    const backend = makeBackend({
      'resume-profile-adoption-pending': '1',
      [PROFILES_KEY]: JSON.stringify([{ id: 'pfixed', name: 'Ash', emoji: '🙂', createdAt: 'x' }]),
      [ACTIVE_PROFILE_KEY]: 'pfixed',
      'resume-designer-data': '{"variants":{"EDITED":{}}}',                      // recovery edit (authoritative)
      'resume-p--pfixed--resume-designer-data': '{"variants":{"STALE":{}}}',     // stale physical from an earlier pass
    });
    await initAppStorage({ backend });

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pfixed');
    expect(backend.files.get('resume-p--pfixed--resume-designer-data')).toBe('{"variants":{"EDITED":{}}}');
    expect(backend.files.has('resume-designer-data')).toBe(false);
    expect(backend.files.has('resume-profile-adoption-pending')).toBe(false);
  });

  it('keeps all data readable unprefixed when adoption partially copies then fails (no split)', async () => {
    // The bulky history key's copy fails after the data key was copied. Because
    // NO source is deleted until every copy is durable, the mapping-off recovery
    // session still reads BOTH keys from their intact unprefixed sources — no
    // half-migrated split where already-moved keys read back as missing.
    const backend = makeBackend({
      'resume-designer-data': '{"variants":{"KEEP":{}}}',
      'resume-designer-history-v1': 'big-history',
    });
    backend.write.mockImplementation(async (key, value) => {
      if (key.endsWith('resume-designer-history-v1')) throw new Error('disk full');
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const id = await ensureProfilesInitialized();
      expect(id).not.toBeNull();
      // Mapping off → both keys resolve to their intact unprefixed sources.
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      expect(appStorage.getItem('resume-designer-history-v1')).toBe('big-history');
      // Neither source was deleted (no split); marker persists for a retry.
      expect(backend.files.get('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      expect(backend.files.get('resume-designer-history-v1')).toBe('big-history');
      expect(backend.files.get('resume-profile-adoption-pending')).toBe('1');
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('stays mapping-OFF (restoring sources) when source deletes fail to reach disk', async () => {
    const backend = makeBackend({ 'resume-designer-data': '{"variants":{"KEEP":{}}}' });
    backend.delete.mockImplementation(async (key) => {
      if (key === 'resume-designer-data') throw new Error('disk full');
      backend.files.delete(key);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized();

      // The source delete didn't land, so mapping must NOT activate — activating
      // it and letting edits hit the physical key would let the next boot's
      // copy-always clobber them from the lingering source. Instead the source
      // is restored and the marker kept for a retry.
      expect(backend.files.get(`resume-p--${id}--resume-designer-data`)).toBe('{"variants":{"KEEP":{}}}');
      expect(backend.files.get('resume-profile-adoption-pending')).toBe('1');
      // Mapping OFF → a read resolves to the restored unprefixed source, and a
      // fresh write stays unprefixed (would hit the physical key if mapping were on).
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
      appStorage.setItem('resume-designer-data', '{"variants":{"NEW":{}}}');
      expect(backend.files.get(`resume-p--${id}--resume-designer-data`)).toBe('{"variants":{"KEEP":{}}}');
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('carries the adoption marker across the localStorage→disk adoption', async () => {
    // A recovery state in localStorage: registry + unprefixed data + the marker.
    // appStorage's one-time localStorage→disk adoption copies only resume-* keys,
    // so the marker MUST start with resume- to survive — otherwise the next disk
    // boot loses it and wrongly treats the adoption as complete.
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'prec', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'prec');
    localStorage.setItem('resume-designer-data', '{"variants":{"LIVE":{}}}');
    localStorage.setItem('resume-profile-adoption-pending', '1');

    const backend = makeBackend(); // empty disk → triggers the adoption copy
    await initAppStorage({ backend });

    expect(backend.files.has('resume-profile-adoption-pending')).toBe(true);
    expect(isAdoptionPending()).toBe(true);
  });

  it('degrades to mapping-off instead of aborting when the marker write throws (passthrough quota)', async () => {
    // Browser passthrough: localStorage is already full, so the very first
    // adoption metadata write throws synchronously. ensureProfilesInitialized
    // must swallow it (return null, mapping off) — a throw would abort init().
    localStorage.setItem('resume-designer-data', '{"variants":{"KEEP":{}}}');
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      if (key === 'resume-profile-adoption-pending') throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await ensureProfilesInitialized(); // must resolve, not throw
      expect(result).toBeNull();
      // App runs on the unprefixed workspace (mapping off).
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{"KEEP":{}}}');
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('reports adoption pending (in-memory) after a markerless degraded init', async () => {
    // The marker write itself threw, so NO marker persisted — the in-memory
    // degraded flag must still lock profile creation: a later create would
    // persist a fresh registry over the un-adopted unprefixed workspace and
    // hide it behind an empty namespace after reload.
    localStorage.setItem('resume-designer-data', '{"variants":{"KEEP":{}}}');
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      if (key === 'resume-profile-adoption-pending') throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await ensureProfilesInitialized();
      expect(appStorage.getItem('resume-profile-adoption-pending')).toBeNull();
      expect(isAdoptionPending()).toBe(true);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('adopts existing unprefixed data into a first profile named from the user profile', async () => {
    localStorage.setItem('resume-designer-data', JSON.stringify({
      variants: {}, currentVariantId: null,
      settings: { openrouterKey: 'sk-or-abc' },
      userProfile: { contactInfo: { fullName: 'Ash Shah' } },
    }));
    localStorage.setItem('resume-designer-history-v1', '[]');
    localStorage.setItem('resume-designer-theme', 'dark');

    const id = await ensureProfilesInitialized();

    const reg = loadRegistry();
    expect(reg).toHaveLength(1);
    expect(reg[0]).toMatchObject({ id, name: 'Ash Shah' });
    expect(getActiveProfileId()).toBe(id);
    // per-profile keys moved under the namespace…
    expect(localStorage.getItem(`resume-p--${id}--resume-designer-history-v1`)).toBe('[]');
    expect(localStorage.getItem('resume-designer-history-v1')).toBeNull();
    // …shared keys did not move…
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    // …the API key was extracted to the shared key and stripped from the blob…
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-or-abc');
    const blob = JSON.parse(localStorage.getItem(`resume-p--${id}--resume-designer-data`));
    expect(blob.settings.openrouterKey).toBeUndefined();
    // …and mapped reads now resolve through the namespace.
    expect(appStorage.getItem('resume-designer-history-v1')).toBe('[]');
  });

  it('is a fast no-op on later boots and heals a dangling active pointer', async () => {
    const first = await ensureProfilesInitialized();
    appStorage.setItem(ACTIVE_PROFILE_KEY, 'ghost');
    setProfileMapping(null); // simulate fresh boot
    const healed = await ensureProfilesInitialized();
    expect(healed).toBe(first);
    expect(getActiveProfileId()).toBe(first);
  });

  // Regression: the dangling-pointer heal above used to fall back to
  // registry[0], which is safe only because a deleted profile could never
  // occupy that slot — its entry was dropped outright. Tombstoning changed
  // that: a deleted-but-not-last profile now stays in the raw array and can
  // sit at index 0. Reachable with no sync involved: two profiles, delete the
  // non-active one (both guards allow it), then lose the active pointer — the
  // exact state this fallback exists to absorb. Boot must land on the live
  // profile, not the tombstoned one at registry[0].
  it('heals a dangling active pointer onto the live profile, never a tombstoned one', async () => {
    const a = createProfile({ name: 'A' });
    const b = createProfile({ name: 'B' });
    setActiveProfile(b.id); // b active
    deleteProfile(a.id); // a not active, not last -> both guards allow; a is tombstoned
    // Sanity: the tombstoned entry really is sitting at registry[0], which is
    // exactly the slot the boot fallback reads.
    expect(loadRegistry()[0].id).toBe(a.id);
    expect(loadRegistry()[0].deletedAt).toEqual(expect.any(String));

    appStorage.removeItem(ACTIVE_PROFILE_KEY); // active pointer lost/corrupted
    setProfileMapping(null); // simulate fresh boot

    const resolved = await ensureProfilesInitialized();

    expect(resolved).toBe(b.id); // the live profile, not a's tombstone
    expect(getActiveProfileId()).toBe(b.id);
  });

  it('durably revives a local workspace when every registry entry is tombstoned', async () => {
    const tombstoneStamp = '2099-08-02T00:00:00.000Z';
    const backend = makeBackend({
      [PROFILES_KEY]: JSON.stringify([
        { id: 'pempty', name: 'Empty', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z', deletedAt: '2099-08-01T00:00:00.000Z', updatedAt: '2099-08-01T00:00:00.000Z' },
        { id: 'plocal', name: 'Local', emoji: '🙂', createdAt: '2026-07-02T00:00:00.000Z', deletedAt: tombstoneStamp, updatedAt: tombstoneStamp },
      ]),
      [ACTIVE_PROFILE_KEY]: 'pmissing',
      [physicalKey('plocal', 'resume-designer-data')]: '{"variants":{"keep":{}}}',
    });
    await initAppStorage({ backend });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const resolved = await ensureProfilesInitialized();
      const listed = listProfiles();

      expect(resolved).toBe('plocal');
      expect(listed).not.toHaveLength(0);
      expect(listed.map((p) => p.id)).toContain(resolved);
      const diskRegistry = JSON.parse(backend.files.get(PROFILES_KEY));
      const revived = diskRegistry.find((p) => p.id === resolved);
      expect(revived.deletedAt).toBeUndefined();
      expect(new Date(revived.updatedAt).getTime()).toBeGreaterThan(new Date(tombstoneStamp).getTime());
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('revives the workspace this device was last in, ahead of any other candidate', async () => {
    // The branch a real device almost always takes: its own active id IS in the
    // registry, just tombstoned by the other device. Both candidates below hold
    // local data, so only the preference order can decide — which is what pins
    // it. Without that first preference the device would revive a workspace it
    // was not using and had no reason to open.
    const stamp = '2026-08-02T00:00:00.000Z';
    const backend = makeBackend({
      [PROFILES_KEY]: JSON.stringify([
        { id: 'pother', name: 'Other', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z', deletedAt: stamp, updatedAt: stamp },
        { id: 'pmine', name: 'Mine', emoji: '🙂', createdAt: '2026-07-02T00:00:00.000Z', deletedAt: stamp, updatedAt: stamp },
      ]),
      [ACTIVE_PROFILE_KEY]: 'pmine',
      [physicalKey('pother', 'resume-designer-data')]: '{"variants":{"theirs":{}}}',
      [physicalKey('pmine', 'resume-designer-data')]: '{"variants":{"mine":{}}}',
    });
    await initAppStorage({ backend });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // 'pother' is first in the registry and equally eligible, so this fails if
      // the choice ever falls back to registry order.
      expect(await ensureProfilesInitialized()).toBe('pmine');
      const diskRegistry = JSON.parse(backend.files.get(PROFILES_KEY));
      expect(diskRegistry.find((p) => p.id === 'pmine').deletedAt).toBeUndefined();
      expect(diskRegistry.find((p) => p.id === 'pother').deletedAt).toBe(stamp);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('keeps the ordinary live-profile fallback unchanged without reviving a tombstone', async () => {
    const registry = [
      { id: 'pdead', name: 'Deleted', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z', deletedAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'plive', name: 'Live', emoji: '🙂', createdAt: '2026-07-02T00:00:00.000Z' },
    ];
    const backend = makeBackend({
      [PROFILES_KEY]: JSON.stringify(registry),
      [ACTIVE_PROFILE_KEY]: 'pdead',
    });
    await initAppStorage({ backend });

    const resolved = await ensureProfilesInitialized();

    expect(resolved).toBe('plive');
    expect(listProfiles().map((p) => p.id)).toEqual(['plive']);
    expect(JSON.parse(backend.files.get(PROFILES_KEY))).toEqual(registry);
  });

  it('rebuilds a lost registry from existing namespaced data (no data loss)', async () => {
    // Corrupt/missing registry while workspaces exist on disk: recovery must
    // re-list the observed namespaces, never adopt-as-new (which would orphan
    // every namespaced key behind an empty fresh profile).
    localStorage.setItem('resume-p--pold--resume-designer-data',
      '{"variants":{},"userProfile":{"contactInfo":{"fullName":"Ash Shah"}}}');
    localStorage.setItem('resume-p--pold--resume-zoom', '1.25');
    localStorage.setItem(PROFILES_KEY, '{corrupt');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pold');
    expect(loadRegistry()).toHaveLength(1);
    expect(loadRegistry()[0]).toMatchObject({ id: 'pold', name: 'Ash Shah' });
    expect(appStorage.getItem('resume-zoom')).toBe('1.25'); // mapped read works again
  });

  it('resumes an interrupted adoption under the same profile id', async () => {
    localStorage.setItem('resume-designer-data', '{"variants":{}}');
    localStorage.setItem('resume-profile-adoption-pending', '1');
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'pfixed', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pfixed');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pfixed');
    expect(localStorage.getItem('resume-p--pfixed--resume-designer-data')).toBe('{"variants":{}}');
    expect(localStorage.getItem('resume-profile-adoption-pending')).toBeNull();
  });

  it('extractSharedApiKey never clobbers an existing shared key', async () => {
    appStorage.setItem(OPENROUTER_KEY_KEY, 'sk-keep');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-old' } }));
    await extractSharedApiKey();
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-keep');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });

  // CHANGED with the inactive-profile sweep. This used to assert that an empty
  // blob key was stripped WITHOUT creating a shared entry, which was harmless
  // while only the active blob was ever read. It is not harmless now: the
  // stripped Clear left nothing masking, and the sweep then adopted an older
  // paid key out of an inactive blob. Presence beats truthiness — an explicit
  // '' is the user's Clear and has to survive as the shared sentinel.
  it('extractSharedApiKey preserves an empty blob key as the shared sentinel', async () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: '' } }));

    await extractSharedApiKey();

    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });

  // The P1 the change above exists for: without the sentinel, the sweep reached
  // an inactive blob's older key and handed back a credential the user deleted.
  it('extractSharedApiKey never resurrects a cleared key from an inactive blob', async () => {
    const backend = makeBackend({
      'resume-designer-profiles': JSON.stringify([
        { id: 'pactive', name: 'Ash', emoji: '🙂', createdAt: 'x' },
        { id: 'pother', name: 'Other', emoji: '🙂', createdAt: 'x' },
      ]),
      'resume-designer-active-profile': 'pactive',
      // The user cleared their key here. Explicitly present, deliberately empty.
      'resume-p--pactive--resume-designer-data': JSON.stringify({ settings: { openrouterKey: '' } }),
      // An older profile still carrying the paid key they cleared.
      'resume-p--pother--resume-designer-data': JSON.stringify({
        settings: { openrouterKey: 'sk-paid-and-cleared' },
      }),
    });
    await initAppStorage({ backend });
    setProfileMapping('pactive');

    await extractSharedApiKey();
    await appStorage.flush();

    // The Clear stands, as the masking sentinel.
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('');
    // ...and the stale paid key is gone from disk rather than promoted.
    expect(JSON.stringify([...backend.files.values()])).not.toContain('sk-paid-and-cleared');
    expect(getSettings().openrouterKey).toBe('');
  });

  it('extractSharedApiKey does not resurrect a stale key over an existing empty shared value', async () => {
    appStorage.setItem(OPENROUTER_KEY_KEY, '');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-stale' } }));

    await extractSharedApiKey();

    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });

  // The key is shared across profiles by design, so a credential left in an
  // INACTIVE profile's blob is a stale duplicate — but a stale duplicate in
  // clear text under app_data_dir, which is the exposure this module exists to
  // close. Nothing visits a profile that is never switched to, so it lingered
  // there indefinitely, surviving even a Clear of the active key.
  it('extractSharedApiKey sanitizes INACTIVE profile blobs too', async () => {
    const backend = makeBackend({
      'resume-designer-profiles': JSON.stringify([
        { id: 'pactive', name: 'Ash', emoji: '🙂', createdAt: 'x' },
        { id: 'pother', name: 'Other', emoji: '🙂', createdAt: 'x' },
      ]),
      'resume-designer-active-profile': 'pactive',
      'resume-p--pactive--resume-designer-data': JSON.stringify({
        settings: { openrouterKey: 'sk-active', theme: 'dark' },
      }),
      'resume-p--pother--resume-designer-data': JSON.stringify({
        settings: { openrouterKey: 'sk-inactive-paid', theme: 'light' },
      }),
    });
    await initAppStorage({ backend });
    setProfileMapping('pactive');

    await extractSharedApiKey();
    // The strips land in the write-behind cache; the claim under test is about
    // what is left ON DISK, so drain before reading the backend.
    await appStorage.flush();

    // The ACTIVE profile's key wins the shared slot — it is the one in use.
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-active');
    // Both blobs are sanitized, and the rest of each blob is untouched.
    const active = JSON.parse(backend.files.get('resume-p--pactive--resume-designer-data'));
    const other = JSON.parse(backend.files.get('resume-p--pother--resume-designer-data'));
    expect(active.settings.openrouterKey).toBeUndefined();
    expect(other.settings.openrouterKey).toBeUndefined();
    expect(active.settings.theme).toBe('dark');
    expect(other.settings.theme).toBe('light');
    // Nothing readable left anywhere on disk.
    expect(JSON.stringify([...backend.files.values()])).not.toContain('sk-inactive-paid');
  });

  // The other direction: an inactive blob must not be stripped when it holds
  // the only credential. Deleting it would destroy the user's key outright —
  // the migration invariant applies to inactive blobs exactly as it does to
  // the active one.
  it('extractSharedApiKey adopts an inactive blob key when there is no other', async () => {
    const backend = makeBackend({
      'resume-designer-profiles': JSON.stringify([
        { id: 'pactive', name: 'Ash', emoji: '🙂', createdAt: 'x' },
        { id: 'pother', name: 'Other', emoji: '🙂', createdAt: 'x' },
      ]),
      'resume-designer-active-profile': 'pactive',
      'resume-p--pactive--resume-designer-data': JSON.stringify({ settings: { theme: 'dark' } }),
      'resume-p--pother--resume-designer-data': JSON.stringify({
        settings: { openrouterKey: 'sk-only-copy' },
      }),
    });
    await initAppStorage({ backend });
    setProfileMapping('pactive');

    await extractSharedApiKey();
    await appStorage.flush();

    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-only-copy');
    expect(JSON.parse(backend.files.get('resume-p--pother--resume-designer-data'))
      .settings.openrouterKey).toBeUndefined();
  });

  // A caught storage failure looked identical to success from outside, so boot
  // continued as though the credential were protected while a readable copy sat
  // in the blob and getSettings served it to every AI request. Passthrough
  // setItem throws SYNCHRONOUSLY once localStorage is full, which is the case
  // extraction's catch was swallowing.
  it('extractSharedApiKey reports a credential storage refused to move', async () => {
    localStorage.setItem('resume-designer-data', JSON.stringify({
      settings: { openrouterKey: 'sk-paid' },
    }));
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItem(k, v) {
      if (k === OPENROUTER_KEY_KEY) throw new Error('QuotaExceededError');
      return realSetItem.call(this, k, v);
    });

    try {
      const stranded = await extractSharedApiKey();

      expect(stranded).toBe('sk-paid');
      // The blob is untouched, so it is still the only copy — which is exactly
      // why the caller has to be told.
      expect(JSON.parse(localStorage.getItem('resume-designer-data')).settings.openrouterKey)
        .toBe('sk-paid');
    } finally {
      spy.mockRestore();
    }
  });

  // A corrupt blob is NOT a stranded credential — it is not one this app could
  // have read a key out of, and reporting it would push boot into a degraded
  // state over a value that does not exist.
  it('extractSharedApiKey reports nothing for an unparseable blob', async () => {
    localStorage.setItem('resume-designer-data', 'not json');
    expect(await extractSharedApiKey()).toBeNull();
  });

  // `''` is a RESULT, not an absence: the user's Clear, which storage refused to
  // consolidate. Collapsing it to null (via `inBlob || null`) let the sweep carry
  // on into inactive profiles and adopt an older key out of one — the Clear
  // undone by a profile the user has not opened.
  it('extractSharedApiKey does not let an inactive key outvote a stranded clear', async () => {
    setProfileMapping('pactive');
    localStorage.setItem('resume-p--pactive--resume-designer-data', JSON.stringify({
      settings: { openrouterKey: '' },              // the user cleared it
    }));
    localStorage.setItem('resume-p--pother--resume-designer-data', JSON.stringify({
      settings: { openrouterKey: 'sk-paid' },       // an older profile still has it
    }));

    // THE PRECONDITION: writing the shared sentinel throws, which is the only
    // way the active profile's clear ends up unconsolidated. Without this the
    // sentinel lands, the sweep skips, and there is nothing to outvote.
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function set(k, v) {
      if (k === OPENROUTER_KEY_KEY) throw new Error('QuotaExceededError');
      return realSetItem.call(this, k, v);
    });

    try {
      const stranded = await extractSharedApiKey();

      // The active profile's Clear is the answer — NOT the older paid key.
      expect(stranded).toBe('');
      expect(stranded).not.toBe('sk-paid');
    } finally {
      spy.mockRestore();
    }
  });

  // `in` on a truthy NON-object throws a TypeError, and that check sits outside
  // the parse catch since the catch was narrowed to tell a corrupt blob from a
  // storage refusal. Boot awaits this before initSecretStore, so one
  // hand-edited or imported profile aborted the rest of init.
  it('extractSharedApiKey survives a non-object settings blob', async () => {
    for (const settings of ['nope', 42, true, []]) {
      localStorage.setItem('resume-designer-data', JSON.stringify({ variants: {}, settings }));
      await expect(extractSharedApiKey()).resolves.toBeNull();
      // Left exactly as found, for loadFromStorage's own fallback to deal with.
      expect(JSON.parse(localStorage.getItem('resume-designer-data')).settings).toEqual(settings);
    }
  });

  // main.js calls this a second time as a safety net for the adoption paths
  // that return before reaching it. "An existing shared key wins" was read as
  // "a second call is free" — but appStorage.getItem serves the write-behind
  // cache, so the first call's FAILED write reads back exactly like a durable
  // one, and the second call stripped the blob against it.
  it('never strips the blob against a shared value that is only pending', async () => {
    const backend = makeBackend({
      'resume-designer-data': JSON.stringify({ settings: { openrouterKey: 'sk-paid' } }),
    });
    backend.write.mockImplementation(async (key, value) => {
      if (key === OPENROUTER_KEY_KEY) throw new Error('disk full');
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // First attempt: the shared write is queued and never reaches disk, so
      // the blob stays the only durable copy. This half already worked.
      await extractSharedApiKey();
      expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey)
        .toBe('sk-paid');

      // The safety-net call. Nothing durable has changed.
      await extractSharedApiKey();

      // Assert the CACHE, not the backend: the strip lands there immediately
      // and only reaches disk on a later drain, so a disk-only assertion
      // passes against the bug — it did, until the trace was actually read.
      expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey)
        .toBe('sk-paid');

      // ...and the durable outcome that follows from it. The blob write would
      // have succeeded on this drain (only the shared key is failing), so the
      // strip becomes permanent while the shared copy never exists: restart and
      // the credential is gone.
      await appStorage.flush();
      expect(backend.files.has(OPENROUTER_KEY_KEY)).toBe(false);
      expect(JSON.parse(backend.files.get('resume-designer-data')).settings.openrouterKey)
        .toBe('sk-paid');
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('shared api key overlay', () => {
  it('saveApiKey keeps the credential out of the blob AND out of storage', async () => {
    await saveApiKey('sk-new');
    saveSettings({ defaultModel: 'm' });

    // secretStore owns the credential now — the keychain on desktop, memory
    // only in a browser. It must never land in the per-profile blob beside the
    // resume, and no longer lands in plaintext storage either.
    const blob = JSON.parse(appStorage.getItem('resume-designer-data'));
    expect(blob.settings.openrouterKey).toBeUndefined();
    expect(blob.settings.defaultModel).toBe('m');
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBeNull();
    // ...and reads still see it.
    expect(getSettings().openrouterKey).toBe('sk-new');
  });

  it('getSettings falls back to a blob-resident key before extraction ran', () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }));
    expect(getSettings().openrouterKey).toBe('sk-blob');
  });

  // The boot cleanup deletes the legacy shared value — including when that
  // value is the EMPTY Clear sentinel, which in session mode is the only
  // durable thing masking a stale blob credential extraction could not remove.
  // Dropping it without scrubbing left the NEXT boot scanning an unmasked blob,
  // and the key the user cleared came back. Only provable across a reboot, and
  // only with the real extraction in the loop, so this runs the actual boot
  // sequence twice: extractSharedApiKey → initSecretStore.
  it('a cleared key does not come back after the sentinel is dropped', async () => {
    const BLOB = 'resume-p--pother--resume-designer-data';
    // The user cleared their key: sentinel present, and a stale copy still in
    // an inactive profile blob.
    localStorage.setItem(OPENROUTER_KEY_KEY, '');
    localStorage.setItem(BLOB, JSON.stringify({
      settings: { openrouterKey: 'sk-paid', theme: 'light' },
    }));

    // THE PRECONDITION, and the test was vacuous without it: storage refuses
    // to rewrite the blob, which is why the stale credential is still there.
    // With writes working, extraction scrubs it on the first boot and there is
    // nothing left to unmask.
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function set(k, v) {
      if (k === BLOB) throw new Error('QuotaExceededError');
      return realSetItem.call(this, k, v);
    });

    // Boot 1 — session mode (jsdom has no IndexedDB, so no encrypted backend).
    await initSecretStore({ backend: null, strandedPlaintext: await extractSharedApiKey() });
    expect(getSecret()).toBe('');
    // The blob still holds it, so the sentinel is still doing a job.
    expect(localStorage.getItem(BLOB)).toContain('sk-paid');

    // Storage recovers, and the app restarts.
    spy.mockRestore();
    __resetSecretStoreForTests();

    // Boot 2, against whatever boot 1 left behind. THE CLAIM: the key the user
    // cleared must not be back.
    await initSecretStore({ backend: null, strandedPlaintext: await extractSharedApiKey() });
    expect(getSecret()).not.toBe('sk-paid');
    expect(getSettings().openrouterKey).not.toBe('sk-paid');
    // ...and the rest of that profile's blob survived throughout.
    expect(JSON.parse(localStorage.getItem(BLOB)).settings.theme).toBe('light');
  });

  // The blob is a MIGRATION source, readable only until secretStore has spoken.
  // `browser-unreadable` returns null deliberately, to stop using a credential
  // it cannot verify — and this fallback was handing the stale blob key
  // straight back to aiService, keeping a superseded or revoked key in service
  // despite the fail-closed state existing for exactly that reason.
  it('getSettings stops serving the blob once the store has answered null', async () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({
      settings: { openrouterKey: 'sk-stale-revoked' },
    }));
    // Before the store answers, the blob is the only source there is.
    expect(getSettings().openrouterKey).toBe('sk-stale-revoked');

    // A browser store holding a record that cannot be decrypted: getSecret()
    // is null BY DESIGN, not because nothing is stored.
    const files = new Map([['openrouter-key-v1', { iv: new Uint8Array(12), data: new Uint8Array(8), version: 2 }]]);
    await initSecretStore({
      backend: {
        get: async (id) => (files.has(id) ? files.get(id) : null),
        put: async (id, v) => { files.set(id, v); },
        add: async (id, v) => { if (files.has(id)) throw new Error('ConstraintError'); files.set(id, v); },
        update: async (id, decide) => {
          const current = files.has(id) ? files.get(id) : null;
          const next = decide(current);
          if (next) files.set(id, next);
          return { wrote: !!next, current };
        },
      },
      channel: { onmessage: null, postMessage: () => {} },
    });

    expect(getSecret()).toBeNull();
    expect(getSettings().openrouterKey).toBe('');
  });

  it('an intentionally cleared credential masks a stale blob key', async () => {
    // Presence beats truthiness: a stored '' means the user cleared the key —
    // a leftover blob credential must never resurface through getSettings.
    // The sentinel lives in secretStore now, which is why clearing writes an
    // empty value rather than deleting the entry outright.
    await saveApiKey('');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-stale' } }));
    expect(getSettings().openrouterKey).toBe('');
  });
});

// Regression (PR #89 finding 39): loadRegistry() returns null for a lost or
// corrupt registry even when resume-p-- workspaces survive — the legacy
// migration guard needs a namespace check so the format-1 replacement can't
// wipe workspaces that rebuildRegistryFromKeys() would recover at boot.
describe('hasProfileNamespaces', () => {
  it('detects surviving physical workspaces', () => {
    expect(hasProfileNamespaces()).toBe(false);
    localStorage.setItem('resume-p--abc123--resume-designer-data', '{}');
    expect(hasProfileNamespaces()).toBe(true);
  });

  it('ignores physical keys whose logical part is not an owned key', () => {
    localStorage.setItem('resume-p--abc123--evil-key', 'x');
    expect(hasProfileNamespaces()).toBe(false);
  });
});

// Regression (PR #89 finding 40): saveSettings stripped the blob's legacy
// credential while the shared-key write could still be non-durable (cached
// mode flushes the two files independently) — the same loss window the
// extraction path fixed, reopened through every ordinary settings save.
describe('saveSettings blob-credential fallback', () => {
  it('never strips a pre-extraction blob credential', async () => {
    localStorage.setItem('resume-designer-data', JSON.stringify({
      variants: {}, settings: { openrouterKey: 'sk-legacy', theme: 'light' },
    }));

    await saveApiKey('sk-new');
    saveSettings({ autoUpdateCheck: true });

    // secretStore holds the new value; the blob FALLBACK survives untouched.
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBeNull();
    const blob = JSON.parse(localStorage.getItem('resume-designer-data'));
    expect(blob.settings.openrouterKey).toBe('sk-legacy');
    // And the overlay masks it — reads still see the shared value.
    expect(getSettings().openrouterKey).toBe('sk-new');
  });
});

// The predicate is the ONLY thing in the sync-bootstrap feature that can
// discard a workspace, so every clause gets a test proving that violating THAT
// clause alone keeps the workspace. See
// docs/superpowers/specs/2026-08-13-sync-bootstrap-design.md §4.
describe('isUntouchedWorkspace', () => {
  // The predicate only ever judges the ACTIVE profile, so the harness activates
  // it and writes through ordinary appStorage — the same path production takes.
  // A helper that hand-built namespaced keys would be a parallel implementation
  // of the mapping and could pass while production read somewhere else.
  function activate(profileId) {
    appStorage.setItem(ACTIVE_PROFILE_KEY, profileId);
    setProfileMapping(profileId);
  }

  function startWorkspace(name = 'Starter') {
    const profile = createProfile({ name });
    activate(profile.id);
    return profile;
  }

  function writeProfileKey(profileId, logicalKey, value) {
    activate(profileId);
    appStorage.setItem(logicalKey, value);
  }

  it('is true for a workspace straight out of init', () => {
    const fresh = startWorkspace('Fresh');
    expect(isUntouchedWorkspace(fresh.id)).toBe(true);
  });

  // Was `is true with only the single résumé init leaves behind`, which pinned a
  // state no shipping platform produces: on Tauri and iOS migrateBuiltInVariants
  // seeds NOTHING (persistence.js), so init leaves no résumé behind and any
  // variant present was authored. The allowance deleted the ordinary no-AI
  // onboarding path — saveOnboardingResume writes exactly one variant, writes no
  // history (only pushHistory does, on edits), never touches userProfile and
  // spends no tokens, so it passed every other clause.
  it('is false once the workspace holds any résumé at all', () => {
    const p = startWorkspace();
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({
      variants: { 'custom-1755000000000': { id: 'custom-1755000000000', name: 'My Resume', data: {} } },
      currentVariantId: 'custom-1755000000000',
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // An array is typeof 'object' and has no `variants`, so '[]' sailed through
  // the whole blob clause. A blob shaped like nothing this app writes is doubt.
  it('is false when the blob is not the object shape this app writes', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', '[]');
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false once renamed', () => {
    const p = startWorkspace('P');
    renameProfile(p.id, { name: 'Renamed' });
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when any version history exists', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-history-v1', JSON.stringify({ history: [{}] }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when a second résumé exists', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({ variants: { a: {}, b: {} } }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is false when any list has content', () => {
    for (const key of [
      'resume-designer-applications',
      'resume-designer-job-descriptions',
      'resume-designer-chat-threads',
      'resume-designer-chat-history',
      'resume-designer-learned-answers',
    ]) {
      const p = startWorkspace(key);
      writeProfileKey(p.id, key, JSON.stringify([{ id: 'x' }]));
      expect(isUntouchedWorkspace(p.id), `${key} must count`).toBe(false);
    }
  });

  it('is false when tokens were spent', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-token-usage', JSON.stringify({ events: [{ total: 1 }] }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('keeps the workspace when a key cannot be read', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-applications', '{ not json');
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // ADDED beyond the brief. The Profile screen writes straight into the data
  // blob and records NO version history, so a person who filled in their
  // contact details and work history but never opened a résumé passes every
  // other clause — and this is the one step in the feature that would then
  // delete what they typed.
  it('is false when the user profile holds authored content', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({
      variants: {},
      userProfile: { contactInfo: { fullName: 'Ash Shah', email: '' }, workExperience: [] },
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('is true for the empty user-profile skeleton a fresh save writes', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({
      variants: {},
      userProfile: { contactInfo: { fullName: '', email: '   ' }, workExperience: [], skills: [] },
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(true);
  });

  // THE field-level twin of the unknown-KEY test below, and the one that makes
  // this inversion worth doing. The blob clause only ever examined `variants`
  // and `userProfile`; `settings` and `currentVariantId` passed unexamined, and
  // so would any field a later release adds to this blob — a `coverLetters`
  // field would be silently vouched for exactly the way an unenumerated key
  // used to be, one level up.
  it('is false for a top-level blob field it has never heard of', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({
      variants: {},
      coverLetters: { a: {} },
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // The allowlist's other side: `settings` is a decided allowance, not an
  // oversight (every field in DEFAULT_STORAGE.settings is a design/AI/view
  // preference, and no credential can reach it — saveSettings strips
  // `openrouterKey` and the key lives in the OS keychain), and
  // `currentVariantId` is a pointer, not content. Refusing either would fail
  // adoption on every ordinary settings interaction.
  it('is true with settings and currentVariantId present alongside empty variants', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({
      variants: {},
      currentVariantId: null,
      settings: { colorPalette: 'terracotta', customModels: ['openrouter/some-model'] },
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(true);
  });

  // The most dangerous case of all: the active POINTER names this profile but
  // the key mapping is inactive (a degraded init runs exactly like that), so
  // every ordinary read resolves to the unprefixed keys and a full workspace
  // reads back as empty.
  //
  // It plants a RÉSUMÉ BLOB rather than a history key on purpose. The key walk
  // iterates physical keys and is mapping-independent, so a planted history key
  // refused through that walk even with the mapping guard deleted — the guard
  // protecting the highest-stakes relaxation in this feature was pinned by
  // nothing. The blob is read through the mapping: with the guard removed the
  // read misses the namespace, returns null, and the predicate calls a
  // two-résumé workspace untouched.
  it('keeps the workspace when key mapping is not active for it', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-designer-data', JSON.stringify({ variants: { a: {}, b: {} } }));
    setProfileMapping(null); // pointer still says p.id; reads no longer namespace
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  it('refuses a profile that is not the active one', () => {
    const active = startWorkspace('Active');
    const other = createProfile({ name: 'Other' });
    expect(isUntouchedWorkspace(other.id)).toBe(false);
    expect(isUntouchedWorkspace(active.id)).toBe(true); // the guard, not the data
  });

  it('refuses a profile with no registry entry', () => {
    const p = startWorkspace('P');
    appStorage.setItem(PROFILES_KEY, JSON.stringify(
      loadRegistry().filter((entry) => entry.id !== p.id).concat(
        [{ id: 'pother', name: 'Other', emoji: '🙂', createdAt: 'x' }],
      ),
    ));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // THE test that makes the allowlist worth having. The predicate used to
  // enumerate the keys it checked, so any key nobody remembered to enumerate
  // was silently vouched for — a key a later release adds to BACKUP_FIXED_KEYS
  // lands in the namespace looking exactly like this, and the enumeration would
  // have called the workspace empty and deleted it.
  it('is false for a key in the namespace it has never heard of', () => {
    const p = startWorkspace('P');
    localStorage.setItem(physicalKey(p.id, 'resume-designer-timesheets'), '[]');
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // The live instance of the same hole: the headshot somebody uploaded and
  // cropped is stored here, savePhotoSettings writes NO history entry, and the
  // enumeration declared the workspace empty.
  it('is false when a headshot was uploaded', () => {
    const p = startWorkspace('P');
    writeProfileKey(p.id, 'resume-photo-settings', JSON.stringify({
      enabled: true, imageData: 'data:image/png;base64,iVBORw0KGgo=', shape: 'circle',
    }));
    expect(isUntouchedWorkspace(p.id)).toBe(false);
  });

  // The other side of the allowlist: an inversion that refused everything would
  // pass every test above and never adopt anything. A starter workspace picks
  // these up just by being opened once.
  it('is true with only preferences, flags and sync bookkeeping in the namespace', () => {
    const p = startWorkspace('P');
    for (const [key, value] of [
      [SYNC_STATE_KEY, JSON.stringify({ deviceId: 'dev1', units: {} })],
      ['resume-designer-onboarding-complete', 'true'],
      ['resume-edit-hint-dismissed', 'true'],
      ['resume-header-style', 'centered'],
      ['resume-accent-settings', JSON.stringify({ color: '#0a84ff' })],
      ['resume-font-settings', JSON.stringify({ family: 'Inter' })],
      ['resume-spacing-settings', JSON.stringify({ scale: 1.1 })],
      ['resume-zoom', '1.25'],
    ]) writeProfileKey(p.id, key, value);
    expect(isUntouchedWorkspace(p.id)).toBe(true);
  });

  // The other direction: another workspace's history must not be read as this
  // one's, or the feature never fires on a device that holds several profiles.
  it('ignores another profile’s version history', () => {
    const p = startWorkspace('P');
    const other = createProfile({ name: 'Other' });
    localStorage.setItem(`resume-p--${other.id}--resume-designer-history-v1`, '{"history":[{}]}');
    expect(isUntouchedWorkspace(p.id)).toBe(true);
  });
});

// The bootstrap flow: a clean install that has since unioned the account's
// registry into its own absorbs its starter workspace and opens one of the
// adopted ones. Spec §4.
describe('fresh-device adoption', () => {
  const STARTER_KEY = 'resume-profile-starter';

  async function landAccountRegistry(registry) {
    const landed = await applyUnits([{
      id: `key:${PROFILES_KEY}`,
      kind: 'plain',
      payload: JSON.stringify(registry),
      modifiedAt: '2026-08-14T00:00:00.000Z',
    }]);
    expect(landed).toEqual({ applied: 1 });
  }

  function seedAccount({ starterTouched = false, starterMarker = true } = {}) {
    // Deliberately unsorted, so the "least-recently-created" choice cannot be
    // "whatever sits at index 0".
    localStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'plater', name: 'iPad', emoji: '🙂', createdAt: '2026-07-15T00:00:00.000Z' },
      { id: 'pstarter', name: 'My profile', emoji: '🙂', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'pfirst', name: 'iPhone', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z' },
    ]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pstarter');
    if (starterMarker) localStorage.setItem(STARTER_KEY, 'pstarter');
    // No variant: init seeds none on the platforms this runs on, and one that
    // is there was authored (isUntouchedWorkspace). A seed with a résumé in it
    // would make every case below refuse for that reason instead of the one
    // under test.
    localStorage.setItem('resume-p--pstarter--resume-designer-data', '{"variants":{}}');
    if (starterTouched) {
      localStorage.setItem('resume-p--pstarter--resume-designer-history-v1', '{"history":[{}]}');
    }
    setProfileMapping(null); // a fresh boot
  }

  it('records the starter workspace init created for itself', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });

    const id = await ensureProfilesInitialized();

    // On DISK with the registry it names — a marker that never lands simply
    // means this install can never adopt, which is the safe direction.
    expect(backend.files.get(STARTER_KEY)).toBe(id);
  });

  it('adopts an account workspace discovered after first-session init', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    const starterId = await ensureProfilesInitialized();
    const accountProfile = {
      id: 'paccount', name: 'Account', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z',
    };

    await landAccountRegistry([accountProfile]);
    const adoptedId = await adoptAccountWorkspaces();

    expect(adoptedId).toBe(accountProfile.id);
    const diskRegistry = JSON.parse(backend.files.get(PROFILES_KEY));
    expect(diskRegistry.find((p) => p.id === starterId).deletedAt).toEqual(expect.any(String));
    expect(diskRegistry.find((p) => p.id === accountProfile.id).deletedAt).toBeUndefined();
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe(accountProfile.id);
  });

  it('refuses mid-session adoption after the starter gains authored content', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    const starterId = await ensureProfilesInitialized();
    appStorage.setItem('resume-designer-data', JSON.stringify({
      variants: { authored: { id: 'authored', name: 'My Resume', data: {} } },
      currentVariantId: 'authored',
    }));
    expect(await appStorage.flush()).toBe(true);
    const accountProfile = {
      id: 'paccount', name: 'Account', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z',
    };

    await landAccountRegistry([accountProfile]);
    const adoptedId = await adoptAccountWorkspaces();

    expect(adoptedId).toBeNull();
    const diskRegistry = JSON.parse(backend.files.get(PROFILES_KEY));
    expect(diskRegistry.find((p) => p.id === starterId).deletedAt).toBeUndefined();
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe(starterId);
    expect(backend.files.get(physicalKey(starterId, 'resume-designer-data'))).not.toBeNull();
  });

  it('writes nothing when there is no account workspace to adopt', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    await ensureProfilesInitialized();
    backend.write.mockClear();
    backend.delete.mockClear();

    expect(await adoptAccountWorkspaces()).toBeNull();

    expect(backend.write).not.toHaveBeenCalled();
    expect(backend.delete).not.toHaveBeenCalled();
  });

  it('tombstones the untouched starter and opens the least-recently-created workspace', async () => {
    const backend = makeBackend({
      [PROFILES_KEY]: JSON.stringify([
        { id: 'plater', name: 'iPad', emoji: '🙂', createdAt: '2026-07-15T00:00:00.000Z' },
        { id: 'pstarter', name: 'My profile', emoji: '🙂', createdAt: '2026-08-01T00:00:00.000Z' },
        { id: 'pfirst', name: 'iPhone', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z' },
      ]),
      [ACTIVE_PROFILE_KEY]: 'pstarter',
      [STARTER_KEY]: 'pstarter',
      'resume-p--pstarter--resume-designer-data': '{"variants":{}}',
      // Sync bookkeeping is on the harmless allowlist — a workspace that has
      // merely been synced is still a starter workspace.
      'resume-p--pstarter--resume-designer-sync-state': '{}',
    });
    await initAppStorage({ backend });

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pfirst');
    expect(getActiveProfileId()).toBe('pfirst');
    // TOMBSTONED, not dropped: a bare removal is undone by the next union merge
    // if this device's own registry ever reached the server first.
    const disk = JSON.parse(backend.files.get(PROFILES_KEY));
    expect(disk.find((p) => p.id === 'pstarter').deletedAt).toEqual(expect.any(String));
    expect(disk.map((p) => p.id).sort()).toEqual(['pfirst', 'plater', 'pstarter']);
    expect(listProfiles().map((p) => p.id).sort()).toEqual(['pfirst', 'plater']);
    // The namespace is gone from DISK, and so is the marker it named.
    expect([...backend.files.keys()].filter((k) => k.startsWith('resume-p--pstarter--'))).toEqual([]);
    expect(backend.files.has(STARTER_KEY)).toBe(false);
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('pfirst');
  });

  it('keeps a starter workspace that has been touched', async () => {
    seedAccount({ starterTouched: true });

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pstarter');
    expect(getActiveProfileId()).toBe('pstarter');
    expect(loadRegistry().find((p) => p.id === 'pstarter').deletedAt).toBeUndefined();
    expect(localStorage.getItem('resume-p--pstarter--resume-designer-data')).toBe('{"variants":{}}');
  });

  // A workspace the PERSON created is empty and unstamped at the moment they
  // make it, exactly like the one init creates — only the marker tells them
  // apart, and creating a workspace and relaunching before putting anything in
  // it must not delete it.
  it('never absorbs a workspace this install did not create for itself', async () => {
    seedAccount({ starterMarker: false });

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pstarter');
    expect(loadRegistry().find((p) => p.id === 'pstarter').deletedAt).toBeUndefined();
  });

  it('does nothing when the account has no other workspace', async () => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'pstarter', name: 'My profile', emoji: '🙂', createdAt: '2026-08-01T00:00:00.000Z' },
    ]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pstarter');
    localStorage.setItem(STARTER_KEY, 'pstarter');
    setProfileMapping(null);

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pstarter');
    expect(loadRegistry()).toHaveLength(1);
    expect(loadRegistry()[0].deletedAt).toBeUndefined();
  });

  it('ignores tombstoned workspaces when choosing what to open', async () => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'pdead', name: 'Deleted', emoji: '🙂', createdAt: '2026-06-01T00:00:00.000Z', deletedAt: '2026-07-02T00:00:00.000Z', updatedAt: '2026-07-02T00:00:00.000Z' },
      { id: 'pstarter', name: 'My profile', emoji: '🙂', createdAt: '2026-08-01T00:00:00.000Z' },
      { id: 'pfirst', name: 'iPhone', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z' },
    ]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pstarter');
    localStorage.setItem(STARTER_KEY, 'pstarter');
    setProfileMapping(null);

    const id = await ensureProfilesInitialized();

    expect(id).toBe('pfirst'); // not pdead, which is older still
  });

  it('keeps the starter workspace when the adoption cannot reach disk', async () => {
    const backend = makeBackend({
      [PROFILES_KEY]: JSON.stringify([
        { id: 'pstarter', name: 'My profile', emoji: '🙂', createdAt: '2026-08-01T00:00:00.000Z' },
        { id: 'pfirst', name: 'iPhone', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z' },
      ]),
      [ACTIVE_PROFILE_KEY]: 'pstarter',
      [STARTER_KEY]: 'pstarter',
      'resume-p--pstarter--resume-designer-data': '{"variants":{}}',
    });
    backend.write.mockImplementation(async (key, value) => {
      if (key === PROFILES_KEY) throw new Error('disk full');
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized();

      // A tombstone that landed without its pointer would leave the app active
      // in a workspace nothing lists and no later boot could adopt out of, so
      // BOTH are restored and the starter workspace stays.
      expect(id).toBe('pstarter');
      expect(getActiveProfileId()).toBe('pstarter');
      expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('pstarter');
      expect(loadRegistry().find((p) => p.id === 'pstarter').deletedAt).toBeUndefined();
      // And the namespace it would have deleted is untouched, on disk.
      expect(backend.files.get('resume-p--pstarter--resume-designer-data')).toBe('{"variants":{}}');
    } finally {
      errSpy.mockRestore();
    }
  });

  // The tombstone is the one thing in this feature that can name the ACTIVE
  // profile — through a half-durable adoption, or through another device
  // deleting the workspace this one is sitting in. Either way boot must move to
  // a workspace the switcher can actually show.
  it('moves off an active profile another device deleted', async () => {
    localStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'pgone', name: 'Gone', emoji: '🙂', createdAt: '2026-07-01T00:00:00.000Z', deletedAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z' },
      { id: 'plive', name: 'Live', emoji: '🙂', createdAt: '2026-07-05T00:00:00.000Z' },
    ]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pgone');
    setProfileMapping(null);

    const id = await ensureProfilesInitialized();

    expect(id).toBe('plive');
    expect(getActiveProfileId()).toBe('plive');
  });
});
