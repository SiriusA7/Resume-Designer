/**
 * A SAVE CONFLICT IS RESOLVED BY THE MODEL, AND AN APPEND-SHAPED UNIT UNIONS.
 *
 * CloudKit rejects a save whose record moved underneath it and hands back the
 * version it holds. The transport used to resolve that itself, by timestamp, for
 * EVERY kind — a second copy of `resolveConflict` living in Swift, and simply
 * the wrong rule for the two units that accumulate. When the local copy won it
 * retried the local payload unchanged and handed the server's unit to
 * `parkLoser`, which has nowhere to put a unit that is not a résumé, so a token
 * log or a version history ended up on the server as ONE SIDE rather than the
 * union. The other device's entries survived only in this device's local copy,
 * and a reinstall before the next local append made them unrecoverable.
 *
 * The two assertions that matter are therefore made twice over, for the token
 * log and for version history: the union is ON DISK, and the union is what would
 * be SENT BACK — `collectUnit`, which is exactly what the transport asks for at
 * send time (`recordToSend` → `syncUnit(withId:)`).
 *
 * These run the REAL appStorage over an injected backend, like
 * syncDurableApply.test.js and for the same reason: a resolution confirmed
 * against the write-behind cache is not a resolution, and the transport keeps
 * the server's change tag on this answer.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
  setStorageWriteObserver,
} from '../src/appStorage.js';
import {
  resolveConflicts, collectUnit, installStorageStamping,
} from '../src/sync/syncModel.js';
import { initIOSShell, SHELL_HANDLER } from '../src/iosShell.js';
import { physicalKey } from '../src/profileKeys.js';

const DATA = 'resume-designer-data';
const TOKENS = 'resume-designer-token-usage';
const HISTORY = 'resume-designer-history-v-1';
const APPS = 'resume-designer-applications';
const STATE = 'resume-designer-sync-state';
const PROFILES = 'resume-designer-profiles';
const ACTIVE_PROFILE = 'resume-designer-active-profile';
const ACTIVE_PROFILE_ID = 'pactive';
const FOREIGN_PROFILE_ID = 'pother';

const OLD = '2026-08-01T00:00:00.000Z';
const NEW = '2026-08-09T00:00:00.000Z';

const SEEDED_BLOB = JSON.stringify({
  variants: { 'v-1': { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada' } } },
  currentVariantId: 'v-1',
  settings: { pageSize: 'letter' },
});

/** The Rust backend seam, with a switch on the write. Same shape as elsewhere. */
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

const onDisk = (key) => {
  const raw = backend.files.get(key);
  return raw == null ? null : JSON.parse(raw);
};

/** What the transport would ask for at send time, parsed. */
const wouldSend = (unitId) => JSON.parse(collectUnit(unitId).payload);

const unit = (id, payload, modifiedAt, kind = 'plain') => ({
  id, kind, payload: JSON.stringify(payload), modifiedAt,
});

const entry = (name, timestamp) => ({
  data: { name }, timestamp, description: `edited on ${name}`, changeType: 'edit',
});

const event = (id, timestamp) => ({
  id, timestamp, model: 'anthropic/claude', feature: 'chat', inputTokens: 1, outputTokens: 2,
});

let backend;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
  backend = makeBackend({ [DATA]: SEEDED_BLOB, [APPS]: '[]' });
  await initAppStorage({ backend });
});

