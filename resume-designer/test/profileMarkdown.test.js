import { describe, it, expect } from 'vitest';
import { markdownToProfile, profileToMarkdown, DEFAULT_PROFILE } from '../src/profileMarkdown.js';

const md = (work) => `# User Profile

## Work Experience

${work}

## Skills

| Skill | Proficiency | Years |
|-------|-------------|-------|
`;

describe('markdownToProfile — work experience', () => {
  it('parses title, company and dates', () => {
    const p = markdownToProfile(md('### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n'));
    expect(p.workExperience[0]).toMatchObject({
      title: 'Senior Dev', company: 'Acme Corporation', dates: 'Mar 2022 - Jun 2024',
    });
  });

  it('groups consecutive entries at an identical company', () => {
    const p = markdownToProfile(md(
      '### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n\n'
      + '### Dev at Acme Corporation\n**Dates:** Jan 2019 - Mar 2022\n\nBuilt things.\n',
    ));
    expect(p.workExperience[0]._groupId).toBeTruthy();
    expect(p.workExperience[0]._groupId).toBe(p.workExperience[1]._groupId);
  });

  it('gives every parsed entry a stable id', () => {
    const p = markdownToProfile(md('### Dev at Acme\n**Dates:** 2019 - 2022\n\nA.\n'));
    expect(typeof p.workExperience[0].id).toBe('string');
    expect(p.workExperience[0].id.length).toBeGreaterThan(0);
  });

  it('does not group different companies', () => {
    const p = markdownToProfile(md(
      '### Dev at Acme\n**Dates:** 2019 - 2022\n\nA.\n\n### Intern at Initech\n**Dates:** 2018\n\nB.\n',
    ));
    expect(p.workExperience[0]._groupId).toBeUndefined();
  });

  it('does not mutate DEFAULT_PROFILE across calls', () => {
    markdownToProfile(md('### Dev at Acme\n**Dates:** 2019 - 2022\n\nA.\n'));
    expect(DEFAULT_PROFILE.workExperience).toHaveLength(0);
  });
});

describe('profileToMarkdown', () => {
  it('round-trips a grouped pair back into a grouped pair', () => {
    const source = markdownToProfile(md(
      '### Senior Dev at Acme Corporation\n**Dates:** Mar 2022 - Jun 2024\n\nLed things.\n\n'
      + '### Dev at Acme Corporation\n**Dates:** Jan 2019 - Mar 2022\n\nBuilt things.\n',
    ));
    const reparsed = markdownToProfile(profileToMarkdown(source));
    expect(reparsed.workExperience).toHaveLength(2);
    expect(reparsed.workExperience[0]._groupId).toBe(reparsed.workExperience[1]._groupId);
  });
});
