import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appStorage, __resetAppStorageForTests } from '../src/appStorage.js';
import {
  createProfile, ensureProfilesInitialized, loadRegistry,
  exportProfileBackup, importProfileBackup,
} from '../src/profiles.js';
import { importFullBackupFromEnvelope, exportFullBackup } from '../src/persistence.js';
import { OPENROUTER_KEY_KEY, ACTIVE_PROFILE_KEY } from '../src/profileKeys.js';

beforeEach(() => {
  __resetAppStorageForTests();
  localStorage.clear();
});

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
  appStorage.setItem(`resume-p:${partner.id}:resume-designer-data`, '{"variants":{"v2":{}}}');
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
    expect(localStorage.getItem(`resume-p:${partnerId}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
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

  it('rejects a non-string registry name before touching existing storage', () => {
    localStorage.setItem('resume-designer-theme', 'keep-me');

    expect(() => importFullBackupFromEnvelope({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: 'p', name: 42 }],
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
      if (key === 'resume-p:b:resume-designer-data' && historyAttempted) {
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

    expect(localStorage.getItem('resume-p:b:resume-designer-data')).toBe('{"variants":{}}');
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
    expect(localStorage.getItem(`resume-p:${ashId}:resume-designer-data`)).toBe('{"variants":{"legacy":{}}}');
    // …partner untouched, registry intact…
    expect(localStorage.getItem(`resume-p:${partnerId}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
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

    const imported = importProfileBackup(envelope);
    expect(imported.id).not.toBe(partnerId);
    expect(loadRegistry()).toHaveLength(3);
    expect(localStorage.getItem(`resume-p:${imported.id}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
  });

  it('rejects non-profile envelopes and unowned keys', async () => {
    await seedTwoProfiles();
    expect(() => importProfileBackup({ backupFormat: 1, keys: {} })).toThrow();
    expect(() => importProfileBackup({
      backupFormat: 2, kind: 'profile', name: 'X', keys: { evil: 'x' },
    })).toThrow(/unrecognized/i);
  });
});
