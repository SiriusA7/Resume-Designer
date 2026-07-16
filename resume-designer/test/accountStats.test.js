import { describe, it, expect } from 'vitest';
import {
  profileInitials, profileCompleteness, formatRate, formatDays,
} from '../src/accountStats.js';

describe('profileInitials', () => {
  it('takes first+last initials, uppercased', () => {
    expect(profileInitials('Ash Shah')).toBe('AS');
    expect(profileInitials('mary jane watson')).toBe('MW'); // first + last
  });
  it('uses the first two letters for a single word', () => {
    expect(profileInitials('Partner')).toBe('PA');
  });
  it('falls back to ? for empty/blank names', () => {
    expect(profileInitials('')).toBe('?');
    expect(profileInitials('   ')).toBe('?');
    expect(profileInitials(null)).toBe('?');
  });
});

describe('profileCompleteness', () => {
  it('counts the filled key fields', () => {
    const r = profileCompleteness({
      personalSummary: 'hi',
      workExperience: [{}],
      skills: [],
      education: [],
    });
    expect(r.total).toBe(4);
    expect(r.done).toBe(2); // summary + experience
    expect(r.pct).toBe(50);
    expect(r.checks.find((c) => c.key === 'skills').done).toBe(false);
  });
  it('handles an empty profile', () => {
    const r = profileCompleteness({});
    expect(r.done).toBe(0);
    expect(r.pct).toBe(0);
  });
  it('treats a whitespace-only summary as unfilled', () => {
    expect(profileCompleteness({ personalSummary: '   ' }).done).toBe(0);
  });
});

describe('formatRate / formatDays', () => {
  it('formats rates as whole percents, — when null', () => {
    expect(formatRate(0.5)).toBe('50%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(null)).toBe('—');
  });
  it('formats days with pluralization, — when unknown', () => {
    expect(formatDays(1)).toBe('1 day');
    expect(formatDays(3.4)).toBe('3 days');
    expect(formatDays(null)).toBe('—');
  });
});
