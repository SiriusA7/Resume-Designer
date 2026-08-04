import { describe, it, expect } from 'vitest';
import { parseResume } from '../src/parser.js';

const doc = (experience) => `# Jane Doe
**Product Designer**

## Experience

${experience}
`;

describe('parseResume — experience entries', () => {
  it('splits title and company on the em dash', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].title).toBe('Senior Dev');
    expect(r.experience[0].company).toBe('Acme Corporation');
  });

  it('reads the dates from the bold line, not the heading', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].dates).toBe('Mar 2022 – Jun 2024');
  });

  it('also reads dates written inline on the heading (what the exporter emits)', () => {
    const r = parseResume(doc('### Senior Dev — Acme Corporation **Mar 2022 – Jun 2024**\n- shipped a thing\n'));
    expect(r.experience[0].company).toBe('Acme Corporation');
    expect(r.experience[0].dates).toBe('Mar 2022 – Jun 2024');
  });

  it('collects bullets', () => {
    const r = parseResume(doc('### Dev — Acme\n**2019 – 2022**\n- one\n- two\n'));
    expect(r.experience[0].bullets).toHaveLength(2);
  });

  it('gives every entry a stable id', () => {
    const r = parseResume(doc('### Dev — Acme\n**2019 – 2022**\n- one\n'));
    expect(typeof r.experience[0].id).toBe('string');
    expect(r.experience[0].id.length).toBeGreaterThan(0);
  });

  it('does not steal the first experience date line as the tagline', () => {
    const r = parseResume(`# Jane Doe

## Experience

### Dev — Acme
**2020 – Present**
- one
`);
    expect(r.experience[0].dates).toBe('2020 – Present');
    expect(r.tagline).not.toBe('2020 – Present');
  });

  it('groups consecutive entries at an identical company', () => {
    const r = parseResume(doc(
      '### Senior Dev — Acme Corporation\n**Mar 2022 – Jun 2024**\n- a\n\n'
      + '### Dev — Acme Corporation\n**Jan 2019 – Mar 2022**\n- b\n\n'
      + '### Intern — Initech\n**2018**\n- c\n',
    ));
    expect(r.experience[0]._groupId).toBeTruthy();
    expect(r.experience[0]._groupId).toBe(r.experience[1]._groupId);
    expect(r.experience[2]._groupId).toBeUndefined();
  });

  it('does not group two non-adjacent stints at the same company', () => {
    const r = parseResume(doc(
      '### Staff — Acme\n**2023 – 2024**\n- a\n\n'
      + '### Consultant — Initech\n**2021 – 2023**\n- b\n\n'
      + '### Dev — Acme\n**2018 – 2020**\n- c\n',
    ));
    expect(r.experience[0]._groupId).toBeUndefined();
    expect(r.experience[2]._groupId).toBeUndefined();
  });
});
