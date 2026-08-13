/**
 * An apply is confirmed against the DISK, never against the cache in front of
 * it.
 *
 * These tests run the REAL appStorage — a write-behind cache over an injected
 * backend — against the REAL sync model, because the bug they exist for is
 * invisible to any test that asserts memory. `appStorage.setItem` updates a Map
 * and schedules the disk write 250ms later, and a write that fails is
 * deliberately KEPT in memory (appStorage.js). So the model could report a unit
 * applied, the transport could store the server's change tag for it, and the
 * device could relaunch holding its old content paired with that new tag — after
 * which its next edit is accepted by CloudKit as a clean update and destroys the
 * other device's newer version, silently.
 *
 * Every assertion below therefore reads `backend.files`, which is the disk. The
 * cache is only ever read to PROVE the difference: in the failure test it holds
 * the fetched value while the disk does not, which is exactly the state a
 * memory-asserting test would have called a pass.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
  setStorageWriteObserver,
} from '../src/appStorage.js';
import {
  applyUnits, installStorageStamping, registerEditingProbe,
} from '../src/sync/syncModel.js';

const DATA = 'resume-designer-data';
const APPS = 'resume-designer-applications';
const STATE = 'resume-designer-sync-state';
const AT = '2026-08-09T00:00:00.000Z';

const SEEDED_BLOB = JSON.stringify({
  variants: { 'v-1': { name: 'Design Engineer', data: { name: 'Ada' } } },
  currentVariantId: 'v-1',
  settings: { pageSize: 'letter' },
});

/**
 * The Rust backend seam, with a switch on the write.
 *
 * `fail` is a set of keys whose write rejects — twice, since appStorage retries
 * once before it gives up, keeps the value in memory and reports the failure.
 * That is the "disk full / permissions" path, and it is the one that must never
 * be confirmed as an apply.
 */
function makeBackend(initial = {}) {
  const files = new Map(Object.entries(initial));
  const fail = new Set();
  return {
    files,
    fail,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => {
      if (fail.has(key)) throw new Error(`no space left on device: ${key}`);
      files.set(key, value);
    }),
    delete: vi.fn(async (key) => { files.delete(key); }),
    clear: vi.fn(async () => { files.clear(); }),
  };
}

const settingsUnit = (settings) => ({
  id: 'data:settings',
  kind: 'plain',
  payload: JSON.stringify(settings),
  modifiedAt: AT,
});

const appsUnit = (list) => ({
  id: `key:${APPS}`,
  kind: 'plain',
  payload: JSON.stringify(list),
  modifiedAt: AT,
});

/** What is actually on disk for a key, parsed. */
const onDisk = (backend, key) => {
  const raw = backend.files.get(key);
  return raw == null ? null : JSON.parse(raw);
};

let backend;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
  registerEditingProbe(null);
  backend = makeBackend({ [DATA]: SEEDED_BLOB, [APPS]: '[]' });
  await initAppStorage({ backend });
});

