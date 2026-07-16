import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appStorage, initAppStorage, __resetAppStorageForTests } from '../src/appStorage.js';
import {
  createProfile, ensureProfilesInitialized, loadRegistry,
  exportProfileBackup, importProfileBackup, activateProfileDurably,
  extractSharedApiKey, deleteProfileDurably,
} from '../src/profiles.js';
import { importFullBackupFromEnvelope, exportFullBackup } from '../src/persistence.js';
import { OPENROUTER_KEY_KEY, ACTIVE_PROFILE_KEY, PROFILES_KEY } from '../src/profileKeys.js';

beforeEach(() => {
  vi.restoreAllMocks(); // undo any Storage.prototype.setItem spy a prior test left installed
  __resetAppStorageForTests();
  localStorage.clear();
});

// In-memory fake of the Rust disk backend (the `invoke` seam) for cached-mode tests.
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

// jsdom: capture the download instead of clicking a real anchor.
function captureDownload() {
  const blobs = [];
  vi.stubGlobal('URL', {
    ...URL,
    createObjectURL: (b) => { blobs.push(b); return 'blob:x'; },
    revokeObjectURL: () => {},
  });
  return async () => JSON.parse(await blobs[0].text());
}

async function seedTwoProfiles() {
  localStorage.setItem('resume-designer-data', '{"variants":{"v1":{}},"settings":{},"userProfile":{"contactInfo":{"fullName":"Ash"}}}');
  const ashId = await ensureProfilesInitialized();
  const partner = createProfile({ name: 'Partner', emoji: '🐙' });
  appStorage.setItem(`resume-p--${partner.id}--resume-designer-data`, '{"variants":{"v2":{}}}');
  appStorage.setItem('resume-designer-theme', 'dark');
  appStorage.setItem(OPENROUTER_KEY_KEY, 'sk-shared');
  return { ashId, partnerId: partner.id };
}

