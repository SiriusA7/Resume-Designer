import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appStorage, initAppStorage, __resetAppStorageForTests } from '../src/appStorage.js';
import { store } from '../src/store.js';
import * as profiles from '../src/profiles.js';
import { ACTIVE_PROFILE_KEY, PROFILES_KEY } from '../src/profileKeys.js';

function makeBackend() {
  const files = new Map();
  return {
    files,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => { files.set(key, value); }),
    delete: vi.fn(async (key) => { files.delete(key); }),
    clear: vi.fn(async () => { files.clear(); }),
  };
}

async function seedProfiles(backend) {
  await initAppStorage({ backend });
  appStorage.setItem(PROFILES_KEY, JSON.stringify([
    { id: 'pa', name: 'Ada' },
    { id: 'pb', name: 'Bo' },
  ]));
  appStorage.setItem(ACTIVE_PROFILE_KEY, 'pa');
  await appStorage.flush();
}

function switchToProfileDurably() {
  expect(profiles.switchToProfileDurably).toEqual(expect.any(Function));
  return profiles.switchToProfileDurably;
}

describe('switchToProfileDurably', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetAppStorageForTests();
    store.setData({ name: 'Ada', sections: [] }, true, null);
  });

  afterEach(() => {
    store.onSave(() => true);
  });

  it('does not write the profile pointer when an active editor cannot save', async () => {
    const backend = makeBackend();
    await seedProfiles(backend);
    store.onSave(() => false);
    const flushProfile = vi.fn((event) => {
      appStorage.setItem('profile-editor-proof', 'saved');
      event.detail.ok = true;
    });
    window.addEventListener('rd:profile-flush', flushProfile);

    try {
      await expect(switchToProfileDurably()('pb')).resolves.toBe(false);
    } finally {
      window.removeEventListener('rd:profile-flush', flushProfile);
    }

    // The original path flushes every editor even if one reports failure; it
    // saves everything it still can before refusing the pointer write.
    expect(flushProfile).toHaveBeenCalledOnce();
    expect(backend.files.get('profile-editor-proof')).toBe('saved');
    expect(appStorage.getItem(ACTIVE_PROFILE_KEY)).toBe('pa');
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('pa');
  });

  it('flushes both editors before durably writing the profile pointer', async () => {
    const backend = makeBackend();
    await seedProfiles(backend);
    const writes = [];
    backend.write.mockImplementation(async (key, value) => {
      writes.push(key);
      backend.files.set(key, value);
    });
    store.onSave(() => {
      appStorage.setItem('resume-editor-proof', 'saved');
      return true;
    });
    const flushProfile = (event) => {
      appStorage.setItem('profile-editor-proof', 'saved');
      event.detail.ok = true;
    };
    window.addEventListener('rd:profile-flush', flushProfile);

    try {
      await expect(switchToProfileDurably()('pb')).resolves.toBe(true);
    } finally {
      window.removeEventListener('rd:profile-flush', flushProfile);
    }

    expect(writes).toEqual([
      'resume-editor-proof',
      'profile-editor-proof',
      ACTIVE_PROFILE_KEY,
    ]);
    expect(backend.files.get(ACTIVE_PROFILE_KEY)).toBe('pb');
  });
});
