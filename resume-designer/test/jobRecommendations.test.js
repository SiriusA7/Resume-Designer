// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';

import { store } from '../src/store.js';
import { applyRecommendationToStore } from '../src/jobRecommendations.js';
import { groupExperience } from '../src/experienceGroups.js';

// Regression for the Codex finding on the next→main flow: AI analysis items
// come from model JSON, so a recommendation may omit `section` — JobsDialog
// then passes undefined through, and the matcher used to throw on
// sectionName.includes(...) instead of returning false (which is what lets
// the UI show its "could not apply" toast).

beforeEach(() => {
  localStorage.clear();
  store.setData({ summary: 'old summary', experience: [], sections: [], contact: {} }, true);
});

describe('applyRecommendationToStore', () => {
  it('applies a direct-mapped section', () => {
    expect(applyRecommendationToStore('summary', 'old summary', 'new summary')).toBe(true);
    expect(store.getData().summary).toBe('new summary');
  });

  it('returns false instead of throwing when the section is missing', () => {
    expect(applyRecommendationToStore(undefined, 'x', 'y')).toBe(false);
    expect(applyRecommendationToStore(null, 'x', 'y')).toBe(false);
    expect(store.getData().summary).toBe('old summary'); // nothing written
  });
});

// Recommendations are a SECOND path into the store, separate from the change
// set. Its experience branch resolves a matched string to a store path, and
// that path can be `experience[i].company` — where a bare store.update renames a
// grouped employer's lead alone and splits the run — or `experience[i].dates`,
// where it strands the machine-readable pair on the old range.
describe('applyRecommendationToStore — grouped and dated experience writes', () => {
  const run = (company) => ([
    { id: 'a', company, title: 'Senior Engineer', dates: 'Mar 2022 – Present', startDate: '2022-03', endDate: 'Present', _groupId: 'g1', bullets: [] },
    { id: 'b', company, title: 'Engineer', dates: 'Jan 2020 – Mar 2022', startDate: '2020-01', endDate: '2022-03', _groupId: 'g1', bullets: [] },
  ]);

  beforeEach(() => {
    store.setData({ name: 'Ada', experience: run('Acme'), sections: [] }, true, null);
  });

  it('fans a recommended company rename across the whole run', () => {
    expect(applyRecommendationToStore('work experience', 'Acme', 'Acme Corp')).toBe(true);

    expect(store.get('experience').map((e) => e.company)).toEqual(['Acme Corp', 'Acme Corp']);
  });

  it('keeps the employer run intact, which a bare store.update would not', () => {
    applyRecommendationToStore('work experience', 'Acme', 'Acme Corp');

    expect(groupExperience(store.get('experience'))).toHaveLength(1);
  });

  it('cannot reach the dates field at all, so the pair is never stranded', () => {
    // findInExperience matches title, company and bullets — never `dates` — and
    // findTextAnywhere delegates experience matching to it. Pinned so that if the
    // matcher ever gains a dates branch, this fails and whoever adds it sees that
    // the shared writer (which clears the pair) is already in place for it.
    expect(applyRecommendationToStore('experience', 'Jan 2020 – Mar 2022', '2019 – 2022')).toBe(false);

    const role = store.get('experience')[1];
    expect(role.dates).toBe('Jan 2020 – Mar 2022');
    expect(role.startDate).toBe('2020-01');
  });

  it('still writes an ordinary experience scalar untouched', () => {
    expect(applyRecommendationToStore('work experience', 'Engineer', 'Software Engineer')).toBe(true);

    expect(store.get('experience')[1].title).toBe('Software Engineer');
    expect(store.get('experience').map((e) => e.company)).toEqual(['Acme', 'Acme']);
  });
});
