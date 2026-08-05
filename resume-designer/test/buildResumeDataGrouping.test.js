import { describe, it, expect, vi } from 'vitest';

// onboardingLogic statically imports resumeParser, whose pdfjs-dist import needs
// browser APIs (DOMMatrix) jsdom doesn't have. buildResumeData never touches the
// parser, so stub the module out.
vi.mock('../src/resumeParser.js', () => ({
  parseResumeText: vi.fn(),
  parseResumeFile: vi.fn(),
}));

const { buildResumeData } = await import('../src/onboardingLogic.js');
const { groupExperience } = await import('../src/experienceGroups.js');

// End-to-end over the REAL buildResumeData: the generation path must never mint a
// group id that asserts continuous employment the dates do not support. All data
// below is fabricated.

const bullets = ['Fabricated bullet for the test.'];

describe('buildResumeData grouping gate', () => {
  it('does not fuse two Acme stints when the intervening job was omitted', () => {
    // The AI dropped the role held between the two stints because it was not
    // relevant to the target job, leaving them ADJACENT in its output.
    const result = buildResumeData({
      name: 'Jordan Sample',
      experience: [
        { title: 'Staff Eng', company: 'Acme', startDate: '2021-03', endDate: 'Present', dates: 'Mar 2021 – Present', bullets },
        { title: 'Sr Eng', company: 'Acme', startDate: '2015-01', endDate: '2018-06', dates: 'Jan 2015 – Jun 2018', bullets },
      ],
    });

    expect(result.experience.map((x) => x._groupId)).toEqual([undefined, undefined]);
    // Assert against the renderer's own view, not just the field.
    expect(groupExperience(result.experience)).toHaveLength(2);
  });

  it('still groups a genuine promotion, and the sort keeps the run intact', () => {
    const result = buildResumeData({
      name: 'Jordan Sample',
      experience: [
        { title: 'Staff Eng', company: 'Acme', startDate: '2021-03', endDate: 'Present', dates: 'Mar 2021 – Present', bullets },
        { title: 'Sr Eng', company: 'Acme', startDate: '2018-07', endDate: '2021-02', dates: 'Jul 2018 – Feb 2021', bullets },
        { title: 'Consultant', company: 'Initech', startDate: '2016-01', endDate: '2018-06', dates: 'Jan 2016 – Jun 2018', bullets },
      ],
    });

    const groups = groupExperience(result.experience);
    expect(groups).toHaveLength(2);
    expect(groups[0].company).toBe('Acme');
    expect(groups[0].roles).toHaveLength(2);
    const ids = groups[0].roles.map((r) => r.entry._groupId);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBe(ids[0]);
    // Chronological sorting must not shred the run apart.
    expect(result.experience.map((x) => x.company)).toEqual(['Acme', 'Acme', 'Initech']);
  });

  it('mints no id for free-text dates (the import path degrades safely)', () => {
    // parseResumeWithAI's schema asks only for human-readable dates, so this shape
    // reaches buildResumeData on the paste/upload path. Refusing to group here is a
    // deliberate, documented capability loss, not a bug: it is exactly the path
    // where the user's own resume most often omits an intervening job, and an
    // ungrouped resume is plainer but never false.
    const result = buildResumeData({
      name: 'Jordan Sample',
      experience: [
        { title: 'Senior Dev', company: 'Acme', startDate: 'April 2022', endDate: 'Present', dates: 'Apr 2022 – Present', bullets },
        { title: 'Dev', company: 'Acme', startDate: 'January 2019', endDate: 'March 2022', dates: 'Jan 2019 – Mar 2022', bullets },
      ],
    });

    expect(result.experience.every((x) => x._groupId === undefined)).toBe(true);
  });

  it('mints no id and does not throw when entries carry no dates at all', () => {
    const result = buildResumeData({
      name: 'Jordan Sample',
      experience: [
        { title: 'Senior Dev', company: 'Acme', dates: '2022 – 2024', bullets },
        { title: 'Dev', company: 'Acme', dates: '2019 – 2022', bullets },
      ],
    });

    expect(result.experience).toHaveLength(2);
    expect(result.experience.every((x) => x._groupId === undefined)).toBe(true);
  });
});
