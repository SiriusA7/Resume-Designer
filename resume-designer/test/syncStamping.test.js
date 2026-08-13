/**
 * The storage-write interceptor: every synced key stamps its unit when the app
 * writes it.
 *
 * These tests run the REAL appStorage against the REAL sync model — unlike
 * syncModel.test.js, which mocks the storage facade. That is the whole point:
 * the gap being closed here was that only ONE production write site
 * (registerPersistedSaveHandler, the résumé auto-save) ever reached touchUnit,
 * so every other synced unit was uploaded once by the first full sweep and
 * never again. A test against a mocked facade cannot see that.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
  setStorageWriteObserver,
} from '../src/appStorage.js';
import {
  installStorageStamping, setStorageDirtyNotifier, applyUnits, registerEditingProbe,
} from '../src/sync/syncModel.js';
import { store } from '../src/store.js';
import {
  initPersistence, setPersistedSaveHandler, setSyncDirtyNotifier,
} from '../src/persistence.js';
import { registerPersistedSaveHandler } from '../src/sync/syncModel.js';
import { BACKUP_HISTORY_PREFIX } from '../src/profileKeys.js';

const DATA = 'resume-designer-data';
const STATE = 'resume-designer-sync-state';

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

/** Everything the sync bookkeeping recorded, minus store.js's device id. */
function stamps() {
  const raw = appStorage.getItem(STATE);
  if (raw == null) return {};
  const { deviceId: _deviceId, ...units } = JSON.parse(raw);
  return units;
}

const stampedIds = () => Object.keys(stamps()).sort();

let notify;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
  // Identity mapping (no active profile) keeps physical == logical here; the
  // profile-namespacing asymmetry is syncModel.test.js's subject, not this
  // file's.
  await initAppStorage({
    backend: makeBackend({
      [DATA]: JSON.stringify({
        variants: { 'v-1': { name: 'Design Engineer', data: { name: 'Ada' } } },
        currentVariantId: 'v-1',
        settings: { pageSize: 'letter' },
        userProfile: { contactInfo: { fullName: 'Ada' } },
      }),
      'resume-designer-applications': '[]',
    }),
  });
  notify = vi.fn();
  installStorageStamping(setStorageWriteObserver);
  setStorageDirtyNotifier(notify);
  registerEditingProbe(null);
});

afterEach(() => {
  // Leave no observer installed for the next file's module-level state.
  setStorageWriteObserver(null);
  setStorageDirtyNotifier(null);
});

/** Force the coalescing window closed the way a durability barrier does. */
const settle = () => appStorage.flush();

describe('a write to a synced key stamps its unit and notifies', () => {
  it('stamps a plain synced key', async () => {
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    await settle();

    expect(stampedIds()).toEqual(['key:resume-designer-applications']);
    expect(notify).toHaveBeenCalledWith(['key:resume-designer-applications']);
  });

  it('stamps the accumulating token-usage key', async () => {
    appStorage.setItem('resume-designer-token-usage', '{"total":1}');
    await settle();

    expect(stampedIds()).toEqual(['key:resume-designer-token-usage']);
  });

  it('stamps a SHARED key that nonetheless syncs', async () => {
    appStorage.setItem('resume-designer-profiles', '[{"id":"p1"}]');
    await settle();

    expect(stampedIds()).toEqual(['key:resume-designer-profiles']);
  });

  it('stamps every remaining synced key category the app writes', async () => {
    const keys = [
      'resume-designer-job-descriptions',
      'resume-designer-chat-threads',
      'resume-designer-chat-history',
      'resume-designer-learned-answers',
      'resume-designer-onboarding-complete',
      'resume-edit-hint-dismissed',
      'resume-header-style',
      'resume-accent-settings',
      'resume-font-settings',
      'resume-spacing-settings',
      'resume-photo-settings',
    ];
    for (const key of keys) appStorage.setItem(key, '"x"');
    await settle();

    expect(stampedIds()).toEqual(keys.map((k) => `key:${k}`).sort());
  });

  it('records a real ISO time, not a placeholder', async () => {
    appStorage.setItem('resume-designer-applications', '[]');
    await settle();
    const { modifiedAt } = stamps()['key:resume-designer-applications'];
    expect(new Date(modifiedAt).toISOString()).toBe(modifiedAt);
  });
});