describe('an append-shaped unit unions on the save-conflict path', () => {
  it('unions VERSION HISTORY rather than keeping one side of it', async () => {
    backend.files.set(HISTORY, JSON.stringify({
      history: [entry('mine', '2026-08-03T00:00:00.000Z')], historyIndex: 0,
    }));
    await initAppStorage({ backend });

    const id = `key:${HISTORY}`;
    // What this device tried to send, and what the server answered with. The
    // server's document is not a superset and not a subset: each side holds an
    // entry the other has never seen, which is the only shape in which
    // newer-wins can be told apart from a union.
    const local = unit(id, { history: [entry('mine', '2026-08-03T00:00:00.000Z')], historyIndex: 0 }, NEW);
    const server = unit(id, { history: [entry('theirs', '2026-08-04T00:00:00.000Z')], historyIndex: 0 }, OLD);

    const answer = await resolveConflicts([{ local, server }]);

    // The server still owes an update — it holds one side, and the union has to
    // reach it — and NOTHING is parked, because a union has no loser. The old
    // code parked here and `parkLoser` refused, which is how the entries were
    // lost without a word.
    expect(answer).toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 0 });

    // ON THE DISK...
    expect(onDisk(HISTORY).history.map((e) => e.data.name)).toEqual(['mine', 'theirs']);
    // ...and in what would go back to CloudKit. Under the old rule this was
    // `['mine']`: the local payload was retried unchanged and the server's entry
    // existed nowhere afterwards.
    expect(wouldSend(id).history.map((e) => e.data.name)).toEqual(['mine', 'theirs']);
  });

  it('unions the TOKEN LOG rather than keeping one side of it', async () => {
    backend.files.set(TOKENS, JSON.stringify({
      events: [event('mine', '2026-08-03T00:00:00.000Z')], summary: {},
    }));
    await initAppStorage({ backend });

    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', '2026-08-03T00:00:00.000Z')], summary: {} }, NEW, 'tokenUsage');
    const server = unit(id, { events: [event('theirs', '2026-08-04T00:00:00.000Z')], summary: {} }, OLD, 'tokenUsage');

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 0 });

    expect(onDisk(TOKENS).events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    expect(wouldSend(id).events.map((e) => e.id)).toEqual(['mine', 'theirs']);
    // The summary is recomputed from the merged events, so it can never describe
    // a set of events the document does not hold.
    expect(wouldSend(id).summary.byModel['anthropic/claude'].calls).toBe(2);
  });

  it('unions whichever side is newer, because a union does not need to be', async () => {
    // The same conflict with the stamps the other way round. A comparison would
    // give opposite answers; a union gives the same one, which is the point.
    backend.files.set(TOKENS, JSON.stringify({
      events: [event('mine', '2026-08-03T00:00:00.000Z')], summary: {},
    }));
    await initAppStorage({ backend });

    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', '2026-08-03T00:00:00.000Z')], summary: {} }, OLD, 'tokenUsage');
    const server = unit(id, { events: [event('theirs', '2026-08-04T00:00:00.000Z')], summary: {} }, NEW, 'tokenUsage');

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 0 });
    expect(onDisk(TOKENS).events.map((e) => e.id)).toEqual(['mine', 'theirs']);
  });
});

