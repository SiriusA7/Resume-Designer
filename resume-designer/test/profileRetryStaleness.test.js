/**
 * The profile sheet's retry copy must belong to the write that failed.
 *
 * These run the REAL appStorage against a backend, unlike profileBridge.test.js,
 * which drives the browser's SYNCHRONOUS localStorage throw. The bug here lives
 * only on the asynchronous path: on a device the write is behind a coalescing
 * drain, so the refusal arrives long after the call that made it, through
 * `onWriteFailure`, naming nothing but the key.
 *
 * And the key is `resume-designer-data` — the shared data blob. Every resume
 * save writes it, not just the profile sheet. So "a later failure on this key"
 * is not an exotic case; it is the ordinary one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
  setStorageWriteObserver,
} from '../src/appStorage.js';
import { installStorageStamping } from '../src/sync/syncModel.js';
import { applyProfile, getProfileState } from '../src/profileBridge.js';
import { getUserProfile, saveUserProfile } from '../src/persistence.js';
import { flushPendingProfileSave } from '../src/userProfilePanel.js';

const DATA = 'resume-designer-data';

let refusedKey = null;
const failWritesFor = (key) => { refusedKey = key; };
// A write that announces it has started and then hangs until released, so the
// cache can move on underneath an in-flight write — the interleaving that makes
// "a write to your key landed" and "your write landed" different statements.
let gateFirstWrite = null;
let announceStarted = null;
let seenValues = [];
let backend = null;

function makeBackend(initial = {}) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    loadAll: vi.fn(async () => Object.fromEntries(files)),
    write: vi.fn(async (key, value) => {
      seenValues.push(value);
      if (gateFirstWrite && key === DATA) {
        const gate = gateFirstWrite;
        gateFirstWrite = null;
        announceStarted?.();
        await gate;
      }
      if (key === refusedKey) throw new Error('no space left on device');
      files.set(key, value);
    }),
    delete: vi.fn(async (key) => { files.delete(key); }),
    clear: vi.fn(async () => { files.clear(); }),
  };
}

const settle = () => appStorage.flush();

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  refusedKey = null;
  gateFirstWrite = null;
  announceStarted = null;
  seenValues = [];
  backend = makeBackend({
    [DATA]: JSON.stringify({
      variants: { 'v-1': { name: 'Design Engineer', data: { name: 'Ada' } } },
      currentVariantId: 'v-1',
      userProfile: { personalSummary: 'original' },
    }),
  });
  await initAppStorage({ backend });
  // THE PRODUCTION WRITE OBSERVER, and it is not decoration. main.js installs
  // this unconditionally, and it makes `setItem` RE-ENTRANT: writing a synced
  // key stamps its unit, which is itself a `setItem` of the sync-state key,
  // from inside the first call. An earlier version of this file omitted it and
  // every case here passed against a bug that shipped — the write-id gate was
  // reading the stamper's id instead of the profile's, so the sheet had stopped
  // reporting its own refusals entirely. A harness that cannot see a nested
  // write cannot test anything that depends on which write is which.
  installStorageStamping(setStorageWriteObserver);
  // Attaches the bridge's storage listeners — the sheet's first read is what
  // installs them in production too.
  getProfileState();
});

afterEach(() => {
  setStorageWriteObserver(null);
  vi.restoreAllMocks();
});

describe('the profile retry copy belongs to the write that failed', () => {
  it('does not stand behind somebody else’s later failure on the same key', async () => {
    // A native profile edit that LANDS. Nothing is outstanding after this, and
    // the copy the sheet held to retry has done its job.
    applyProfile({ action: 'setField', path: 'personalSummary', value: 'from the sheet' });
    await settle();
    expect(getProfileState().saveFailed).toBe(false);

    // Somebody else moves the profile on — the AI interview's
    // `saveExtractedProfile`, or the always-mounted web editor. This lands too.
    saveUserProfile({ ...getUserProfile(), careerGoals: 'added afterwards' });
    await settle();

    // Now an UNRELATED write to the same blob is refused. A resume save is the
    // ordinary way to reach this: `resume-designer-data` holds the variants as
    // well as the profile.
    failWritesFor(DATA);
    appStorage.setItem(DATA, JSON.stringify({
      ...JSON.parse(appStorage.getItem(DATA)),
      currentVariantId: 'v-1',
    }));
    await settle();

    // THE BUG. The sheet used to keep its committed copy indefinitely, so this
    // failure — which is not its own, and is about a write it never made — armed
    // the banner and the retry against a snapshot from an arbitrarily earlier
    // moment.
    expect(getProfileState().saveFailed).toBe(false);

    // …and the retry it would have armed is what actually destroyed data: it
    // writes that stale profile back over the newer one, losing every field
    // added since. Proven by letting the flush run for real.
    failWritesFor(null);
    expect(flushPendingProfileSave()).toBe(true);
    await settle();

    expect(getUserProfile().careerGoals).toBe('added afterwards');
    expect(getUserProfile().personalSummary).toBe('from the sheet');
  });

  it('still stands behind its OWN asynchronous refusal', async () => {
    // The other half, and the reason the copy is held at all: when the drain
    // refuses the sheet's own write, the failure arrives with nothing but a key
    // name, so the held copy is the only record of what was lost. Clearing it
    // on a landing must not cost this.
    failWritesFor(DATA);
    applyProfile({ action: 'setField', path: 'personalSummary', value: 'never reached disk' });
    await settle();

    expect(getProfileState().saveFailed).toBe(true);

    // NOT asserted here: that `flushPendingProfileSave()` answers false. On this
    // path it cannot. The retry's own `setItem` is taken by the write-behind
    // CACHE and answers true long before the disk sees it, so the flush reports
    // what it honestly knows and the refusal resurfaces on the next drain. The
    // synchronous false — the browser's localStorage quota throw, where the
    // answer really is available in time — is profileBridge.test.js's subject.
    // Here the durable signal is `saveFailed` plus the drain, which is exactly
    // why the sheet keeps a copy at all.

    // The retry lands it once there is room.
    failWritesFor(null);
    expect(flushPendingProfileSave()).toBe(true);
    await settle();

    expect(getUserProfile().personalSummary).toBe('never reached disk');
    expect(getProfileState().saveFailed).toBe(false);
  });

  it('is not fooled by an older write landing while its own is deferred', async () => {
    // A backup restore arms a guard that DEFERS every other writer, and the
    // window is a real one — it spans the restore's own `await flush()`. A
    // profile edit made inside it is deferred, not cancelled, and `saveToStorage`
    // still answers true, so the sheet holds a copy and an id for it.
    //
    // The id has to be the deferred write's OWN. Minted only when something is
    // queued, `currentWriteSequence` would answer with the restore's earlier
    // write id, the sheet would record that as its own, and the settle for the
    // restore would read as "mine landed" — dropping a copy whose bytes were
    // never attempted, exactly as clearing on a bare key did.
    appStorage.setItem(DATA, JSON.stringify({
      ...JSON.parse(appStorage.getItem(DATA)),
      touched: 'the restore',
    }));
    appStorage.beginRestoreGuard(new Map([[DATA, appStorage.getItem(DATA)]]), [DATA]);

    applyProfile({ action: 'setField', path: 'personalSummary', value: 'edited mid-restore' });

    // The restore's own write lands; the profile edit is still only deferred.
    await settle();

    // The restore fails, so its writes are rolled back and the deferred edit is
    // replayed — into a disk that now refuses it.
    appStorage.endRestoreGuard();
    failWritesFor(DATA);
    appStorage.flushDeferredWrites();
    await settle();

    expect(backend.files.get(DATA)).not.toContain('edited mid-restore');
    expect(getProfileState().saveFailed).toBe(true);
  });

  it('is not fooled by an older write of the same key landing first', async () => {
    // The interleaving that makes "a write to your key landed" and "YOUR write
    // landed" different statements, and the reason the copy is gated on a write
    // id rather than a key. The drain reads `cache.get(key)` when the op's turn
    // arrives and only then awaits the disk, so bytes already in flight can land
    // while the cache has moved on.
    let started;
    const startedP = new Promise((resolve) => { started = resolve; });
    announceStarted = started;
    let openGate;
    gateFirstWrite = new Promise((resolve) => { openGate = resolve; });

    // A resume save writes the shared blob. Its drain op begins and hangs
    // mid-write, holding the PRE-commit bytes it read on the way in.
    appStorage.setItem(DATA, JSON.stringify({
      ...JSON.parse(appStorage.getItem(DATA)),
      touched: 'a resume save',
    }));
    const inFlight = settle();
    await startedP;

    // The person edits their profile while that write is in the air.
    applyProfile({ action: 'setField', path: 'personalSummary', value: 'from the sheet' });

    // The older write lands — bytes that do not contain the edit.
    openGate();
    await inFlight;
    expect(seenValues[0]).not.toContain('from the sheet');

    // Now the disk refuses, and the sheet's own write is drained into it.
    failWritesFor(DATA);
    await settle();
    expect(seenValues.some((v) => v.includes('from the sheet'))).toBe(true);
    expect(backend.files.get(DATA)).not.toContain('from the sheet');

    // Keyed on the bare key, the landing above cleared the held copy and this
    // refusal then had nothing to promote: no banner, no retry, and a person
    // told their edits were saved. Which is the very failure the held copy
    // exists to prevent, reintroduced one window over.
    expect(getProfileState().saveFailed).toBe(true);
    expect(getUserProfile().personalSummary).toBe('from the sheet');
  });
});
