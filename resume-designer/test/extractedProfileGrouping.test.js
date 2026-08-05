import { describe, it, expect, beforeEach } from 'vitest';
import { saveExtractedProfile } from '../src/aiService.js';
import { getUserProfile, saveUserProfile } from '../src/persistence.js';

// Regression tests for saveExtractedProfile's company-run grouping (Codex P2):
// assignGroupIds must run ONLY over the entries a single extraction produces,
// BEFORE they're concatenated onto the existing profile — never over the
// merged array. Running it on the merged array would re-decide grouping for
// history the user already curated: two adjacent same-company cards left
// deliberately unlinked would silently fuse into one employer block, and it
// would happen on every save, even a skills-only one that touched no
// workExperience at all.
//
// jsdom leaves appStorage in localStorage passthrough (see catalogCache.test.js),
// so seeding via saveUserProfile / reading via getUserProfile exercises the
// same storage path saveExtractedProfile itself uses.

beforeEach(() => {
  localStorage.clear();
});

function ungroupedPair(company) {
  return [
    { company, title: 'Engineer', dates: '2020-2021' },
    { company, title: 'Senior Engineer', dates: '2021-2022' },
  ];
}

describe('saveExtractedProfile / company-run grouping', () => {
  it('does not fuse a pre-existing, deliberately-unlinked adjacent pair on a skills-only extraction', () => {
    saveUserProfile({ workExperience: ungroupedPair('Acme') });

    saveExtractedProfile({ skills: ['TypeScript'] });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBeFalsy();
    expect(workExperience[1]._groupId).toBeFalsy();
    expect(workExperience[0].company).toBe('Acme');
    expect(workExperience[1].company).toBe('Acme');
  });

  it('does not fuse a pre-existing pair when the extraction carries an empty workExperience array', () => {
    saveUserProfile({ workExperience: ungroupedPair('Acme') });

    saveExtractedProfile({ workExperience: [] });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBeFalsy();
    expect(workExperience[1]._groupId).toBeFalsy();
  });

  it('still groups an adjacent same-company pair the extraction itself produces', () => {
    saveExtractedProfile({ workExperience: ungroupedPair('Globex') });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBeTruthy();
    expect(workExperience[0]._groupId).toBe(workExperience[1]._groupId);
  });

  it('groups only the new pair, leaving a pre-existing ungrouped pair untouched and unshared', () => {
    saveUserProfile({ workExperience: ungroupedPair('Acme') });

    saveExtractedProfile({ workExperience: ungroupedPair('Globex') });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(4);

    const [acme1, acme2, globex1, globex2] = workExperience;
    expect(acme1._groupId).toBeFalsy();
    expect(acme2._groupId).toBeFalsy();
    expect(globex1._groupId).toBeTruthy();
    expect(globex1._groupId).toBe(globex2._groupId);
    // No id crosses the boundary between the pre-existing and new entries.
    expect(globex1._groupId).not.toBe(acme1._groupId);
    expect(globex1._groupId).not.toBe(acme2._groupId);
  });

  it('leaves an existing shared _groupId untouched by an unrelated extraction', () => {
    const grouped = ungroupedPair('Initech');
    grouped[0]._groupId = 'grp-existing';
    grouped[1]._groupId = 'grp-existing';
    saveUserProfile({ workExperience: grouped });

    saveExtractedProfile({ skills: ['SQL'] });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBe('grp-existing');
    expect(workExperience[1]._groupId).toBe('grp-existing');
  });
});