describe('a snapshot still takes newer-wins, and its loser is still parked', () => {
  it('parks a foreign profile loser and its stamp in that profile namespace', async () => {
    setProfileMapping(ACTIVE_PROFILE_ID);
    backend.files.set(ACTIVE_PROFILE, ACTIVE_PROFILE_ID);
    backend.files.set(PROFILES, JSON.stringify([
      { id: ACTIVE_PROFILE_ID, name: 'Active' },
      { id: FOREIGN_PROFILE_ID, name: 'Other' },
    ]));
    backend.files.set(physicalKey(FOREIGN_PROFILE_ID, DATA), SEEDED_BLOB);
    await initAppStorage({ backend });

    const id = 'resume:v-1';
    const local = {
      ...unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada' } }, OLD, 'resume'),
      profileId: FOREIGN_PROFILE_ID,
    };
    const server = {
      ...unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada (phone)' } }, NEW, 'resume'),
      profileId: FOREIGN_PROFILE_ID,
    };

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: FOREIGN_PROFILE_ID, retry: false }], parked: 1 });
    expect(JSON.parse(backend.files.get(physicalKey(FOREIGN_PROFILE_ID, DATA)))
      .variants['v-1'].data).toEqual({ name: 'Ada (phone)' });
    expect(JSON.parse(backend.files.get(physicalKey(FOREIGN_PROFILE_ID, HISTORY)))
      .history[0].data).toEqual({ name: 'Ada' });
    expect(JSON.parse(backend.files.get(physicalKey(FOREIGN_PROFILE_ID, STATE)))[`key:${HISTORY}`])
      .toBeTruthy();
    expect(backend.files.has(physicalKey(ACTIVE_PROFILE_ID, HISTORY))).toBe(false);
  });

  it('keeps the local copy and parks the SERVER version when ours is newer', async () => {
    const id = 'resume:v-1';
    const local = unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada' } }, NEW, 'resume');
    const server = unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada (phone)' } }, OLD, 'resume');

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 1 });

    // The document this device holds is untouched, and the server owes an update.
    expect(onDisk(DATA).variants['v-1'].data).toEqual({ name: 'Ada' });
    expect(wouldSend(id).data).toEqual({ name: 'Ada' });
    // The older version is a restore away rather than gone.
    const parked = onDisk(HISTORY).history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked).toHaveLength(1);
    expect(parked[0].data).toEqual({ name: 'Ada (phone)' });
    // Parking CHANGES that variant's history unit, and no save accompanies this
    // one — so it stamps itself, or it would lose every conflict it ever met.
    expect(JSON.parse(appStorage.getItem(STATE))[`key:${HISTORY}`]).toBeTruthy();
  });

  it('takes the SERVER copy and parks ours when theirs is newer, and owes nothing back', async () => {
    const id = 'resume:v-1';
    const local = unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada' } }, OLD, 'resume');
    const server = unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada (phone)' } }, NEW, 'resume');

    // `retry: false` is not a detail: the server already holds the winner, and
    // sending our copy back would push this device's stamp over the version it
    // has only just taken.
    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: '', retry: false }], parked: 1 });

    expect(onDisk(DATA).variants['v-1'].data).toEqual({ name: 'Ada (phone)' });
    const parked = onDisk(HISTORY).history.filter((e) => e.changeType === 'sync-conflict');
    expect(parked.map((e) => e.data)).toEqual([{ name: 'Ada' }]);
  });

  it('discards the older side of a snapshot with nowhere to park, and still resolves', async () => {
    // `parkLoser` has only version history to park in, so a non-résumé loser is
    // discarded — which is what newer-wins MEANS for such a unit. Refusing the
    // resolution over that would forfeit the change tag, bring the same record
    // back, and leave this device's newer content permanently out of iCloud.
    const id = `key:${APPS}`;
    const local = unit(id, [{ id: 'app-1' }], NEW);
    const server = unit(id, [{ id: 'app-0' }], OLD);

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 0 });
  });

  it('forfeits a local-winner snapshot when its cached winner cannot reach disk', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const winner = [{ id: 'app-1' }];
    backend.fail.add(APPS);
    appStorage.setItem(APPS, JSON.stringify(winner));

    // The failed drain leaves the new bytes in the cache and the old bytes on
    // disk. This is the persistent state in which acknowledging the server's
    // change tag would let a relaunch send stale disk content under that tag.
    expect(await appStorage.flush()).toBe(false);

    const id = `key:${APPS}`;
    const answer = await resolveConflicts([{
      local: unit(id, winner, NEW),
      server: unit(id, [{ id: 'app-0' }], OLD),
    }]);
    const diskValue = onDisk(APPS);
    spy.mockRestore();

    expect(answer).toEqual({ resolved: [], parked: 0 });
    expect(diskValue).toEqual([]);
  });

  it('flushes a cached local winner to disk before acknowledging resolution', async () => {
    const winner = [{ id: 'app-1' }];
    appStorage.setItem(APPS, JSON.stringify(winner));

    const id = `key:${APPS}`;
    expect(await resolveConflicts([{
      local: unit(id, winner, NEW),
      server: unit(id, [{ id: 'app-0' }], OLD),
    }])).toEqual({ resolved: [{ id, profileId: '', retry: true }], parked: 0 });
    expect(onDisk(APPS)).toEqual(winner);
  });
});