describe('format-2 export/restore', () => {
  it('round-trips both profiles, the registry, and shared keys', async () => {
    const { ashId, partnerId } = await seedTwoProfiles();
    const readDownload = captureDownload();
    exportFullBackup();
    const envelope = await readDownload();

    expect(envelope).toMatchObject({ backupFormat: 2, kind: 'full', activeProfile: ashId });
    expect(Object.keys(envelope.profiles).sort()).toEqual([ashId, partnerId].sort());
    expect(envelope.shared['resume-designer-theme']).toBe('dark');
    expect(envelope.shared[OPENROUTER_KEY_KEY]).toBe('sk-shared');

    localStorage.clear();
    __resetAppStorageForTests();
    const result = importFullBackupFromEnvelope(envelope);
    expect(result.keysImported).toBeGreaterThan(0);
    expect(loadRegistry()).toHaveLength(2);
    expect(localStorage.getItem(`resume-p--${partnerId}--resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    expect(localStorage.getItem(ACTIVE_PROFILE_KEY)).toBe(ashId);
  });

  it('round-trips a freshly created profile that has no stored keys yet', async () => {
    // A keyless profile exports with NO profiles entry (exportFullBackup only
    // creates one per observed physical key) — the app's own backup must
    // still restore, with the empty profile surviving in the registry.
    const { ashId } = await seedTwoProfiles();
    const empty = createProfile({ name: 'Fresh', emoji: '🌱' });
    const readDownload = captureDownload();
    exportFullBackup();
    const envelope = await readDownload();
    expect(envelope.profiles[empty.id]).toBeUndefined();
    expect(envelope.registry.map((p) => p.id)).toContain(empty.id);

    localStorage.clear();
    __resetAppStorageForTests();
    expect(() => importFullBackupFromEnvelope(envelope)).not.toThrow();
    expect(loadRegistry()).toHaveLength(3);
    expect(localStorage.getItem(ACTIVE_PROFILE_KEY)).toBe(ashId);
  });

  it('captures unprefixed live data (incomplete-adoption recovery) under the active profile', () => {
    // Recovery state: adoption left mapping OFF, so the live workspace is still
    // at unprefixed keys. A backup taken here (per the storage-failure guidance)
    // must still contain the résumé data, not just registry + shared settings.
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'prec', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'prec');
    localStorage.setItem('resume-designer-data', '{"variants":{"LIVE":{}}}');
    localStorage.setItem('resume-designer-theme', 'dark'); // shared → shared section
    // mapping is off (never activated) — the recovery state.

    const readDownload = captureDownload();
    exportFullBackup();
    return readDownload().then((envelope) => {
      expect(envelope.profiles.prec.keys['resume-designer-data']).toBe('{"variants":{"LIVE":{}}}');
      expect(envelope.shared['resume-designer-theme']).toBe('dark');
    });
  });

  it('rejects an array profiles container before touching existing storage', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 'Profile' }],
      activeProfile: 'p',
      shared: {},
      profiles: [],
    })).toThrow(/"profiles" must be an object/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });

  it('rejects a malformed profile before touching existing storage', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 'Profile' }],
      activeProfile: 'p',
      shared: {},
      profiles: { p: null },
    })).toThrow(/invalid format-2 backup/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });

  it('rejects a non-string shared value before touching existing storage', () => {
    // A corrupt shared value must reject PRE-wipe — otherwise the clean slate
    // erases the real API key and the guarded write loop skips the bad one,
    // reporting success after destroying a machine-level setting.
    localStorage.setItem('resume-designer-theme', 'keep-me');
    localStorage.setItem(OPENROUTER_KEY_KEY, 'sk-keep');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 'Profile' }],
      activeProfile: 'p',
      shared: { [OPENROUTER_KEY_KEY]: 12345 },
      profiles: {},
    })).toThrow(/shared key .* must be a string/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-keep');
  });

  it('rejects a non-object shared container before touching existing storage', () => {
    // A string or array `shared` survives Object.entries (its entries are
    // strings), slipping past the per-value string check — so the container
    // shape must be validated pre-wipe too, or settings get erased.
    localStorage.setItem('resume-designer-theme', 'keep-me');
    localStorage.setItem(OPENROUTER_KEY_KEY, 'sk-keep');

    for (const badShared of ['corrupt', ['resume-designer-theme'], 42]) {
      expect(() => importFullBackupFromEnvelope({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: 'p', name: 'Profile' }],
        activeProfile: 'p',
        shared: badShared,
        profiles: {},
      })).toThrow(/"shared" must be an object/i);
    }

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-keep');
  });

  it('rejects a non-string registry emoji before touching existing storage', () => {
    // The switcher renders emoji directly as a React child; a non-string (e.g.
    // {}) would throw and blank the app after the restore already wiped storage.
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 'Profile', emoji: {} }],
      activeProfile: 'p',
      shared: {},
      profiles: {},
    })).toThrow(/string emoji/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });

  it('rejects a non-string registry name before touching existing storage', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 42, emoji: '🙂' }],
      activeProfile: 'p',
      shared: {},
      profiles: {},
    })).toThrow(/invalid format-2 backup/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });

  it('rejects duplicate registry ids before touching existing storage', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'same', name: 'One' }, { id: 'same', name: 'Two' }],
      activeProfile: 'same',
      shared: {},
      profiles: {},
    })).toThrow(/invalid format-2 backup/i);

    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });

  it('reports the number of existing keys wiped during a round-trip restore', async () => {
    await seedTwoProfiles();
    const readDownload = captureDownload();
    exportFullBackup();
    const envelope = await readDownload();
    const existingKeyCount = localStorage.length;

    const result = importFullBackupFromEnvelope(envelope);

    expect(existingKeyCount).toBeGreaterThan(0);
    expect(result.removedExistingKeys).toBe(existingKeyCount);
  });

  it('writes critical data for every profile before best-effort history', () => {
    const originalSetItem = Storage.prototype.setItem;
    let historyAttempted = false;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.includes('resume-designer-history-')) {
        historyAttempted = true;
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      if (key === 'resume-p--b--resume-designer-data' && historyAttempted) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    });

    const result = importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      activeProfile: 'a',
      shared: {},
      profiles: {
        a: { keys: { 'resume-designer-history-v1': 'large-history' } },
        b: { keys: { 'resume-designer-data': '{"variants":{}}' } },
      },
    });

    expect(localStorage.getItem('resume-p--b--resume-designer-data')).toBe('{"variants":{}}');
    expect(result.historySkipped).toBe(1);
  });
});

describe('format-1 import scoping', () => {
  it('restores a legacy envelope into the active profile without touching others', async () => {
    const { ashId, partnerId } = await seedTwoProfiles();
    importFullBackupFromEnvelope({
      backupFormat: 1,
      keys: {
        'resume-designer-data': '{"variants":{"legacy":{}}}',
        'resume-designer-theme': 'light',
      },
    });
    // active profile replaced…
    expect(localStorage.getItem(`resume-p--${ashId}--resume-designer-data`)).toBe('{"variants":{"legacy":{}}}');
    // …partner untouched, registry intact…
    expect(localStorage.getItem(`resume-p--${partnerId}--resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
    expect(loadRegistry()).toHaveLength(2);
    // …shared owned keys in the envelope still land (theme is shared)…
    expect(localStorage.getItem('resume-designer-theme')).toBe('light');
    // …and the shared api key survives (not part of format-1 envelopes).
    expect(localStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-shared');
  });
});

describe('per-profile export/import', () => {
  it('exports one profile and imports it as a NEW profile', async () => {
    const { partnerId } = await seedTwoProfiles();
    const readDownload = captureDownload();
    await exportProfileBackup(partnerId);
    const envelope = await readDownload();
    expect(envelope).toMatchObject({ backupFormat: 2, kind: 'profile', name: 'Partner' });
    expect(envelope.keys['resume-designer-data']).toBe('{"variants":{"v2":{}}}');

    const imported = await importProfileBackup(envelope);
    expect(imported.id).not.toBe(partnerId);
    expect(loadRegistry()).toHaveLength(3);
    expect(localStorage.getItem(`resume-p--${imported.id}--resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
  });

  it('exports the active profile\'s unprefixed live data in the recovery state', async () => {
    // Incomplete-adoption recovery: mapping off, live data at unprefixed keys.
    // A per-profile export of the recovering (active) profile must still capture
    // it, not produce an empty file.
    localStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'prec', name: 'Ash', emoji: '🙂', createdAt: 'x' }]));
    localStorage.setItem(ACTIVE_PROFILE_KEY, 'prec');
    localStorage.setItem('resume-designer-data', '{"variants":{"LIVE":{}}}');
    localStorage.setItem('resume-designer-theme', 'dark'); // shared — must NOT leak into a profile export

    const readDownload = captureDownload();
    await exportProfileBackup('prec');
    const envelope = await readDownload();
    expect(envelope.keys['resume-designer-data']).toBe('{"variants":{"LIVE":{}}}');
    expect(envelope.keys['resume-designer-theme']).toBeUndefined();
  });

  it('rolls back a failed profile import so no partial workspace remains', async () => {
    await seedTwoProfiles();
    const before = loadRegistry().length;
    const realSetItem = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function setItemMock(key, value) {
      // Simulate quota hitting a bulky history key mid-import.
      if (String(key).includes('resume-designer-history-')) throw new DOMException('quota', 'QuotaExceededError');
      return realSetItem.call(this, key, value);
    });
    try {
      await expect(importProfileBackup({
        backupFormat: 2, kind: 'profile', name: 'Imported', emoji: '🐢',
        keys: { 'resume-designer-data': '{"variants":{}}', 'resume-designer-history-v1': 'big' },
      })).rejects.toThrow(/quota/i);
      // Registry entry rolled back…
      expect(loadRegistry()).toHaveLength(before);
      // …and the partially-written data key was cleaned up — only the two
      // seeded profiles' data keys remain, none from the failed import.
      const physicalDataKeys = Object.keys(localStorage).filter((k) => /^resume-p--.+--resume-designer-data$/.test(k));
      expect(physicalDataKeys).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects non-profile envelopes and unowned keys', async () => {
    await seedTwoProfiles();
    await expect(importProfileBackup({ backupFormat: 1, keys: {} })).rejects.toThrow();
    await expect(importProfileBackup({
      backupFormat: 2, kind: 'profile', name: 'X', keys: { evil: 'x' },
    })).rejects.toThrow(/unrecognized/i);
  });

  it('rolls back a profile import whose disk writes are not durable (cached mode)', async () => {
    // Cached/Tauri store: setItem doesn't throw on disk-full — the failure only
    // surfaces at flush(). Import must flush and roll back rather than report
    // success on a write that never reached disk.
    const backend = makeBackend({
      'resume-designer-profiles': JSON.stringify([{ id: 'pkeep', name: 'Ash', emoji: '🙂', createdAt: 'x' }]),
      'resume-designer-active-profile': 'pkeep',
    });
    backend.write.mockImplementation(async (key, value) => {
      if (key.startsWith('resume-p--')) throw new Error('disk full'); // imported profile's keys
      backend.files.set(key, value);
    });
    await initAppStorage({ backend });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(importProfileBackup({
        backupFormat: 2, kind: 'profile', name: 'Imported', emoji: '🐢',
        keys: { 'resume-designer-data': '{"variants":{}}' },
      })).rejects.toThrow(/disk/i);
      // Rolled back: only the original profile remains, no imported keys on disk.
      expect(loadRegistry()).toHaveLength(1);
      expect([...backend.files.keys()].some((k) => k.startsWith('resume-p--'))).toBe(false);
    } finally {
      errSpy.mockRestore();
    }
  });
});

// Regression (PR #89 finding 28): a corrupt format-2 backup with `profiles`
// entries not listed in the registry passed validation (which iterates
// registry ids only) — the clean-slate restore then silently dropped those
// workspaces. Orphans are now rejected before anything is removed.
describe('format-2 orphan profiles entries', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
  });

  it('rejects a profiles entry missing from the registry before wiping', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');
    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 'Profile' }],
      activeProfile: 'p',
      shared: {},
      profiles: {
        p: { keys: {} },
        ghost: { keys: { 'resume-designer-data': '{"lost":true}' } },
      },
    })).toThrow(/not in the registry/i);
    expect(localStorage.getItem('resume-designer-theme')).toBe('keep-me');
  });
});

// Regression (PR #89 finding 30): the profile switch reloaded even when the
// active-pointer write never became durable (disk full / permissions) — the
// next boot read the stale pointer and the switch appeared to undo itself,
// while the pending in-cache pointer could ride a LATER flush and switch a
// future boot unexpectedly. activateProfileDurably restores the pointer and
// reports false so callers keep the session open instead of reloading.
describe('activateProfileDurably', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
  });

  it('restores the pointer and returns false when the flush is not durable', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]));
    appStorage.setItem(ACTIVE_PROFILE_KEY, 'a');
    await appStorage.flush();

    backend.write.mockImplementation(async () => { throw new Error('disk full'); });
    await expect(activateProfileDurably('b', 'a')).resolves.toBe(false);
    expect(appStorage.getItem(ACTIVE_PROFILE_KEY)).toBe('a'); // cache restored

    // Disk recovers: the next flush persists the RESTORED pointer, not 'b'.
    backend.write.mockImplementation(async (key, value) => { backend.files.set(key, value); });
    await appStorage.flush();
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('a');

    // And the success path reports true with the pointer durably switched.
    await expect(activateProfileDurably('b', 'a')).resolves.toBe(true);
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('b');
  });
});

// Regression (PR #89 finding 32): the one-time blob→shared API-key extraction
// stripped the blob copy before the shared-key write was durable. If the
// shared write failed at flush time while the smaller blob rewrite succeeded,
// the only durable copy of the credential vanished on the next restart.
describe('extractSharedApiKey durability', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
  });

  it('keeps the blob credential when the shared write is not durable', async () => {
    const backend = makeBackend({
      'resume-designer-data': JSON.stringify({ settings: { openrouterKey: 'sk-blob' } }),
    });
    await initAppStorage({ backend });

    backend.write.mockImplementation(async () => { throw new Error('disk full'); });
    await extractSharedApiKey();
    // The blob still carries the key — nothing was stripped.
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBe('sk-blob');

    // Simulate a restart after the disk recovers: the retry extracts and strips.
    backend.write.mockImplementation(async (key, value) => { backend.files.set(key, value); });
    __resetAppStorageForTests();
    await initAppStorage({ backend });
    await extractSharedApiKey();
    expect(appStorage.getItem(OPENROUTER_KEY_KEY)).toBe('sk-blob');
    expect(JSON.parse(appStorage.getItem('resume-designer-data')).settings.openrouterKey).toBeUndefined();
    await appStorage.flush();
    expect(backend.files.get(OPENROUTER_KEY_KEY)).toBe('sk-blob');
  });
});

// Regression (PR #89 finding 33): deleteProfile only mutates the write-behind
// cache; a fire-and-forget delete reported success and the profile came back
// (or its files stayed orphaned) after a restart when the flush failed.
describe('deleteProfileDurably', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
  });

  it('restores the profile and returns false when the delete flush fails', async () => {
    const backend = makeBackend();
    await initAppStorage({ backend });
    appStorage.setItem(PROFILES_KEY, JSON.stringify([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]));
    appStorage.setItem(ACTIVE_PROFILE_KEY, 'a');
    appStorage.setItem('resume-p--b--resume-designer-data', '{"b":1}');
    await appStorage.flush();

    backend.write.mockImplementation(async () => { throw new Error('disk full'); });
    backend.delete.mockImplementation(async () => { throw new Error('disk full'); });
    await expect(deleteProfileDurably('b')).resolves.toBe(false);
    expect((loadRegistry() || []).map((p) => p.id)).toContain('b');
    expect(appStorage.getItem('resume-p--b--resume-designer-data')).toBe('{"b":1}');

    backend.write.mockImplementation(async (key, value) => { backend.files.set(key, value); });
    backend.delete.mockImplementation(async (key) => { backend.files.delete(key); });
    await expect(deleteProfileDurably('b')).resolves.toBe(true);
    expect(backend.files.has('resume-p--b--resume-designer-data')).toBe(false);
    expect(JSON.parse(backend.files.get(PROFILES_KEY)).map((p) => p.id)).toEqual(['a']);
  });
});

// Regression (PR #89 finding 34): exportFullBackup exported orphan namespaces
// (physical keys whose id is absent from the registry — e.g. after a partial
// cached-mode deletion) without a registry entry, producing a backup that
// importFullBackupV2's own orphan rejection refuses to restore.
describe('exportFullBackup orphan reconciliation', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
  });

  it('synthesizes a registry entry so the backup round-trips', async () => {
    await seedTwoProfiles();
    appStorage.setItem('resume-p--orphan1--resume-designer-data', '{"variants":{"vo":{}}}');

    const readDownload = captureDownload();
    exportFullBackup();
    const envelope = await readDownload();

    const orphanEntry = envelope.registry.find((p) => p.id === 'orphan1');
    expect(orphanEntry).toBeTruthy();
    expect(orphanEntry.name).toMatch(/recovered/i);

    localStorage.clear();
    __resetAppStorageForTests();
    const result = importFullBackupFromEnvelope(envelope); // must not throw on the orphan
    expect(result.keysImported).toBeGreaterThan(0);
    expect(localStorage.getItem('resume-p--orphan1--resume-designer-data')).toBe('{"variants":{"vo":{}}}');
  });
});