describe('an apply is not confirmed until the bytes are on disk', () => {
  it('answers AFTER the disk has taken the fetched unit, not when the cache has', async () => {
    const pending = applyUnits([settingsUnit({ pageSize: 'a4' })]);

    // The landing itself is synchronous, so by here the CACHE already holds the
    // remote settings — and the disk still holds the seeded ones. This is the
    // window the old code answered `applied: 1` in: kill the process now and the
    // device relaunches with `letter` and a change tag that says it holds `a4`.
    expect(appStorage.getItem(DATA)).toContain('a4');
    expect(onDisk(backend, DATA).settings).toEqual({ pageSize: 'letter' });

    // The answer waits for the drain, so the two can no longer disagree at the
    // moment the transport reads the count.
    expect(await pending).toEqual({ applied: 1 });
    expect(onDisk(backend, DATA).settings).toEqual({ pageSize: 'a4' });
  });

  it('reports NOTHING applied when the disk write fails, whatever the cache holds', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.fail.add(DATA);

    const { applied } = await applyUnits([settingsUnit({ pageSize: 'a4' })]);

    // No tag is earned, so the record comes back down the conflict path.
    expect(applied).toBe(0);
    // THE DISK never took it...
    expect(onDisk(backend, DATA).settings).toEqual({ pageSize: 'letter' });
    // ...while the cache did, and keeps it, because a failed write must not
    // throw away the session's data. Asserting THIS is what let five earlier
    // instances of this bug class pass their tests.
    expect(appStorage.getItem(DATA)).toContain('a4');
    spy.mockRestore();
  });

  it('forfeits the WHOLE batch when only one of its keys fails to land', async () => {
    // `applied` is a count, not a set of ids, so a partial failure cannot be
    // reported honestly as a number — and the transport treats a short count as
    // "which ones landed is unknown" and drops every tag in the batch. Zero is
    // the only truthful answer.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.fail.add(APPS);

    const { applied } = await applyUnits([
      settingsUnit({ pageSize: 'a4' }),
      appsUnit([{ id: 'app-9' }]),
    ]);

    expect(applied).toBe(0);
    expect(onDisk(backend, APPS)).toEqual([]);
    // The blob's own write DID land, and that is fine: forfeiting a tag for
    // content this device holds costs one round trip, never any content.
    expect(onDisk(backend, DATA).settings).toEqual({ pageSize: 'a4' });
    spy.mockRestore();
  });

  it('refuses to apply at all while a backup restore holds the storage guard', async () => {
    // The guard RECORDS every external write and skips both the cache and the
    // disk, so a landing here stores nothing — and `flush()` would still answer
    // `true`, since nothing is dirty. Confirming that as an apply is the same
    // bug one layer further out, and the restore ends in a reload from the
    // backup, so the content would be gone as well as the tag kept.
    appStorage.beginRestoreGuard();

    const { applied } = await applyUnits([settingsUnit({ pageSize: 'a4' })]);

    expect(applied).toBe(0);
    expect(appStorage.getItem(DATA)).toContain('letter');
    expect(onDisk(backend, DATA).settings).toEqual({ pageSize: 'letter' });

    appStorage.endRestoreGuard();
    appStorage.discardDeferredWrites();
  });

  it('lands a key unit durably, through its owner, for a plain successful apply', async () => {
    // The ordinary path, so the tests above are read as failures of a thing that
    // otherwise works rather than as the only behaviour there is.
    expect(await applyUnits([appsUnit([{ id: 'app-9' }])])).toEqual({ applied: 1 });
    expect(onDisk(backend, APPS)).toEqual([{ id: 'app-9' }]);
  });
});

describe('waiting for the disk does not widen the echo-suppression window', () => {
  it('stamps a local write that lands while the apply is still awaiting the disk', async () => {
    // `applying` is what stops an apply from stamping the content it just landed
    // and pushing it straight back with a timestamp minted here. Its whole
    // safety argument is that the suppressed region is ONE synchronous turn, so
    // nothing can interleave with it. The await added for durability sits after
    // the `finally` that restores the flag — if it ever moved inside, a local
    // edit made during the flush would be silently unstamped and never uploaded
    // again, which has no symptom until another device is missing a day's work.
    installStorageStamping(setStorageWriteObserver);

    const pending = applyUnits([settingsUnit({ pageSize: 'a4' })]);
    // Mid-flush: the drain is in flight and the apply has not answered yet.
    appStorage.setItem(APPS, JSON.stringify([{ id: 'typed-just-now' }]));
    await pending;
    await appStorage.flush();

    const stamps = JSON.parse(appStorage.getItem(STATE) ?? '{}');
    // The local write is stamped...
    expect(stamps[`key:${APPS}`]).toBeTruthy();
    // ...and the applied unit is not, which is the suppression still working.
    expect(stamps['data:settings']).toBeUndefined();
    setStorageWriteObserver(null);
  });
});