describe('a conflict this device cannot resolve forfeits rather than proceeds', () => {
  it('rechecks a foreign winner against that profile recency stamp', async () => {
    setProfileMapping(ACTIVE_PROFILE_ID);
    backend.files.set(ACTIVE_PROFILE, ACTIVE_PROFILE_ID);
    backend.files.set(PROFILES, JSON.stringify([
      { id: ACTIVE_PROFILE_ID, name: 'Active' },
      { id: FOREIGN_PROFILE_ID, name: 'Other' },
    ]));
    backend.files.set(physicalKey(FOREIGN_PROFILE_ID, DATA), SEEDED_BLOB);
    backend.files.set(physicalKey(FOREIGN_PROFILE_ID, STATE), JSON.stringify({
      'resume:v-1': { modifiedAt: '2099-01-01T00:00:00.000Z' },
    }));
    await initAppStorage({ backend });

    const id = 'resume:v-1';
    const local = {
      ...unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Ada' } }, OLD, 'resume'),
      profileId: FOREIGN_PROFILE_ID,
    };
    const server = {
      ...unit(id, { id: 'v-1', name: 'Design Engineer', data: { name: 'Stale server' } }, NEW, 'resume'),
      profileId: FOREIGN_PROFILE_ID,
    };

    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [], parked: 0 });
    expect(JSON.parse(backend.files.get(physicalKey(FOREIGN_PROFILE_ID, DATA)))
      .variants['v-1'].data).toEqual({ name: 'Ada' });
  });

  it('refuses a device-local snapshot even when the local copy is newer', async () => {
    const id = 'key:resume-zoom';
    const local = unit(id, 1.5, NEW);
    const server = unit(id, 1.25, OLD);

    // Device-local state must not cross devices in either direction. Omitting
    // this refusal returned `retry: true`; later send-time filtering happened
    // to stop the leak, but the conflict decision itself had already promised
    // a retry for a unit that can never be synced.
    expect(await resolveConflicts([{ local, server }]))
      .toEqual({ resolved: [], parked: 0 });
    expect(backend.files.has('resume-zoom')).toBe(false);
  });

  it('refuses a payload that will not parse instead of writing half a merge', async () => {
    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', OLD)], summary: {} }, NEW, 'tokenUsage');
    const answer = await resolveConflicts([{
      local, server: { id, kind: 'tokenUsage', payload: '{ not json', modifiedAt: OLD },
    }]);

    // Absent from `resolved`, so the transport forfeits the tag and the whole
    // comparison happens again at the next start. Nothing was written.
    expect(answer).toEqual({ resolved: [], parked: 0 });
    expect(backend.files.has(TOKENS)).toBe(false);
  });

  it('refuses a pair that does not name one unit', async () => {
    const local = unit('resume:v-1', { data: { name: 'Ada' } }, NEW, 'resume');
    const server = unit('resume:v-2', { data: { name: 'Bea' } }, OLD, 'resume');
    expect(await resolveConflicts([{ local, server }])).toEqual({ resolved: [], parked: 0 });
    expect(await resolveConflicts([{ server }])).toEqual({ resolved: [], parked: 0 });
    expect(await resolveConflicts('not a batch')).toEqual({ resolved: [], parked: 0 });
  });

  it('refuses when the server copy that should win cannot land', async () => {
    // The server's résumé record carries no document, so `landFetchedUnits`
    // refuses it — and a refusal there is a refusal here. Landing nothing and
    // parking ours would have replaced a real résumé with an absence.
    const id = 'resume:v-1';
    const local = unit(id, { id: 'v-1', data: { name: 'Ada' } }, OLD, 'resume');
    const server = unit(id, { id: 'v-1', name: 'Design Engineer' }, NEW, 'resume');

    expect(await resolveConflicts([{ local, server }])).toEqual({ resolved: [], parked: 0 });
    expect(onDisk(DATA).variants['v-1'].data).toEqual({ name: 'Ada' });
    expect(backend.files.has(HISTORY)).toBe(false);
  });

  it('refuses the WHOLE batch when the resolution does not reach the disk', async () => {
    // A resolution confirmed against the write-behind cache is not a resolution:
    // the transport keeps the SERVER's change tag on this answer, and a device
    // that relaunches without the bytes cannot claim to know which server
    // version it is editing. Which units landed is not knowable from a failed
    // whole-store flush, so zero is the only honest answer.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    backend.files.set(TOKENS, JSON.stringify({ events: [event('mine', OLD)], summary: {} }));
    await initAppStorage({ backend });
    backend.fail.add(TOKENS);

    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', OLD)], summary: {} }, NEW, 'tokenUsage');
    const server = unit(id, { events: [event('theirs', NEW)], summary: {} }, OLD, 'tokenUsage');

    expect(await resolveConflicts([{ local, server }])).toEqual({ resolved: [], parked: 0 });
    // THE DISK never took the union...
    expect(onDisk(TOKENS).events.map((e) => e.id)).toEqual(['mine']);
    // ...while the cache did, and keeps it, because a failed write must not
    // throw away the session's data. Asserting THIS is what a memory-shaped test
    // would have called a pass.
    expect(JSON.parse(appStorage.getItem(TOKENS)).events.map((e) => e.id))
      .toEqual(['mine', 'theirs']);
    spy.mockRestore();
  });

  it('refuses to resolve at all while a backup restore holds the storage guard', async () => {
    // The guard records every external write and skips both the cache and the
    // disk, while `flush()` would still answer true over nothing dirty — and the
    // restore ends in a reload from the backup, so a tag kept here would
    // describe content about to be replaced wholesale.
    appStorage.beginRestoreGuard();
    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', OLD)], summary: {} }, NEW, 'tokenUsage');
    const server = unit(id, { events: [event('theirs', NEW)], summary: {} }, OLD, 'tokenUsage');

    expect(await resolveConflicts([{ local, server }])).toEqual({ resolved: [], parked: 0 });

    appStorage.endRestoreGuard();
    appStorage.discardDeferredWrites();
  });
});

