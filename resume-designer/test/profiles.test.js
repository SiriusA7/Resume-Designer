import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
} from '../src/appStorage.js';
import {
  loadRegistry, getActiveProfileId, setActiveProfile,
  createProfile, renameProfile, deleteProfile,
  ensureProfilesInitialized, extractSharedApiKey, isAdoptionPending,
  activateProfileMappingForPrint,
} from '../src/profiles.js';
import { PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY } from '../src/profileKeys.js';
import { getSettings, saveSettings } from '../src/persistence.js';

beforeEach(() => {
  __resetAppStorageForTests();
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
    // Deterministic generateProfileId: freeze time and step Math.random so
    // the first roll collides with a seeded id, the second roll differs.
    vi.spyOn(Date, 'now').mockReturnValue(1000000);
    const rand = vi.spyOn(Math, 'random');
    rand.mockReturnValueOnce(0.123456789).mockReturnValueOnce(0.123456789).mockReturnValueOnce(0.987654321);
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
    expect(loadRegistry()).toHaveLength(1);
    expect(() => deleteProfile(a.id)).toThrow(); // last remaining
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

  it('extractSharedApiKey never clobbers an existing shared key', () => {
    appStorage.setItem(OPENROUTER_KEY_KEY, 'sk-keep');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-old' } }));
    extractSharedApiKey();
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-keep');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });

  it('extractSharedApiKey strips an empty blob key without creating a shared key', () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: '' } }));

    extractSharedApiKey();

    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBeNull();
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });

  it('extractSharedApiKey does not resurrect a stale key over an existing empty shared value', () => {
    appStorage.setItem(OPENROUTER_KEY_KEY, '');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-stale' } }));

    extractSharedApiKey();

    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
  });
});

describe('shared api key overlay', () => {
  it('saveSettings routes openrouterKey to the shared key and strips it from the blob', () => {
    saveSettings({ openrouterKey: 'sk-new', defaultModel: 'm' });
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-new');
    const blob = JSON.parse(appStorage.getItem('resume-designer-data'));
    expect(blob.settings.openrouterKey).toBeUndefined();
    expect(blob.settings.defaultModel).toBe('m');
    expect(getSettings().openrouterKey).toBe('sk-new');
  });

  it('getSettings falls back to a blob-resident key before extraction ran', () => {
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }));
    expect(getSettings().openrouterKey).toBe('sk-blob');
  });

  it('an intentionally cleared shared key masks a stale blob key', () => {
    // Presence beats truthiness: '' in the shared key means the user cleared
    // it — a leftover blob credential must never resurface through getSettings.
    appStorage.setItem(OPENROUTER_KEY_KEY, '');
    appStorage.setItem('resume-designer-data', JSON.stringify({ settings: { openrouterKey: 'sk-stale' } }));
    expect(getSettings().openrouterKey).toBe('');
  });
});
