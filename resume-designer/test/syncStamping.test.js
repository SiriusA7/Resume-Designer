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
  initPersistence, setPersistedSaveHandler, deleteVariant, getVariants, renameVariant,
  setRestoreStampHandler, importFullBackupDurably,
} from '../src/persistence.js';
import { stampRestoredWrites, announceRestoredUnits } from '../src/sync/syncModel.js';
import { registerPersistedSaveHandler } from '../src/sync/syncModel.js';
import { resetSpacingSettings } from '../src/spacingService.js';
import { resetAccentSettings } from '../src/accentService.js';
import { clearLegacyHistory } from '../src/chatThreads.js';
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
// Kept so a test can assert what reached DISK, not just what the cache holds —
// a deferred write is visible in neither.
let backend;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
  // Identity mapping (no active profile) keeps physical == logical here; the
  // profile-namespacing asymmetry is syncModel.test.js's subject, not this
  // file's.
  backend = makeBackend({
      [DATA]: JSON.stringify({
        variants: { 'v-1': { name: 'Design Engineer', data: { name: 'Ada' } } },
        currentVariantId: 'v-1',
        settings: { pageSize: 'letter' },
        userProfile: { contactInfo: { fullName: 'Ada' } },
      }),
      'resume-designer-applications': '[]',
  });
  await initAppStorage({ backend });
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

  it('stamps the résumé a blob write touched, and no data: field', async () => {
    // TWO guarantees, and the older version of this bought the second by giving
    // up the first. `data:settings` must NOT be stamped when only a résumé
    // changed — an unchanged settings record with a fresh time beats a real
    // settings edit made on another device, which is a silent loss. That still
    // holds, and it is the comparison that provides it.
    //
    // But the résumé itself MUST be stamped here, and used not to be: leaving
    // every `resume:` unit to the persistence handler covered only the editor's
    // auto-save, so a résumé created, duplicated, imported, renamed or analysed
    // — all direct blob writes — never reached CloudKit until some later
    // document edit happened to trigger one.
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.variants['v-1'].data.name = 'Ada Lovelace';
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual(['resume:v-1']);
    expect(allNamed()).toEqual(['resume:v-1']);
  });

  it('stamps a résumé added by a direct blob write, with no auto-save involved', async () => {
    // `createVariant` / duplicate / import, in the shape the storage layer sees
    // them: a blob write with a variant that was not there before, and no
    // persisted-save callback anywhere near it.
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.variants['v-2'] = { name: 'Tailored for Acme', data: { name: 'Ada' } };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    expect(stampedIds()).toEqual(['resume:v-2']);
    expect(allNamed()).toEqual(['resume:v-2']);
  });

  it('stamps nothing when only the OPEN résumé changed, which is a device fact', async () => {
    // `currentVariantId` is deliberately absent from the unit list, so merely
    // switching résumés must not name anything — otherwise every device would
    // fight over whose selection is newest.
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.currentVariantId = 'v-1';
    blob.variants['v-9'] = { name: 'Untouched', data: {} };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();
    notify.mockClear();

    const again = JSON.parse(appStorage.getItem(DATA));
    again.currentVariantId = 'v-9';
    appStorage.setItem(DATA, JSON.stringify(again));
    await settle();

    expect(allNamed()).toEqual([]);
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

  it('holds a résumé whose blob\u2019s LATEST bytes were refused, though its own landed', async () => {
    // The one gate the write-id gate does NOT subsume, and it needs its own case
    // because nothing else pins it: a `resume:` unit is queued only by the
    // persistence handler, so a later direct write to the data blob re-queues
    // the `data:` units but leaves this one gated on its ORIGINAL write — one
    // that landed. The write-id gate therefore passes it, and only the refusal
    // gate is left to notice that the blob's current bytes are the ones the
    // disk just refused. Announce it and the transport collects and uploads
    // exactly those bytes.
    setStorageDirtyNotifier(null); // held: nowhere to announce it yet
    store.setData({ name: 'Edited' }, true, 'v-1');
    initPersistence('v-1');
    expect(store.saveNow()).toBe(true);
    await settle(); // the blob lands; `resume:v-1` is held

    setStorageDirtyNotifier(notify);
    failWritesFor(DATA);
    appStorage.setItem(DATA, JSON.stringify({
      ...JSON.parse(appStorage.getItem(DATA)), currentVariantId: 'v-1',
    }));
    await settle();

    expect(allNamed()).not.toContain('resume:v-1');

    // Once the blob writes again, it goes up with everything else.
    failWritesFor(null);
    appStorage.setItem(DATA, appStorage.getItem(DATA));
    await settle();
    expect(allNamed()).toContain('resume:v-1');
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

describe('a unit is announced only once ITS OWN write reached disk', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  it('does not announce a unit queued while an earlier batch was in flight', async () => {
    // `pendingDirty` is global; a drain is per batch. So a synced write made
    // while an earlier batch is still awaiting its backend write lands in the
    // map immediately, and the earlier batch's settle used to announce the whole
    // map — including that unit, whose bytes were still only in the cache. The
    // transport uploads on being told, so CloudKit would take a change tag for
    // content this disk had never received: if that later write then failed, or
    // the app died first, the next launch would hold no tag for it and the edit
    // after that would overwrite the server with no conflict raised.
    const release = holdWritesFor('resume-designer-applications');
    appStorage.setItem('resume-designer-applications', '[{"id":"a-1"}]');
    const firstDrain = appStorage.flush(); // batch 1 queued; its write hangs

    // A DIFFERENT synced key, written while batch 1 is in flight, so its own
    // write is genuinely still pending rather than coalesced into batch 1.
    appStorage.setItem('resume-designer-job-descriptions', '[]');

    release();
    await firstDrain;

    // Batch 1's settle names what batch 1 wrote, and nothing else.
    expect(allNamed()).toContain('key:resume-designer-applications');
    expect(allNamed()).not.toContain('key:resume-designer-job-descriptions');

    // It is HELD, not dropped: the drain that actually writes it announces it.
    await settle();
    expect(allNamed()).toContain('key:resume-designer-job-descriptions');
  });
});

describe('a rolled-back restore still announces what ended up on disk', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  it('announces the unit after a deferred write is replayed over a rollback', async () => {
    // A FAILED restore releases the guard, rolls back by rewriting every key it
    // wiped, and only then replays the writes it deferred. The rollback's own
    // `setItem` queues that key's unit at a high id; if the replay is queued
    // under the deferral's older id it REPLACES that dirty entry, so the only
    // landing for the key comes in below the unit's gate and the unit is never
    // announced — held in memory until something else happens to write the key,
    // which for a unit named once may be never.
    appStorage.setItem('resume-designer-applications', '[{"id":"before"}]');
    await settle();
    notify.mockClear();

    const prior = appStorage.getItem('resume-designer-applications');
    appStorage.beginRestoreGuard(
      new Map([['resume-designer-applications', prior]]),
      ['resume-designer-applications'],
    );
    // Somebody else's in-flight work during the window — deferred, not written.
    appStorage.setItem('resume-designer-applications', '[{"id":"during"}]');

    // The restore fails: release, roll back, then replay. Mirrors
    // `rollbackWipedImport` + `importFullBackupDurably`'s failure path.
    appStorage.endRestoreGuard();
    appStorage.removeItem('resume-designer-applications');
    appStorage.setItem('resume-designer-applications', prior);
    appStorage.flushDeferredWrites();
    await settle();

    // The deferred value is what ended up on disk, so it is exactly what should
    // go up — and it must be named to the transport for that to happen.
    expect(appStorage.getItem('resume-designer-applications')).toBe('[{"id":"during"}]');
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

describe('clearing a synced key travels, because deletion does not', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  // `appStorage.removeItem` is deliberately unobserved: it neither stamps nor
  // announces, and there is no tombstone in this protocol. So a reset that
  // REMOVED its key left the server holding the old customisation — every other
  // device kept showing it, and the next edit on any of them could send it back
  // and undo the reset. Each of these writes the value the reset means instead,
  // which is a change the interceptor can see. Asserted at the SYNC layer, not
  // at storage: that a value landed on disk was never the thing in doubt.

  it('names the spacing unit when spacing is reset to defaults', async () => {
    const defaults = resetSpacingSettings();
    await settle();

    expect(allNamed()).toContain('key:resume-spacing-settings');
    // And the bytes say "default" rather than being absent — a receiving device
    // applies what arrives, so an announcement with nothing behind it is worse
    // than silence.
    expect(JSON.parse(appStorage.getItem('resume-spacing-settings'))).toEqual(defaults);
  });

  it('names the accent unit when accents are reset to defaults', async () => {
    const defaults = resetAccentSettings();
    await settle();

    expect(allNamed()).toContain('key:resume-accent-settings');
    expect(JSON.parse(appStorage.getItem('resume-accent-settings'))).toEqual(defaults);
  });

  it('names the legacy chat key when /clear empties it', async () => {
    // Nothing reads this again on THIS device — the migration in chatThreads
    // runs only when there are no threads at all — so the damage is on the
    // device that joins the workspace LATER: it starts with no threads, reads
    // the key that was never cleared for it, and resurrects a conversation the
    // person explicitly deleted.
    clearLegacyHistory();
    await settle();

    expect(allNamed()).toContain('key:resume-designer-chat-history');
    expect(JSON.parse(appStorage.getItem('resume-designer-chat-history'))).toEqual([]);
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

describe('a wipe-and-rewrite stamps only what actually changed', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  it('stamps nothing when a rollback puts the same bytes back', async () => {
    // BOTH backup-restore paths wipe a key and rewrite it, and a FAILED restore
    // rolls back by wiping and putting the prior values straight back. The
    // observer compares against what was there before — and a remove leaves
    // nothing there, so every unit in the key read as changed.
    //
    // The cost of that is not noise. Every résumé would be stamped with a fresh
    // time and named to the transport, and newer-wins would then upload this
    // device's untouched copies over another device's real edits: a restore
    // that visibly did nothing, reverting work on a machine that was not even
    // involved.
    const before = appStorage.getItem(DATA);
    notify.mockClear();

    appStorage.removeItem(DATA);
    appStorage.setItem(DATA, before);
    await settle();

    expect(allNamed()).toEqual([]);
  });

  it('still stamps what a wipe-and-rewrite really did change', async () => {
    const before = JSON.parse(appStorage.getItem(DATA));
    before.settings = { pageSize: 'a4' };

    appStorage.removeItem(DATA);
    appStorage.setItem(DATA, JSON.stringify(before));
    await settle();

    expect(allNamed()).toEqual(['data:settings']);
  });
});

describe('a write deferred by a restore is named when it finally lands', () => {
  beforeEach(() => { setStorageDirtyNotifier(notify); });

  it('stamps and announces the replayed value, not just the rollback', async () => {
    // The guard DEFERS other writers while a restore runs, and a failed restore
    // rolls back and then replays them. That replayed value is the person's own
    // work — a chat reply, a token record, a design edit — landing for the first
    // time. Installed straight into the cache it reached disk with no stamp and
    // no queued unit, so it could never go up, and a later fetch of the older
    // remote copy would beat it.
    //
    // It hid behind a bug: the rollback's own remove-and-rewrite used to stamp
    // everything in the key, so the unit was named even though the value was
    // wrong. Fixing that over-stamp is what exposed this.
    // THE BLOB, not a plain key. A plain synced key stamps on every write with
    // no comparison, so the rollback alone would name it and the test would pass
    // whether the replay was observed or not — measuring the wrong write. Only
    // the blob's per-field comparison makes the rollback silent, leaving the
    // replay as the one thing that can name anything.
    const prior = appStorage.getItem(DATA);
    const during = JSON.parse(prior);
    during.settings = { pageSize: 'a4' };

    appStorage.beginRestoreGuard(new Map([[DATA, prior]]), [DATA]);
    appStorage.setItem(DATA, JSON.stringify(during)); // deferred, not written
    notify.mockClear();

    appStorage.endRestoreGuard();
    appStorage.removeItem(DATA);
    appStorage.setItem(DATA, prior);   // the rollback — identical bytes
    appStorage.flushDeferredWrites();  // the replay — the person's own work
    await settle();

    expect(JSON.parse(appStorage.getItem(DATA)).settings).toEqual({ pageSize: 'a4' });
    expect(allNamed()).toEqual(['data:settings']);
    expect(stampedIds()).toContain('data:settings');
  });
});

describe('deleting a résumé produces something that can travel', () => {
  beforeEach(() => {
    registerPersistedSaveHandler(setPersistedSaveHandler);
    setStorageDirtyNotifier(notify);
  });

  it('leaves a tombstone the sync layer can name, not an absence', async () => {
    // Absence emits nothing, and the transport reads a missing unit as "nothing
    // to say" rather than "delete this" — deliberately, so a half-synced device
    // cannot wipe another's work. So a delete that REMOVED the entry reached
    // nobody: the résumé stayed everywhere else and came back on a refetch.
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.variants['v-2'] = { id: 'v-2', name: 'Tailored for Acme', data: { name: 'Ada' } };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();
    notify.mockClear();

    expect(deleteVariant('v-2')).toBe('v-1');
    await settle();

    // The record is still there, marked — and it is named to the transport, so
    // the delete actually goes up.
    const after = JSON.parse(appStorage.getItem(DATA));
    expect(after.variants['v-2'].deletedAt).toEqual(expect.any(String));
    expect(after.variants['v-2'].data).toBeUndefined();
    expect(allNamed()).toContain('resume:v-2');
  });

  it('hides it from every reader, so nothing renders or re-saves it', async () => {
    const blob = JSON.parse(appStorage.getItem(DATA));
    blob.variants['v-3'] = { id: 'v-3', name: 'Gone', data: { name: 'Ada' } };
    appStorage.setItem(DATA, JSON.stringify(blob));
    await settle();

    deleteVariant('v-3');

    expect(Object.keys(getVariants())).not.toContain('v-3');
    // And a rename cannot bring it back: writing over a tombstone is how a
    // deleted résumé resurrects itself locally and then wins on the wire.
    renameVariant('v-3', 'Back from the dead');
    const after = JSON.parse(appStorage.getItem(DATA));
    expect(after.variants['v-3'].name).toBe('Gone');
    expect(after.variants['v-3'].deletedAt).toEqual(expect.any(String));
  });

  describe('a restore\u2019s tombstones, through the REAL stamp and announce', () => {
    // The seam test in importBackup.test.js installs a capturing fake, so it can
    // see that the handlers are CALLED and nothing about whether calling them
    // achieves anything. Both ways this was inert are invisible from there: a
    // stamp swallowed by the restore guard, and an announcement gated on a key
    // the bytes were never written under. So these run the real pair, against
    // real appStorage, with the profile mapping ON — which is the only
    // configuration where the logical and physical names differ at all — and
    // where one cache slot answers to two names, which is its own trap: the
    // fixture's unprefixed blob and this workspace's physical key ARE the same
    // entry, and a wipe that walked both names snapshotted the second as null
    // and wrote no tombstones for anything.
    const PID = 'pmine';

    const withOneResume = () => {
      setProfileMapping(PID);
      localStorage.setItem('resume-designer-profiles', JSON.stringify([
        { id: PID, name: 'Ash', emoji: '\uD83D\uDE42', createdAt: 'x' },
      ]));
      localStorage.setItem('resume-designer-active-profile', PID);
      appStorage.setItem(DATA, JSON.stringify({
        variants: { 'v-9': { id: 'v-9', name: 'Dropped by the restore' } },
        currentVariantId: 'v-9',
      }));
      setRestoreStampHandler(stampRestoredWrites, announceRestoredUnits);
    };

    const replacementDropping = () => importFullBackupDurably({
      backupFormat: 2,
      kind: 'full',
      registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
      activeProfile: PID,
      shared: {},
      profiles: { [PID]: { keys: { [DATA]: JSON.stringify({ variants: {} }) } } },
    });

    afterEach(() => setRestoreStampHandler(null, null));

    it('stamps them despite the restore guard the durable wrapper leaves armed', async () => {
      withOneResume();
      await settle();

      await replacementDropping();

      // The guard is STILL armed here — the durable wrapper keeps it through the
      // caller's modal and reload — so a stamp attempted after the import would
      // be deferred, and the reload discards what was deferred. Riding the
      // restore's own writes is what makes this survive.
      expect(appStorage.isRestoreGuardActive()).toBe(true);
      const written = JSON.parse(backend.files.get(`resume-p--${PID}--${STATE}`) || '{}');
      expect(written['resume:v-9']?.modifiedAt).toEqual(expect.any(String));
      // And it must be a FRESH time, not the empty table the backup carried:
      // the restore replaces the stamp table wholesale, so a stamp written
      // before that write would be erased by it and read as -Infinity against
      // the remote's real stamp — the live copy wins and the deletion undoes
      // itself on the next fetch.
      expect(Date.parse(written['resume:v-9'].modifiedAt)).toBeGreaterThan(Date.now() - 60_000);
    });

    it('stamps and announces what the backup BRINGS, not only what it drops', async () => {
      // The general case of the same defect, and the larger half of it. Every
      // per-profile key a format-2 restore writes goes in under its PHYSICAL
      // name, which `classifyKey` answers 'unknown' for — so the interceptor
      // named none of it. A backup's new résumés, changed settings and job data
      // reached disk and were never stamped or announced: they did not upload,
      // and the restore ALSO replaces the stamp table with the backup's, so
      // they read as -Infinity against whatever the server still held and the
      // next fetch overwrote the restore with the copy it had just replaced.
      withOneResume();
      appStorage.setItem('resume-designer-applications', '[]');
      await settle();
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: {
          [PID]: {
            keys: {
              [DATA]: JSON.stringify({
                variants: { 'v-new': { id: 'v-new', name: 'Brought by the backup' } },
                currentVariantId: 'v-new',
                settings: { pageSize: 'a4' },
              }),
              'resume-designer-applications': '[{"id":"app-1"}]',
            },
          },
        },
      });
      await settle();

      const written = JSON.parse(backend.files.get(`resume-p--${PID}--${STATE}`) || '{}');
      // The résumé the backup brought, the settings it changed, and the whole
      // key it replaced — each stamped, each named.
      for (const unit of ['resume:v-new', 'data:settings', 'key:resume-designer-applications']) {
        expect(written[unit]?.modifiedAt).toEqual(expect.any(String));
        expect(allNamed()).toContain(unit);
      }
      // And the résumé it dropped still tombstones, so the general rule did not
      // cost the specific one.
      expect(allNamed()).toContain('resume:v-9');
    });

    it('names nothing for a key the restore rewrites byte for byte', async () => {
      // The other half of stamping a restore, and it is not a nicety. A backup
      // taken on this device and imported back writes most keys unchanged; if
      // that counted as a change, every résumé would go up with a fresh stamp
      // and newer-wins would revert another device's real edits — a restore that
      // visibly did nothing, undoing work on a machine that was not involved.
      // The comparison against the pre-wipe value is what prevents it, which is
      // why the restore records `previous` rather than passing null.
      withOneResume();
      await settle();
      const blob = appStorage.getItem(DATA);
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: { [PID]: { keys: { [DATA]: blob } } },
      });
      await settle();

      expect(allNamed()).not.toContain('resume:v-9');
    });

    it('stamps and announces the version history a backup carries', async () => {
      // History is the one kind `unitsFor` declines, because the save path that
      // writes it names its own unit as it goes — and a restore is not that
      // path. Left out, the parked conflict losers a backup carries would sit on
      // this device and reach no other.
      withOneResume();
      await settle();
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: {
          [PID]: {
            keys: {
              [DATA]: JSON.stringify({ variants: { 'v-9': { id: 'v-9', name: 'Kept' } } }),
              'resume-designer-history-v-9': JSON.stringify({
                history: [{ name: 'An earlier draft' }], historyIndex: 0,
              }),
            },
          },
        },
      });
      await settle();

      const unit = 'key:resume-designer-history-v-9';
      const written = JSON.parse(backend.files.get(`resume-p--${PID}--${STATE}`) || '{}');
      expect(written[unit]?.modifiedAt).toEqual(expect.any(String));
      expect(allNamed()).toContain(unit);
    });

    it('re-stamps a format-1 restore after the backup\u2019s own stamp table lands', async () => {
      // Format 1 writes under LOGICAL names, so the interceptor does stamp as it
      // goes — and then the backup's own sync-state key arrives later in the
      // same loop and REPLACES the table, erasing every stamp written before it.
      // Whatever the envelope happens to list first is silently unstamped, which
      // is the same -Infinity loss by a different route. Re-stamping at the end,
      // once that key has landed, is what survives it.
      withOneResume();
      await settle();
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 1,
        keys: {
          // Written FIRST, stamped by the interceptor...
          'resume-designer-applications': '[{"id":"app-1"}]',
          // ...and then wiped by this, which lands after it.
          [STATE]: JSON.stringify({ deviceId: 'from-the-backup' }),
        },
      });
      await settle();

      const unit = 'key:resume-designer-applications';
      const written = JSON.parse(backend.files.get(`resume-p--${PID}--${STATE}`) || '{}');
      expect(written[unit]?.modifiedAt).toEqual(expect.any(String));
      expect(allNamed()).toContain(unit);
    });

    it('takes back a stamp table it CREATED when the restore rolls back', async () => {
      // The stamp goes through appStorage directly, not through the restore's
      // tracked writer, so the restore does not otherwise know the key was
      // touched — and a workspace with no stamp table before the restore has no
      // entry in the pre-wipe snapshot either. The rollback then neither removed
      // nor restored it, and its second flush persisted FRESH timestamps sitting
      // on PRE-restore content. That content outranks a genuine remote edit and
      // sends itself over the top of it: a failed restore corrupting a device
      // that was never involved.
      setProfileMapping(PID);
      localStorage.setItem('resume-designer-profiles', JSON.stringify([
        { id: PID, name: 'Ash', emoji: '\uD83D\uDE42', createdAt: 'x' },
      ]));
      localStorage.setItem('resume-designer-active-profile', PID);
      appStorage.setItem(DATA, JSON.stringify({ variants: { 'v-9': { id: 'v-9', name: 'Mine' } } }));
      setRestoreStampHandler(stampRestoredWrites, announceRestoredUnits);
      await settle();
      // No stamp table for this workspace — the state the bug needs.
      const stateKey = `resume-p--${PID}--${STATE}`;
      backend.files.delete(stateKey);
      appStorage.removeItem(STATE);
      await settle();
      expect(backend.files.get(stateKey)).toBeUndefined();

      // A restore whose disk refuses one of its writes: it rolls back and throws.
      failWritesFor(`resume-p--${PID}--${DATA}`);
      await expect(importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: { [PID]: { keys: { [DATA]: JSON.stringify({ variants: {} }) } } },
      })).rejects.toThrow(/could not be written/i);
      failWritesFor(null);
      await settle();

      expect(backend.files.get(stateKey)).toBeUndefined();
    });

    it('clears a synced key the backup omits, instead of silently deleting it', async () => {
      // The résumé tombstone problem one level up, at whole KEYS. A replacement
      // restore wipes every owned key and puts back only the ones the backup
      // carries; the rest are deleted here and announced to nobody, because an
      // absent key produces no unit at all — `collectKeyUnit` says so out loud.
      // CloudKit keeps the old record, and the next fetch or any other device
      // hands the applications, job descriptions and chat threads back.
      withOneResume();
      appStorage.setItem('resume-designer-applications', '[{"id":"app-1"}]');
      appStorage.setItem('resume-designer-job-descriptions', '[{"id":"jd-1"}]');
      await settle();
      notify.mockClear();

      // A backup carrying neither key.
      await importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: { [PID]: { keys: { [DATA]: JSON.stringify({ variants: {} }) } } },
      });
      await settle();

      for (const key of ['resume-designer-applications', 'resume-designer-job-descriptions']) {
        // The value the deletion MEANS, which the interceptor can see — not an
        // absence, which it cannot.
        expect(backend.files.get(`resume-p--${PID}--${key}`)).toBe('[]');
        expect(allNamed()).toContain(`key:${key}`);
      }
    });

    it('clears what a format-1 backup omits too', async () => {
      withOneResume();
      appStorage.setItem('resume-designer-applications', '[{"id":"app-1"}]');
      await settle();
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 1,
        keys: { [DATA]: JSON.stringify({ variants: {} }) },
      });
      await settle();

      expect(backend.files.get(`resume-p--${PID}--resume-designer-applications`)).toBe('[]');
      expect(allNamed()).toContain('key:resume-designer-applications');
    });

    it('does not clear a key the backup DOES carry', async () => {
      // The dangerous direction, and the reason format 1 compares addresses
      // rather than the names it happened to pass to setItem. Format 1 writes
      // through LOGICAL names while the pre-wipe snapshot is keyed by address,
      // so comparing raw names makes every key it just restored read as omitted
      // — and clearing it destroys the restored content the person asked for,
      // then uploads that destruction to every other device.
      withOneResume();
      appStorage.setItem('resume-designer-applications', '[{"id":"old"}]');
      await settle();

      await importFullBackupDurably({
        backupFormat: 1,
        keys: {
          [DATA]: JSON.stringify({ variants: {} }),
          'resume-designer-applications': '[{"id":"from-the-backup"}]',
        },
      });
      await settle();

      expect(backend.files.get(`resume-p--${PID}--resume-designer-applications`))
        .toBe('[{"id":"from-the-backup"}]');
    });

    it('says nothing about a key that was already empty', async () => {
      // A `key:` unit is named unconditionally by `unitsFor` — there is no
      // comparison for it the way there is inside the blob — so clearing an
      // already-empty key would upload a no-op and, worse, stamp it with a
      // fresh time that outranks another device's real edit to it.
      withOneResume();
      appStorage.setItem('resume-designer-applications', '[]');
      await settle();
      notify.mockClear();

      await importFullBackupDurably({
        backupFormat: 2,
        kind: 'full',
        registry: [{ id: PID, name: 'Ash', emoji: '\uD83D\uDE42' }],
        activeProfile: PID,
        shared: {},
        profiles: { [PID]: { keys: { [DATA]: JSON.stringify({ variants: {} }) } } },
      });
      await settle();

      expect(allNamed()).not.toContain('key:resume-designer-applications');
    });

    it('announces them, past the barrier that has nothing left to gate', async () => {
      withOneResume();
      await settle();

      notify.mockClear();
      await replacementDropping();
      await settle();

      // Queued into the write-behind barrier instead, this waits for a drain
      // that never comes: the restore has just flushed everything, so no write
      // is left dirty to trigger one, and the reload the restore ends with
      // destroys the queue. Nothing would ever upload the tombstone, CloudKit
      // would keep the live record, and the next fetch would hand the résumé
      // back — the restore quietly undone. The barrier is for units queued
      // BEFORE their bytes land; this caller has already awaited exactly that.
      expect(allNamed()).toContain('resume:v-9');
    });
  });
});
