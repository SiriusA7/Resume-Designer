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
  parkLoser,
} from '../src/sync/syncModel.js';
import { store } from '../src/store.js';
import {
  initPersistence, setPersistedSaveHandler,
} from '../src/persistence.js';
import { registerPersistedSaveHandler } from '../src/sync/syncModel.js';
import { BACKUP_FIXED_KEYS, BACKUP_HISTORY_PREFIX } from '../src/profileKeys.js';
import { SYNCED_SHARED_KEYS, classifyKey } from '../src/sync/syncKeys.js';

const DATA = 'resume-designer-data';
const STATE = 'resume-designer-sync-state';

/**
 * Every synced key the app writes as a whole key — DERIVED, not copied.
 *
 * The interceptor covers `classifyKey`'s list by construction, so a key added
 * to the app later is stamped whether or not anyone remembers to cover it. A
 * hand-copied list here would NOT follow, and the new key would ship with
 * interceptor coverage and no test coverage — the drift this whole design was
 * put at a choke point to avoid. Both inventories are read, because
 * `SYNCED_SHARED_KEYS` members are not reached by the `BACKUP_FIXED_KEYS`
 * check inside classifyKey.
 *
 * Two exclusions, both of them the interceptor's own documented carve-outs
 * rather than conveniences: the data blob, which has no `key:` unit at all and
 * travels as its `resume:`/`data:` units, and the per-variant history keys,
 * which the persistence path stamps and which are a PREFIX rather than a
 * member of either list, so they are absent here anyway.
 */
const SYNCED_KEYS = [...new Set([...BACKUP_FIXED_KEYS, ...SYNCED_SHARED_KEYS])]
  .filter((key) => classifyKey(key) === 'synced' && key !== DATA);

// The key whose disk write should be refused, or null. Set by `failWritesFor`.
// A real refusal is retried once inside the drain and only then reported, so
// this rejects every attempt for that key rather than the first.
let refusedKey = null;
const failWritesFor = (key) => { refusedKey = key; };
// A write that hangs until released, so a SECOND drain can queue work for the
// same key while the first is still in flight.
let heldKey = null;
let heldGate = null;
const holdWritesFor = (key) => {
  heldKey = key;
  let release;
  heldGate = new Promise((resolve) => { release = resolve; });
  return () => { heldKey = null; release(); };
};

function makeBackend(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => {
      if (key === heldKey) await heldGate;
      if (key === refusedKey) throw new Error('no space left on device');
      files.set(key, value);
    }),
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
  refusedKey = null;
  heldKey = null;
  heldGate = null;
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
// The notifier carries `{ id, profileId }` per unit — the profile is what lets
// a parked conflict loser be sent into a workspace this device is not in. These
// assertions are about WHICH units were named, so they read the ids out.
const namedIn = (call) => call[0].map((u) => u.id);
const allNamed = () => notify.mock.calls.flatMap(namedIn);

