import { describe, it, expect } from 'vitest';
import { getUserProfileContext } from '../src/aiService.js';

const profile = {
  workExperience: [
    { title: 'Senior Engineer', company: 'Acme', dates: 'Jan 2020 – Present', startDate: '2020-01', endDate: 'Present', details: 'Led the platform team.' },
    { title: 'Consultant', company: 'Globex', dates: 'Summer 2019', details: 'Short engagement.' },
  ],
};

describe('getUserProfileContext', () => {
  it('emits the exact interval for an entry that has one', () => {
    expect(getUserProfileContext(profile)).toContain('[2020-01 → present]');
  });

  it('emits nothing extra for a freeform entry', () => {
    const context = getUserProfileContext(profile);
    expect(context).toContain('Summer 2019');
    expect(context).not.toContain('[Summer');
  });

  it('keeps the human-readable dates alongside the interval', () => {
    expect(getUserProfileContext(profile)).toContain('(Jan 2020 – Present)');
  });
});
