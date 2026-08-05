import { describe, it, expect } from 'vitest';
import {
  MONTH_NAMES, RANGE_SEPARATOR, ONGOING_LABEL,
  formatMonthYear, toMonth, formatMonthField,
  readEntryDates, buildDateFields, freeformDateFields, formatIntervalHint,
} from '../src/experienceDates.js';
import { datesAreContinuous } from '../src/experienceGroups.js';

describe('formatMonthYear', () => {
  it('formats from the hardcoded table, not the host locale', () => {
    expect(formatMonthYear(2020, 1)).toBe('Jan 2020');
    expect(formatMonthYear(2020, 12)).toBe('Dec 2020');
  });

  it('returns empty for an out-of-range month', () => {
    expect(formatMonthYear(2020, 0)).toBe('');
    expect(formatMonthYear(2020, 13)).toBe('');
  });

  it('exposes exactly twelve month names', () => {
    expect(MONTH_NAMES).toHaveLength(12);
  });
});

describe('toMonth', () => {
  it('reads a strict YYYY-MM', () => {
    expect(toMonth('2020-01')).toEqual({ year: 2020, month: 1 });
  });

  it('round-trips December, the boundary the year arithmetic gets wrong', () => {
    expect(toMonth('2020-12')).toEqual({ year: 2020, month: 12 });
    expect(toMonth('2021-01')).toEqual({ year: 2021, month: 1 });
  });

  it('refuses anything that is not YYYY-MM', () => {
    expect(toMonth('2020')).toBeNull();
    expect(toMonth('Jan 2020')).toBeNull();
    expect(toMonth('2020-13')).toBeNull();
    expect(toMonth('Present')).toBeNull();
    expect(toMonth(undefined)).toBeNull();
  });

  it('is the exact inverse of formatMonthField', () => {
    expect(formatMonthField({ year: 2020, month: 3 })).toBe('2020-03');
    expect(toMonth(formatMonthField({ year: 1999, month: 11 }))).toEqual({ year: 1999, month: 11 });
  });
});

describe('readEntryDates', () => {
  it('reads a closed structured range', () => {
    expect(readEntryDates({ startDate: '2020-01', endDate: '2022-03' })).toEqual({
      start: { year: 2020, month: 1 }, end: { year: 2022, month: 3 }, ongoing: false, freeform: false,
    });
  });

  it('reads an ongoing range', () => {
    expect(readEntryDates({ startDate: '2020-01', endDate: 'Present' })).toEqual({
      start: { year: 2020, month: 1 }, end: null, ongoing: true, freeform: false,
    });
  });

  it('reports freeform when the pair is missing or unreadable', () => {
    expect(readEntryDates({ dates: 'Summer 2019' }).freeform).toBe(true);
    expect(readEntryDates({ startDate: '2019', endDate: '2021' }).freeform).toBe(true);
  });

  it('reports freeform for a half pair rather than a lone start', () => {
    expect(readEntryDates({ startDate: '2020-01' }).freeform).toBe(true);
  });

  it('never recovers a month from the display string', () => {
    expect(readEntryDates({ dates: 'Jan 2020 – Mar 2022' }).freeform).toBe(true);
  });

  it('reports freeform for a reversed closed pair, which interval() would refuse', () => {
    expect(readEntryDates({ startDate: '2022-03', endDate: '2020-01' }).freeform).toBe(true);
  });
});

describe('buildDateFields', () => {
  it('writes all three fields for a closed range', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: { year: 2022, month: 3 }, ongoing: false })).toEqual({
      dates: `Jan 2020 ${RANGE_SEPARATOR} Mar 2022`, startDate: '2020-01', endDate: '2022-03',
    });
  });

  it('writes the ongoing label rather than a month', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: true })).toEqual({
      dates: `Jan 2020 ${RANGE_SEPARATOR} ${ONGOING_LABEL}`, startDate: '2020-01', endDate: ONGOING_LABEL,
    });
  });

  it('uses an en dash, not a hyphen', () => {
    const built = buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: true });
    expect(built.dates).toContain('–');
    expect(built.dates).not.toContain(' - ');
  });

  it('returns null rather than writing half a pair', () => {
    expect(buildDateFields({ start: { year: 2020, month: 1 }, end: null, ongoing: false })).toBeNull();
    expect(buildDateFields({ start: null, end: { year: 2022, month: 3 }, ongoing: false })).toBeNull();
    expect(buildDateFields(null)).toBeNull();
  });

  it('refuses a reversed range, which interval() would reject anyway', () => {
    expect(buildDateFields({ start: { year: 2022, month: 3 }, end: { year: 2020, month: 1 }, ongoing: false })).toBeNull();
  });

  it('allows a single-month range', () => {
    const built = buildDateFields({ start: { year: 2020, month: 6 }, end: { year: 2020, month: 6 }, ongoing: false });
    expect(built.startDate).toBe('2020-06');
    expect(built.endDate).toBe('2020-06');
  });
});

describe('freeformDateFields', () => {
  it('keeps the text and clears the machine-readable pair (R2)', () => {
    expect(freeformDateFields('Summer 2019')).toEqual({ dates: 'Summer 2019', startDate: '', endDate: '' });
  });

  it('coerces a nullish value to an empty string', () => {
    expect(freeformDateFields(undefined)).toEqual({ dates: '', startDate: '', endDate: '' });
  });
});

// The point of the whole feature: what the picker writes must be readable by
// the gate that decides whether two roles are one tenure.
describe('agreement with the run gate', () => {
  const built = (sy, sm, ey, em) => buildDateFields({
    start: { year: sy, month: sm },
    end: ey === null ? null : { year: ey, month: em },
    ongoing: ey === null,
  });

  it('treats immediate succession as one continuous tenure', () => {
    expect(datesAreContinuous(built(2019, 1, 2021, 6), built(2021, 7, null))).toBe(true);
  });

  it('treats a real gap as a separate stint', () => {
    expect(datesAreContinuous(built(2015, 1, 2018, 6), built(2021, 3, null))).toBe(false);
    // Pin the false to the gap, not to unreadability — datesAreContinuous also
    // fails closed to false when a pair can't be read at all.
    expect(readEntryDates(built(2015, 1, 2018, 6)).freeform).toBe(false);
  });

  it('leaves a freeform entry unjoinable', () => {
    expect(datesAreContinuous(built(2019, 1, 2021, 6), freeformDateFields('2021 – 2024'))).toBe(false);
  });
});

describe('formatIntervalHint', () => {
  it('emits the closed interval', () => {
    expect(formatIntervalHint({ startDate: '2020-01', endDate: '2022-03' })).toBe(' [2020-01 → 2022-03]');
  });

  it('emits a lowercase present for an ongoing role', () => {
    expect(formatIntervalHint({ startDate: '2020-01', endDate: 'Present' })).toBe(' [2020-01 → present]');
  });

  it('emits nothing for a freeform entry', () => {
    expect(formatIntervalHint({ dates: 'Summer 2019' })).toBe('');
  });

  it('emits nothing for a reversed pair', () => {
    expect(formatIntervalHint({ startDate: '2022-03', endDate: '2020-01' })).toBe('');
  });
});
