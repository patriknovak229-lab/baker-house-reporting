import { describe, it, expect } from 'vitest';
import { addDays } from './corporateSchedule';
import {
  expectedCleaningCount,
  longestGapDays,
  normalizeDates,
  parseCleaningPlanInput,
  regularCleaningDates,
  suggestedAdhocDates,
} from './corporateCleaning';

// BH-96733484 (MITEA): Deluxe, 18 Dec 2026 → 1 Mar 2027, 73 nights.
const ARR = '2026-12-18';
const DEP = '2027-03-01';

describe('expectedCleaningCount', () => {
  it('MITEA 73 nights weekly → 10 (post-stay not counted)', () => {
    expect(expectedCleaningCount(73, 'weekly')).toBe(10);
  });
  it('one per started cycle after the first', () => {
    expect(expectedCleaningCount(7, 'weekly')).toBe(0);
    expect(expectedCleaningCount(8, 'weekly')).toBe(1);
    expect(expectedCleaningCount(14, 'weekly')).toBe(1);
    expect(expectedCleaningCount(15, 'weekly')).toBe(2);
    expect(expectedCleaningCount(73, 'biweekly')).toBe(5);
    expect(expectedCleaningCount(73, 'twice_weekly')).toBe(20);
    expect(expectedCleaningCount(1, 'twice_weekly')).toBe(0);
  });
});

describe('suggestedAdhocDates', () => {
  it('one date at the end of each cycle, gap never above 7', () => {
    const d = suggestedAdhocDates(ARR, DEP, 'weekly');
    expect(d).toHaveLength(10);
    expect(d[0]).toBe('2026-12-25');
    expect(longestGapDays(ARR, DEP, d)).toBeLessThanOrEqual(7);
  });
});

describe('longestGapDays', () => {
  it('counts arrival and checkout as clean', () => {
    expect(longestGapDays('2026-12-01', '2026-12-15', [])).toBe(14);
    expect(longestGapDays('2026-12-01', '2026-12-15', ['2026-12-08'])).toBe(7);
  });
  it('ignores dates outside the stay', () => {
    expect(normalizeDates('2026-12-01', '2026-12-15', ['2026-12-01', '2026-12-15', '2026-12-09', '2026-12-09'])).toEqual(['2026-12-09']);
  });
});

describe('parseCleaningPlanInput', () => {
  it('accepts a regular weekly plan', () => {
    const r = parseCleaningPlanInput({ frequency: 'weekly', mode: 'regular', weekdays: [4], dates: ['2026-12-24'] }, ARR, DEP);
    expect(r).toEqual({ ok: true, value: { frequency: 'weekly', mode: 'regular', weekdays: [4], dates: ['2026-12-24'] } });
  });
  it('needs two weekdays for twice a week', () => {
    expect(parseCleaningPlanInput({ frequency: 'twice_weekly', mode: 'regular', weekdays: [1], dates: [] }, ARR, DEP).ok).toBe(false);
  });
  it('refuses arrival / checkout day', () => {
    expect(parseCleaningPlanInput({ frequency: 'weekly', mode: 'adhoc', dates: [DEP] }, ARR, DEP).ok).toBe(false);
  });
  it('drops weekdays on ad hoc and empty boxes', () => {
    const r = parseCleaningPlanInput({ frequency: 'weekly', mode: 'adhoc', weekdays: [3], dates: ['', '2027-01-02'] }, ARR, DEP);
    expect(r).toEqual({ ok: true, value: { frequency: 'weekly', mode: 'adhoc', weekdays: [], dates: ['2027-01-02'] } });
  });
});

describe('regularCleaningDates', () => {
  // Patrik's Tuesday table: days from arrival to the first cleaning.
  // 2026-12-14 is a Monday.
  it.each([
    ['Mon', '2026-12-14', 8],
    ['Tue', '2026-12-15', 7],
    ['Wed', '2026-12-16', 6],
    ['Thu', '2026-12-17', 5],
    ['Fri', '2026-12-18', 4],
    ['Sat', '2026-12-19', 10],
    ['Sun', '2026-12-20', 9],
  ])('every Tuesday, arrive %s → first cleaning after %i days', (_d, arrival, days) => {
    const dates = regularCleaningDates(arrival, '2027-02-01', 'weekly', [2]);
    expect(dates[0]).toBe(addDays(arrival, days));
    for (let i = 1; i < dates.length; i++) expect(addDays(dates[i - 1], 7)).toBe(dates[i]);
  });
  it('MITEA BH-96733484 every Tuesday: 22 Dec … 23 Feb, 10 cleanings', () => {
    const d = regularCleaningDates(ARR, DEP, 'weekly', [2]);
    expect(d[0]).toBe('2026-12-22');
    expect(d.at(-1)).toBe('2027-02-23');
    expect(d).toHaveLength(10);
  });
  it('never on checkout day', () => {
    expect(regularCleaningDates('2026-12-15', '2026-12-22', 'weekly', [2])).toEqual([]);
  });
  it('every 2 weeks: every second occurrence', () => {
    const d = regularCleaningDates(ARR, DEP, 'biweekly', [2]);
    expect(d[0]).toBe('2026-12-29'); // Tue 22 Dec is only 4 days in, under the 7-day minimum
    for (let i = 1; i < d.length; i++) expect(addDays(d[i - 1], 14)).toBe(d[i]);
  });
  it('twice a week: both weekdays, first at least 2 days in', () => {
    const d = regularCleaningDates('2026-12-14', '2026-12-28', 'twice_weekly', [2, 5]); // Mon arrival
    expect(d).toEqual(['2026-12-18', '2026-12-22', '2026-12-25']);
  });
});