describe('resolving does not widen the echo-suppression window', () => {
  afterEach(() => {
    setStorageWriteObserver(null);
  });

  it('stamps a local write that lands while the resolution is awaiting the disk', async () => {
    // `applying` is what stops a landing from stamping the content it just took
    // and pushing it straight back with a timestamp minted here. Its whole
    // safety argument is that the suppressed region is ONE synchronous turn, so
    // nothing can interleave with it. Every step of a resolution — the merge,
    // the landing, the park — is synchronous for that reason, and the await for
    // the disk sits after the `finally` that restores the flag. If it ever moved
    // inside, a local edit made during the flush would be silently unstamped and
    // never uploaded again.
    installStorageStamping(setStorageWriteObserver);

    const id = `key:${TOKENS}`;
    const local = unit(id, { events: [event('mine', OLD)], summary: {} }, NEW, 'tokenUsage');
    const server = unit(id, { events: [event('theirs', NEW)], summary: {} }, OLD, 'tokenUsage');
    const pending = resolveConflicts([{ local, server }]);
    // Mid-flush: the drain is in flight and the resolution has not answered yet.
    appStorage.setItem(APPS, JSON.stringify([{ id: 'typed-just-now' }]));
    await pending;
    await appStorage.flush();

    const stamps = JSON.parse(appStorage.getItem(STATE) ?? '{}');
    // The local write is stamped...
    expect(stamps[`key:${APPS}`]).toBeTruthy();
    // ...and the merged unit is not, which is the suppression still working: the
    // union carries the other device's events, and a stamp minted here would let
    // this device win a later comparison over content it never authored.
    expect(stamps[id]).toBeUndefined();
  });
});

/**
 * THROUGH THE BRIDGE ITSELF, because the transport reaches none of the above
 * directly: it sends a command string through `callAsyncJavaScript` and reads
 * ids and counts off the dispatcher's `{ ok, result }` envelope. A test that
 * called `resolveConflicts` alone would pass against a bridge that dropped the
 * promise, which is exactly the shape of an earlier bug here.
 */
describe('the resolution crosses the bridge Swift actually uses', () => {
  it('carries both versions in and the resolution out', async () => {
    backend.files.set(TOKENS, JSON.stringify({
      events: [event('mine', '2026-08-03T00:00:00.000Z')], summary: {},
    }));
    await initAppStorage({ backend });
    const postMessage = vi.fn();
    globalThis.webkit = { messageHandlers: { [SHELL_HANDLER]: { postMessage } } };
    initIOSShell({
      subscribeVariants: vi.fn(),
      subscribeDocument: vi.fn(),
      getVariantsSnapshot: () => ({ currentId: null, list: [] }),
      getZoom: () => 1,
      getSettings: () => ({}),
      getTheme: () => 'system',
      getPendingChanges: () => [],
      getAppInfo: () => Promise.resolve({ version: '2.1.0' }),
      // The real one: the point of this file is what reaches the disk.
      resolveConflicts,
      collectUnit,
    });

    const id = `key:${TOKENS}`;
    const conflicts = JSON.stringify([{
      local: unit(id, { events: [event('mine', OLD)], summary: {} }, NEW, 'tokenUsage'),
      server: unit(id, { events: [event('theirs', NEW)], summary: {} }, OLD, 'tokenUsage'),
    }]);

    const reply = await window.__opShell.commandAsync({ type: 'syncResolveConflicts', conflicts });

    expect(reply).toEqual({ ok: true, result: { resolved: [{ id, profileId: '', retry: true }], parked: 0 } });
    // The disk is asserted after the answer, which is the claim the answer makes.
    expect(onDisk(TOKENS).events.map((e) => e.id)).toEqual(['mine', 'theirs']);
  });
});
