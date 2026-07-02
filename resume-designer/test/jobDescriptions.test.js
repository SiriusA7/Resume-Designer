// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { initJobDescriptions, getAllJobDescriptions } from '../src/jobDescriptions.js';

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
