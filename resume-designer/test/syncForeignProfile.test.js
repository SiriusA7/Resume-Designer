import { beforeEach, expect, it, vi } from 'vitest';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
} from '../src/appStorage.js';
import { physicalKey } from '../src/profileKeys.js';
import { applyUnits } from '../src/sync/syncModel.js';

const DATA = 'resume-designer-data';
const PROFILES = 'resume-designer-profiles';
const ACTIVE_PROFILE = 'resume-designer-active-profile';
const NEW = '2026-08-09T00:00:00.000Z';

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

let backend;

beforeEach(async () => {
  __resetAppStorageForTests();
  setProfileMapping(null);
  localStorage.clear();
  backend = makeBackend({
    [ACTIVE_PROFILE]: 'pactive',
    [PROFILES]: JSON.stringify([
      { id: 'pactive', name: 'Active' },
      { id: 'pother', name: 'Other' },
    ]),
  });
  await initAppStorage({ backend });
});

/**
 * A UNIT FROM ANOTHER PROFILE'S ZONE LANDS IN THAT PROFILE'S KEYS.
 *
 * Every profile syncs now, so a fetch arrives for profiles that are not open.
 * The active mapping must not capture them: a résumé belonging to profile B
 * written into profile A's namespace is both a loss for B and a corruption of
 * A, and neither is visible until someone switches.
 */
it('lands a foreign profile unit in that profile keys, not the active ones', async () => {
  setProfileMapping('pactive');
  const unit = {
    id: 'resume:v-9',
    kind: 'resume',
    payload: JSON.stringify({ id: 'v-9', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW,
    profileId: 'pother',
  };

  expect(await applyUnits([unit]))
    .toEqual({ applied: 1, accounted: [{ id: 'resume:v-9', profileId: 'pother' }] });

  const otherData = backend.files.get(physicalKey('pother', DATA));
  expect(otherData).toBeDefined();
  const theirs = JSON.parse(otherData);
  expect(theirs.variants['v-9'].data).toEqual({ name: 'Bo' });
  expect(backend.files.get(physicalKey('pactive', DATA)) ?? '{}').not.toContain('v-9');
});

it('routes by the live mapping while a durable profile switch awaits reload', async () => {
  setProfileMapping('pactive');
  appStorage.setItem(ACTIVE_PROFILE, 'pother');
  expect(await appStorage.flush()).toBe(true);

  expect(await applyUnits([{
    id: 'resume:v-switch',
    kind: 'resume',
    payload: JSON.stringify({ id: 'v-switch', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW,
    profileId: 'pother',
  }])).toEqual({ applied: 1, accounted: [{ id: 'resume:v-switch', profileId: 'pother' }] });

  const switchedData = backend.files.get(physicalKey('pother', DATA));
  expect(switchedData).toBeDefined();
  const theirs = JSON.parse(switchedData);
  expect(theirs.variants['v-switch'].data).toEqual({ name: 'Bo' });
  expect(backend.files.get(physicalKey('pactive', DATA)) ?? '{}').not.toContain('v-switch');
});

it('keeps the same unit id in two profiles independent', async () => {
  setProfileMapping('pactive');
  await applyUnits([
    { id: 'resume:v-1', kind: 'resume', payload: JSON.stringify({ id: 'v-1', name: 'Mine', data: { name: 'A' } }), modifiedAt: NEW, profileId: 'pactive' },
    { id: 'resume:v-1', kind: 'resume', payload: JSON.stringify({ id: 'v-1', name: 'Theirs', data: { name: 'B' } }), modifiedAt: NEW, profileId: 'pother' },
  ]);

  expect(JSON.parse(backend.files.get(physicalKey('pactive', DATA))).variants['v-1'].data).toEqual({ name: 'A' });
  expect(JSON.parse(backend.files.get(physicalKey('pother', DATA))).variants['v-1'].data).toEqual({ name: 'B' });
});

it('refuses to acknowledge a foreign landing that did not reach disk', async () => {
  setProfileMapping('pactive');
  backend.fail.add(physicalKey('pother', DATA));

  expect(await applyUnits([{
    id: 'resume:v-9', kind: 'resume',
    payload: JSON.stringify({ id: 'v-9', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW, profileId: 'pother',
  }])).toEqual({ applied: 0, accounted: [] });
});

/**
 * A MIXED BATCH MAKES PROGRESS, AND A SETTLED UNIT NEVER STALLS ONE.
 *
 * This is the failure the first working two-device test found, and it is why
 * neither device ever converged.
 *
 * `applied` counted WRITES. A unit correctly skipped because this device's copy
 * is newer wrote nothing, so a batch containing one could never report
 * `applied == units.count`, and the transport read that as "the page took none
 * of this", forfeited every change tag in the batch and deferred the lot. The
 * next fetch delivered the identical batch, the same unit was skipped for the
 * same permanent reason, and it failed identically. For ever.
 *
 * It is not an edge case: a second device mints its own workspace at first
 * launch, so ITS settings are always newer than the ones arriving from the
 * first device. Every batch carrying settings was poisoned, résumés included.
 *
 * The answer now names each unit it has ACCOUNTED FOR — written, or settled
 * because nothing will ever land it — so the tags of the settled ones are kept
 * and only genuine refusals come back.
 */
it('accounts for a unit whose local copy is newer, and lands the rest of the batch', async () => {
  const OLD = '2026-08-01T00:00:00.000Z';
  // The local copy of settings is NEWER than the one arriving, exactly as a
  // freshly minted second workspace's is.
  appStorage.setItem(DATA, JSON.stringify({
    variants: {}, settings: { pageSize: 'letter' },
  }));
  appStorage.setItem('resume-designer-sync-state', JSON.stringify({
    'data:settings': { modifiedAt: NEW },
  }));
  await appStorage.flush();

  const stale = {
    id: 'data:settings', kind: 'plain',
    payload: JSON.stringify({ pageSize: 'a4' }), modifiedAt: OLD, profileId: '',
  };
  const resume = {
    id: 'resume:v-7', kind: 'resume',
    payload: JSON.stringify({ id: 'v-7', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW, profileId: '',
  };

  const answer = await applyUnits([stale, resume]);

  // The résumé wrote; the stale settings did not, and correctly so.
  expect(answer.applied).toBe(1);
  expect(JSON.parse(appStorage.getItem(DATA)).variants['v-7']).toBeTruthy();
  expect(JSON.parse(appStorage.getItem(DATA)).settings).toEqual({ pageSize: 'letter' });

  // BOTH are accounted for. The settled one keeps its change tag, so it is not
  // delivered again — which is what stops the batch being re-offered for ever.
  expect(answer.accounted).toEqual(expect.arrayContaining([
    { id: 'data:settings', profileId: '' },
    { id: 'resume:v-7', profileId: '' },
  ]));
  expect(answer.accounted).toHaveLength(2);
});

/**
 * A REFUSAL IS STILL A REFUSAL. A unit for a profile the registry does not list
 * has to come back once the registry lands, so it must NOT be accounted for —
 * the distinction the fix above turns on is between "nothing will ever land
 * this" and "not yet".
 */
it('refuses, rather than settles, a unit for a profile the registry does not list', async () => {
  const answer = await applyUnits([{
    id: 'resume:v-ghost', kind: 'resume',
    payload: JSON.stringify({ id: 'v-ghost', name: 'Theirs', data: { name: 'Bo' } }),
    modifiedAt: NEW, profileId: 'pnotinregistry',
  }]);

  expect(answer.applied).toBe(0);
  expect(answer.accounted).toEqual([]);
});
