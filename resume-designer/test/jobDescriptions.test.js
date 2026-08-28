// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  initJobDescriptions, getAllJobDescriptions, addJobDescription, jobStorageFailed,
} from '../src/jobDescriptions.js';
import {
  appStorage, initAppStorage, __resetAppStorageForTests, setProfileMapping,
} from '../src/appStorage.js';

const KEY = 'resume-designer-job-descriptions';

// Regression for the Codex finding on the next→main flow: stores migrated from
// legacy Electron before the import normalizer can hold an id-keyed OBJECT map
// under the job-descriptions key. init must self-heal it to the array shape the
// module requires — previously `[...jobDescriptions]` threw and the Jobs dialog
// never opened.

beforeEach(() => {
  localStorage.clear();
});

describe('initJobDescriptions — legacy shapes', () => {
  it('loads a normal array store', () => {
    localStorage.setItem(KEY, '[{"id":"jd-1","title":"PM","description":"Ship"}]');
    initJobDescriptions();
    expect(getAllJobDescriptions().map((j) => j.id)).toEqual(['jd-1']);
  });

  it('self-heals an id-keyed object map into an array', () => {
    localStorage.setItem(
      KEY,
      '{"jd-1":{"id":"jd-1","title":"PM","description":"Ship"},"jd-2":{"id":"jd-2","title":"EM","description":"Lead"}}'
    );
    initJobDescriptions();
    const all = getAllJobDescriptions(); // spreads the cache — the old crash site
    expect(all.map((j) => j.id)).toEqual(['jd-1', 'jd-2']);
  });

  it('degrades non-object JSON to an empty list', () => {
    localStorage.setItem(KEY, '"oops"');
    initJobDescriptions();
    expect(getAllJobDescriptions()).toEqual([]);
  });
});


describe('a job save that the disk refuses LATE', () => {
  // The browser's quota throw is synchronous and the existing catch covers it.
  // On a device the write is behind the coalescing drain, so `setItem` answers
  // from memory and the refusal arrives long afterwards — which is every
  // refusal there is on the platform the Jobs sheet is native on.
  let refusedKey = null;

  const backend = () => ({
    loadAll: vi.fn(async () => ({})),
    write: vi.fn(async (key) => {
      if (key === refusedKey) throw new Error('no space left on device');
    }),
    delete: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  });

  beforeEach(async () => {
    __resetAppStorageForTests();
    setProfileMapping(null);
    refusedKey = null;
    await initAppStorage({ backend: backend() });
    initJobDescriptions();
  });

  afterEach(() => { __resetAppStorageForTests(); });

  it('reports the failure instead of claiming the cache took it', async () => {
    refusedKey = KEY;
    addJobDescription({ title: 'PM', description: 'Ship' });

    // Straight after the call the write has only been accepted by the cache —
    // nothing is known yet, and claiming success here is the bug.
    await appStorage.flush();

    expect(jobStorageFailed()).toBe(true);
  });

  it('stays quiet when the write lands', async () => {
    addJobDescription({ title: 'PM', description: 'Ship' });
    await appStorage.flush();

    expect(jobStorageFailed()).toBe(false);
    // Not a count: this module's in-memory list is module state and survives
    // between cases here, so a total would be asserting test isolation rather
    // than the write.
    expect(getAllJobDescriptions().some((j) => j.title === 'PM')).toBe(true);
  });

  it('is not armed by some OTHER key being refused', async () => {
    refusedKey = 'resume-designer-applications';
    addJobDescription({ title: 'PM', description: 'Ship' });
    appStorage.setItem('resume-designer-applications', '[]');
    await appStorage.flush();

    expect(jobStorageFailed()).toBe(false);
  });
});
