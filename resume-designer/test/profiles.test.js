import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
} from '../src/appStorage.js';
import {
  loadRegistry, getActiveProfileId, setActiveProfile,
  createProfile, renameProfile, deleteProfile,
  ensureProfilesInitialized, extractSharedApiKey,
} from '../src/profiles.js';
import { PROFILES_KEY, ACTIVE_PROFILE_KEY, OPENROUTER_KEY_KEY } from '../src/profileKeys.js';

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

  it('rejects colon-bearing ids as corrupt (physical-key separator)', () => {
    appStorage.setItem(PROFILES_KEY, JSON.stringify([
      { id: 'p:evil', name: 'X', emoji: '🙂', createdAt: 'x' },
    ]));
    expect(loadRegistry()).toBeNull();
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
    appStorage.setItem(`resume-p:${b.id}:resume-designer-data`, '{}');
    appStorage.setItem(`resume-p:${b.id}:resume-designer-history-v1`, '[]');
    expect(() => deleteProfile(a.id)).toThrow(/active/i);
    deleteProfile(b.id);
    expect(appStorage.keys().some((k) => k.includes(b.id))).toBe(false);
    expect(loadRegistry()).toHaveLength(1);
    expect(() => deleteProfile(a.id)).toThrow(); // last remaining
  });
});

describe('adoption migration', () => {
  it('makes the marker durable and copies every source before deleting any source', async () => {
    const operations = [];
    const backend = makeBackend({ 'resume-designer-data': '{"variants":{}}' });
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

    const markerWrite = operations.indexOf('write:__profile_adoption_pending__');
    const registryWrite = operations.indexOf(`write:${PROFILES_KEY}`);
    const copyWrites = operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation.startsWith('write:resume-p:'));
    const sourceDeletes = operations
      .map((operation, index) => ({ operation, index }))
      .filter(({ operation }) => operation === 'delete:resume-designer-data');

    expect(markerWrite).toBeGreaterThanOrEqual(0);
    expect(markerWrite).toBeLessThan(registryWrite);
    expect(copyWrites).not.toHaveLength(0);
    expect(sourceDeletes).not.toHaveLength(0);
    expect(Math.max(...copyWrites.map(({ index }) => index)))
      .toBeLessThan(Math.min(...sourceDeletes.map(({ index }) => index)));
    expect(operations.at(-1)).toBe('delete:__profile_adoption_pending__');
    expect(backend.files.get(`resume-p:${id}:resume-designer-data`)).toBe('{"variants":{}}');
    expect(backend.files.has('resume-designer-data')).toBe(false);
    expect(backend.files.has('__profile_adoption_pending__')).toBe(false);
  });

  it('keeps sources and the marker durable when adoption copies fail', async () => {
    const backend = makeBackend({ 'resume-designer-data': '{"variants":{}}' });
    backend.write.mockImplementation(async (key, value) => {
      if (key.startsWith('resume-p:')) throw new Error('disk full');
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const id = await ensureProfilesInitialized();

      expect(id).not.toBeNull();
      expect(backend.files.get('resume-designer-data')).toBe('{"variants":{}}');
      expect(backend.files.get('__profile_adoption_pending__')).toBe('1');
      expect(appStorage.getItem('resume-designer-data')).toBe('{"variants":{}}');
    } finally {
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
    expect(localStorage.getItem(`resume-p:${id}:resume-designer-history-v1`)).toBe('[]');
    expect(localStorage.getItem('resume-designer-history-v1')).toBeNull();
    // …shared keys did not move…
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    // …the API key was extracted to the shared key and stripped from the blob…
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-or-abc');
    const blob = JSON.parse(localStorage.getItem(`resume-p:${id}:resume-designer-data`));
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
    localStorage.setItem('resume-p:pold:resume-designer-data',
      '{"variants":{},"userProfile":{"contactInfo":{"fullName":"Ash Shah"}}}');
    localStorage.setItem('resume-p:pold:resume-zoom', '1.25');
    localStorage.setItem(PROFILES_KEY, '{corrupt');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pold');
    expect(loadRegistry()).toHaveLength(1);
    expect(loadRegistry()[0]).toMatchObject({ id: 'pold', name: 'Ash Shah' });
    expect(appStorage.getItem('resume-zoom')).toBe('1.25'); // mapped read works again
  });

  it('resumes an interrupted adoption under the same profile id', async () => {
    localStorage.setItem('resume-designer-data', '{"variants":{}}');
    localStorage.setItem('__profile_adoption_pending__', '1');
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'pfixed', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'pfixed');

    const id = await ensureProfilesInitialized();
    expect(id).toBe('pfixed');
    expect(localStorage.getItem('resume-p:pfixed:resume-designer-data')).toBe('{"variants":{}}');
    expect(localStorage.getItem('__profile_adoption_pending__')).toBeNull();
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