describe('a write to a synced key stamps its unit and notifies', () => {
  it('stamps a plain synced key', async () => {
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    await settle();

    expect(stampedIds()).toEqual(['key:resume-designer-applications']);
    expect(notify).toHaveBeenCalledWith([{ id: 'key:resume-designer-applications', profileId: '' }]);
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

  it('stamps EVERY synced key, derived from the sync policy rather than listed here', async () => {
    // A vacuous pass is the one way this test could stop meaning anything, so
    // the derivation is checked before it is used: an empty or collapsed list
    // would make the loop below assert nothing at all.
    expect(SYNCED_KEYS.length).toBeGreaterThan(10);
    expect(SYNCED_KEYS).toContain('resume-designer-applications');
    expect(SYNCED_KEYS).toContain('resume-designer-profiles');
    expect(SYNCED_KEYS).not.toContain('resume-zoom');

    for (const key of SYNCED_KEYS) appStorage.setItem(key, '"x"');
    await settle();

    expect(stampedIds()).toEqual(SYNCED_KEYS.map((k) => `key:${k}`).sort());
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
    // NOTE: this passes on 'unknown', not on the device-local rule it looks
    // like it tests. `resume-designer-openrouter-key` is not in
    // BACKUP_FIXED_KEYS, so classifyKey answers 'unknown' for it even with no
    // DEVICE_LOCAL_KEYS entry — and the interceptor stamps only 'synced'. It is
    // still worth asserting (a credential must never be stamped or named,
    // whatever the route), but it does NOT pin the key's presence in
    // DEVICE_LOCAL_KEYS. syncKeys.test.js is what pins that.
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
    expect(notify).toHaveBeenCalledWith([{ id: 'data:settings', profileId: '' }]);
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
    const { applied } = await applyUnits([
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

    // A REJECTION now, not a throw: applyUnits waits for the disk before it
    // answers, so it is async and a throw from the synchronous landing inside it
    // surfaces as one. The suppression flag is restored in a `finally` that runs
    // before any await, which is what the assertion below is really about.
    await expect(applyUnits([{
      id: 'resume:v-1',
      kind: 'resume',
      payload: JSON.stringify({ id: 'v-1', name: 'Mine', data: { name: 'Grace' } }),
      modifiedAt: '2099-01-01T00:00:00.000Z',
    }])).rejects.toThrow(boom);

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
    expect(notify).toHaveBeenCalledWith([{ id: 'key:resume-designer-applications', profileId: '' }]);
  });

  it('carries every distinct unit touched in the window', async () => {
    appStorage.setItem('resume-designer-applications', '[]');
    appStorage.setItem('resume-designer-job-descriptions', '[]');
    appStorage.setItem('resume-zoom', '2'); // device-local: must not appear
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(namedIn(notify.mock.calls[0]).sort()).toEqual([
      'key:resume-designer-applications',
      'key:resume-designer-job-descriptions',
    ]);
  });

  it('does not notify at all when nothing synced was written', async () => {
    appStorage.setItem('resume-zoom', '2');
    await settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it('keeps a batch the notifier threw on instead of dropping those uploads', async () => {
    // The ids were cleared BEFORE the notifier ran, and the wrapper around it
    // only logs — so a notifier that threw took a whole window's uploads with
    // it, and nothing would name those units again until they were edited
    // again. Today's notifier is guarded and effectively cannot throw; this is
    // the ordering that makes that irrelevant.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    setStorageDirtyNotifier(() => { throw new Error('the bridge went away'); });
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    await settle();

    setStorageDirtyNotifier(notify);
    appStorage.setItem('resume-designer-job-descriptions', '[]');
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(namedIn(notify.mock.calls[0]).sort()).toEqual([
      'key:resume-designer-applications',
      'key:resume-designer-job-descriptions',
    ]);
    logged.mockRestore();
  });

  it('keeps an id queued DURING the notification instead of clearing it with the batch', async () => {
    // The notifier reaches the native shell, so anything it drives that writes a
    // synced key queues an id THIS drain never announced. A blanket clear()
    // dropped exactly those, and a dropped id is not named again until that unit
    // is edited again.
    setStorageDirtyNotifier(() => {
      // Swapped back first: the write below must not re-enter this notifier.
      setStorageDirtyNotifier(notify);
      appStorage.setItem('resume-designer-job-descriptions', '[{"id":"jd-1"}]');
    });
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    await settle();

    // The window the re-entrant write opened.
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(namedIn(notify.mock.calls[0])).toEqual(['key:resume-designer-job-descriptions']);
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

    expect(namedIn(notify.mock.calls[0]).sort()).toEqual([
      'key:resume-designer-applications',
      'key:resume-designer-job-descriptions',
    ]);
  });
});

describe('the résumé save path still stamps exactly what it did', () => {
  beforeEach(() => {
    registerPersistedSaveHandler(setPersistedSaveHandler);
    // ONE installer now. Persistence had its own, and used it to announce the
    // résumé the instant the write-behind cache accepted the value.
    setStorageDirtyNotifier(notify);
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

  it('names each dirty unit exactly once', async () => {
    store.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');
    store.saveNow();
    await settle();

    const named = allNamed();
    expect([...new Set(named)]).toEqual(named);
  });

  it('announces NOTHING until the write has reached disk', async () => {
    // The P1 this replaced an assertion for. `saveVariant` answers true as soon
    // as the write-behind cache takes the value; persistence announced on that
    // answer, so the transport was told to upload bytes that might never land.
    // CloudKit then keeps a change tag for content this device does not have —
    // the next launch reads the older file the failed write never replaced, and
    // the edit after that overwrites the server with no conflict to stop it.
    store.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');

    expect(store.saveNow()).toBe(true);
    // The save has been reported as successful, and the transport has still not
    // been told anything. This is the whole assertion.
    expect(notify).not.toHaveBeenCalled();

    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(namedIn(notify.mock.calls[0]).sort()).toEqual([
      `key:${BACKUP_HISTORY_PREFIX}v-1`,
      'resume:v-1',
    ]);
  });
});

describe('the durability barrier', () => {
  beforeEach(() => {
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setStorageDirtyNotifier(notify);
  });

  it('holds back a unit whose key the disk refused', async () => {
    // The transport uploads on being told. A unit announced while its bytes sat
    // in a queue that then failed leaves CloudKit holding a change tag for
    // content this device does not have — the next launch reads the older file,
    // and the edit after that overwrites the server with no conflict to stop
    // it. Refusals are per KEY so one full-disk key cannot silence the rest.
    failWritesFor('resume-designer-applications');
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    appStorage.setItem('resume-designer-job-descriptions', '[]');
    await settle();

    expect(allNamed()).toEqual(['key:resume-designer-job-descriptions']);

    // Still owed. It rides the next drain that manages to write it.
    failWritesFor(null);
    appStorage.setItem('resume-designer-applications', '[{"id":"a-2"}]');
    await settle();

    expect(allNamed()).toContain('key:resume-designer-applications');
  });
});

describe('the failure is reported under the key its gate was built from', () => {
  beforeEach(() => {
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setStorageDirtyNotifier(notify);
  });

  it('survives a second drain queuing the same key before the first settles', async () => {
    // A PROFILE MAPPING is essential to this test, not decoration. The rest of
    // this file runs with identity mapping, where physical === logical — and
    // under identity the bug is invisible, because falling back to the physical
    // key yields the same string the gate holds. It only bites once the two
    // differ, which is every real device with a workspace open.
    setProfileMapping('p1');
    // The metadata saying which name a physical write went in under used to be
    // shared across batches, and the first batch's cleanup deleted the entry a
    // LATER batch was relying on. The later failure was then reported under a
    // name no gate matched, and the unit was announced while its bytes were
    // only ever in memory. Captured per batch entry now, so overlap cannot
    // confuse them.
    const release = holdWritesFor('resume-p--p1--resume-designer-applications');
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    const firstDrain = appStorage.flush(); // batch 1 queued; its write hangs

    // Batch 2 is queued BEHIND batch 1's hanging write — that is the overlap.
    // Draining here rather than after the release is the whole point: a second
    // flush while the first is in flight is what put two batches on the chain
    // at once, and the first batch's cleanup ran between them.
    appStorage.setItem('resume-designer-applications', '[{"id":"a-2"}]');
    // The BACKEND sees the physical, namespaced key — refusing the logical name
    // would refuse nothing and the write would quietly succeed.
    failWritesFor('resume-p--p1--resume-designer-applications');
    const secondDrain = appStorage.flush();

    release();
    await Promise.all([firstDrain, secondDrain]);
    await settle();

    expect(allNamed()).not.toContain('key:resume-designer-applications');
  });
});

describe('a conflict parked into a workspace this device is not in', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  // The payload is a VARIANT RECORD, not a bare document — `resumeDocument`
  // reads `.data` off it and parkLoser refuses anything else. Shape taken from
  // syncModel.test.js's own helper rather than invented here.
  const park = (profileId = 'p2') => parkLoser('resume:v-9', JSON.stringify({
    id: 'v-9', name: 'Tailored for Acme', data: { name: 'the losing copy' },
    createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
  }), profileId);

  it('names the parked history, carrying the workspace it went into', async () => {
    // Stamping alone left the recovery copy on this device: the conflict queues
    // at most the résumé record, so with no later edit the parked loser — the
    // thing that makes newer-wins non-destructive — never reached CloudKit.
    expect(park()).toBe(true);
    await settle();

    expect(notify).toHaveBeenCalledWith([
      { id: 'key:resume-designer-history-v-9', profileId: 'p2' },
    ]);
  });

  it('holds it back when that workspace\u2019s disk write is refused', async () => {
    // The gate has to be the string parkLoser actually wrote through, which for
    // a foreign workspace is the PHYSICAL, namespaced name — appStorage reports
    // a refusal under the name its caller used. Gated on the logical history
    // key instead, the failure would never match and the parked history would
    // be announced while it existed only in memory.
    failWritesFor('resume-p--p2--resume-designer-history-v-9');
    expect(park()).toBe(true);
    await settle();

    expect(notify).not.toHaveBeenCalled();
  });

  it('routes a park into the OPEN workspace under the canonical empty id', async () => {
    // The open workspace answers to two spellings. A conflict arriving in its
    // own zone carries its REAL id — the transport maps only the SHARED zone to
    // '' — while every local write of the same record queues under ''. Both are
    // the same zone, so left as they come one record holds two routes and is
    // announced, and sent, twice. A route is only an identity if it is one.
    setProfileMapping('p1');
    expect(park('p1')).toBe(true);
    await settle();

    expect(notify).toHaveBeenCalledWith([
      { id: 'key:resume-designer-history-v-9', profileId: '' },
    ]);
  });

  it('names both when one batch parks the same variant in two workspaces', async () => {
    // The same variant id is in two workspaces as soon as one backup was
    // imported into both, and a fetch brings both zones' conflicts down in one
    // batch. Both parks produce the SAME unit id, so queued under that id alone
    // the second REPLACED the first: the drain named one of the two recovery
    // copies and the other stayed on this device until that workspace happened
    // to be edited again — which, for a workspace this device is not in, may be
    // never. The recovery copy is the whole reason newer-wins destroys nothing.
    expect(park('p2')).toBe(true);
    expect(park('p3')).toBe(true);
    await settle();

    expect(notify).toHaveBeenCalledWith([
      { id: 'key:resume-designer-history-v-9', profileId: 'p2' },
      { id: 'key:resume-designer-history-v-9', profileId: 'p3' },
    ]);
  });

  it('holds the refused workspace back and names it on a later drain', async () => {
    // Per-route gating, not per-unit: these two parks share a unit id and
    // differ only by workspace, so a refusal reaching across them would either
    // silence the workspace that wrote fine or announce the one that did not.
    failWritesFor('resume-p--p2--resume-designer-history-v-9');
    expect(park('p2')).toBe(true);
    expect(park('p3')).toBe(true);
    await settle();

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenLastCalledWith([
      { id: 'key:resume-designer-history-v-9', profileId: 'p3' },
    ]);

    // THE HALF THAT MATTERS, and the half a "only p3 was named" assertion
    // cannot see on its own: the refused park is HELD, not lost. Keyed by unit
    // id alone, p3's entry had simply overwritten p2's, and a map that no
    // longer holds p2 produces exactly the same first drain as one that is
    // holding it back on purpose. Only the drain AFTER the refusal clears tells
    // the two apart.
    failWritesFor(null);
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    await settle();

    expect(notify).toHaveBeenLastCalledWith([
      { id: 'key:resume-designer-history-v-9', profileId: 'p2' },
      { id: 'key:resume-designer-applications', profileId: '' },
    ]);
  });
});
