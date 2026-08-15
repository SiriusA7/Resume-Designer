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

  expect(await applyUnits([unit])).toEqual({ applied: 1 });

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
  }])).toEqual({ applied: 1 });

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
  }])).toEqual({ applied: 0 });
});