describe('device-local keys are never stamped or sent', () => {
  it('stamps nothing for the API key', async () => {
    appStorage.setItem('resume-designer-openrouter-key', 'sk-secret');
    await settle();

    expect(stampedIds()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('stamps nothing for the zoom level', async () => {
    appStorage.setItem('resume-zoom', '1.75');
    await settle();

    expect(stampedIds()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('stamps nothing for its own bookkeeping key, so stamping cannot recurse', async () => {
    appStorage.setItem(STATE, '{}');
    await settle();

    expect(stampedIds()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('stamps nothing for a key with no sync decision', async () => {
    appStorage.setItem('resume-profile-adoption-pending', '1');
    await settle();

    expect(stampedIds()).toEqual([]);
  });

  it('stamps nothing for another profile\'s physical key', async () => {
    appStorage.setItem('resume-p--other--resume-designer-applications', '[]');
    await settle();

    expect(stampedIds()).toEqual([]);
  });
});

describe('the data blob is split, not double-handled', () => {
  it('stamps data:settings when the blob write changed settings', async () => {
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.settings = { pageSize: 'a4' };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual(['data:settings']);
    expect(notify).toHaveBeenCalledWith(['data:settings']);
  });

  it('stamps data:userProfile when the blob write changed the profile', async () => {
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.userProfile = { contactInfo: { fullName: 'Grace' } };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual(['data:userProfile']);
  });

  it('stamps both in ONE notification when both changed', async () => {
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.settings = { pageSize: 'a4' };
    blob.userProfile = { contactInfo: { fullName: 'Grace' } };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual(['data:settings', 'data:userProfile']);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('stamps NOTHING for a blob write that only touched a résumé', async () => {
    // The résumé units are the persistence path's to stamp — it knows the
    // variant id. Stamping data:settings here on every auto-save would give an
    // unchanged settings record a fresh time and let it beat a real edit made
    // on another device.
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.variants['v-1'].data.name = 'Ada Lovelace';
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('never stamps a key: unit for the blob, which has no such unit', async () => {
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.settings = { pageSize: 'a4' };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stamps()[`key:${DATA}`]).toBeUndefined();
  });

  it('does not stamp a history key, which the persistence path owns', async () => {
    appStorage.setItem(`${BACKUP_HISTORY_PREFIX}v-1`, '{"history":[],"historyIndex":0}');
    await settle();

    expect(stampedIds()).toEqual([]);
  });
});

describe('applying remote units must not echo', () => {
  it('stamps nothing at all for an apply', async () => {
    const { applied } = applyUnits([
      {
        id: 'resume:v-2',
        kind: 'resume',
        payload: JSON.stringify({ id: 'v-2', name: 'Theirs', data: { name: 'Grace' } }),
        modifiedAt: '2026-08-09T00:00:00.000Z',
      },
      { id: 'data:settings', kind: 'plain', payload: '{"pageSize":"a4"}', modifiedAt: '2026-08-09T00:00:00.000Z' },
      { id: 'key:resume-designer-applications', kind: 'plain', payload: '[{"id":"a-9"}]', modifiedAt: '2026-08-09T00:00:00.000Z' },
    ]);
    await settle();

    expect(applied).toBe(3);
    // The bytes landed...
    expect(appStorage.getItem('resume-designer-applications')).toBe('[{"id":"a-9"}]');
    // ...and nothing claims this device modified them.
    expect(stampedIds()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });

  it('leaves stamping ENABLED after an apply throws', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A payload the store chokes on: adoptDocument is reached only for the
    // OPEN variant, so drive the throw through it.
    const boom = new Error('boom');
    const spy = vi.spyOn(store, 'adoptDocument').mockImplementation(() => { throw boom; });
    store.setData({ name: 'Ada' }, true, 'v-1');

    expect(() => applyUnits([{
      id: 'resume:v-1',
      kind: 'resume',
      payload: JSON.stringify({ id: 'v-1', name: 'Mine', data: { name: 'Grace' } }),
      modifiedAt: '2099-01-01T00:00:00.000Z',
    }])).toThrow(boom);

    spy.mockRestore();
    error.mockRestore();

    // Suppression must not survive the throw.
    appStorage.setItem('resume-designer-applications', '[{"id":"after"}]');
    await settle();
    expect(stampedIds()).toContain('key:resume-designer-applications');
  });
});

describe('the notification is coalesced, not one per write', () => {
  it('collapses a burst of writes to one synced key into a single notify', async () => {
    for (let i = 0; i < 5; i++) {
      appStorage.setItem('resume-designer-applications', `[{"n":${i}}]`);
    }
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(['key:resume-designer-applications']);
  });

  it('carries every distinct unit touched in the window', async () => {
    appStorage.setItem('resume-designer-applications', '[]');
    appStorage.setItem('resume-designer-job-descriptions', '[]');
    appStorage.setItem('resume-zoom', '2'); // device-local: must not appear
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0].sort()).toEqual([
      'key:resume-designer-applications',
      'key:resume-designer-job-descriptions',
    ]);
  });

  it('does not notify at all when nothing synced was written', async () => {
    appStorage.setItem('resume-zoom', '2');
    await settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it('holds ids written before the shell installed a notifier', async () => {
    // The interceptor is live from module load; the shell wires the notifier
    // during init(). A boot-time migration writing in between must not have its
    // ids dropped on the floor.
    setStorageDirtyNotifier(null);
    appStorage.setItem('resume-designer-applications', '[{"id":"migrated"}]');
    await settle();

    setStorageDirtyNotifier(notify);
    appStorage.setItem('resume-designer-job-descriptions', '[]');
    await settle();

    expect(notify.mock.calls[0][0].sort()).toEqual([
      'key:resume-designer-applications',
      'key:resume-designer-job-descriptions',
    ]);
  });
});

describe('the résumé save path still stamps exactly what it did', () => {
  beforeEach(() => {
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setSyncDirtyNotifier(notify);
  });

  it('stamps the résumé and its history, and nothing else', async () => {
    store.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');

    expect(store.saveNow()).toBe(true);
    await settle();

    // No data:settings, no key:resume-designer-data, no duplicate history unit.
    expect(stampedIds()).toEqual([
      `key:${BACKUP_HISTORY_PREFIX}v-1`,
      'resume:v-1',
    ]);
  });

  it('names each dirty unit once across both notification paths', async () => {
    store.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');
    store.saveNow();
    await settle();

    const named = notify.mock.calls.flatMap(([ids]) => ids);
    expect([...new Set(named)]).toEqual(named);
  });
});
