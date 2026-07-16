import { describe, it, expect, beforeEach, vi } from 'vitest';
import { appStorage, __resetAppStorageForTests } from '../src/appStorage.js';
import { createProfile, ensureProfilesInitialized, loadRegistry } from '../src/profiles.js';
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
    importFullBackupFromEnvelope(envelope);
    expect(loadRegistry()).toHaveLength(2);
    expect(localStorage.getItem(`resume-p:${partnerId}:resume-designer-data`)).toBe('{"variants":{"v2":{}}}');
    expect(localStorage.getItem('resume-designer-theme')).toBe('dark');
    expect(localStorage.getItem(ACTIVE_PROFILE_KEY)).toBe(ashId);
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
