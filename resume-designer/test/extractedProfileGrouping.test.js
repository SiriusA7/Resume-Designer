import { describe, it, expect, beforeEach } from 'vitest';
import { saveExtractedProfile } from '../src/aiService.js';
import { getUserProfile, saveUserProfile } from '../src/persistence.js';

// Regression tests for saveExtractedProfile and company-run grouping.
//
// The extraction path derives NO grouping at all. Adjacency alone cannot tell a
// promotion from a return to a former employer, and the profile entry shape
// ({ title, company, dates, details }) carries no machine-readable date to gate
// on, so an interview reporting two stints at one employer would otherwise mint
// one id spanning both and print a header asserting continuous employment that
// never happened. Ungrouped is plainer but never false; the user links roles
// with the Profile tab's "Link to company above".
//
// The original Codex P2 regression still holds a fortiori: nothing may re-decide
// grouping for history the user already curated — two adjacent same-company
// cards left deliberately unlinked must not fuse, on any save, including a
// skills-only one that touched no workExperience at all.
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

  it('does not group an adjacent same-company pair the extraction itself produces', () => {
    saveExtractedProfile({ workExperience: ungroupedPair('Globex') });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBeFalsy();
    expect(workExperience[1]._groupId).toBeFalsy();
  });

  // The finding: a boomerang. Adjacency would fuse these two tenures into one
  // header spanning 2015-2024, and the freeform `dates` strings are the only
  // evidence of the six-year gap — unreadable by any gate this schema can carry.
  it('does not group two same-company stints separated by a gap in their dates', () => {
    saveExtractedProfile({
      workExperience: [
        { company: 'Acme', title: 'Engineer', dates: 'Jan 2015 - Jun 2018' },
        { company: 'Acme', title: 'Staff Engineer', dates: 'Mar 2024 - Present' },
      ],
    });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(2);
    expect(workExperience[0]._groupId).toBeFalsy();
    expect(workExperience[1]._groupId).toBeFalsy();
  });

  it('leaves a pre-existing ungrouped pair untouched when new entries arrive', () => {
    saveUserProfile({ workExperience: ungroupedPair('Acme') });

    saveExtractedProfile({ workExperience: ungroupedPair('Globex') });

    const { workExperience } = getUserProfile();
    expect(workExperience).toHaveLength(4);

    // Nothing anywhere in the merged array carries a derived id, so no id can
    // cross the boundary between the pre-existing and the new entries.
    for (const entry of workExperience) expect(entry._groupId).toBeFalsy();
    expect(workExperience.map((e) => e.company)).toEqual(['Acme', 'Acme', 'Globex', 'Globex']);
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
