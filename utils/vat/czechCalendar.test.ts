import { describe, it, expect } from 'vitest';
import { easterSunday, filingDeadline, isValidIsoDate, isValidMonth, isWorkingDay, monthEnd, nextMonth, prevMonth } from './czechCalendar';

describe('vat/czechCalendar', () => {
  it('computes Easter', () => {
    expect(easterSunday(2026)).toBe('2026-04-05');
    expect(easterSunday(2027)).toBe('2027-03-28');
  });

  it('knows weekends and Czech public holidays', () => {
    expect(isWorkingDay('2027-03-26')).toBe(false); // Good Friday
    expect(isWorkingDay('2027-03-29')).toBe(false); // Easter Monday
    expect(isWorkingDay('2027-09-28')).toBe(false); // St Wenceslas
    expect(isWorkingDay('2027-12-24')).toBe(false);
    expect(isWorkingDay('2027-02-25')).toBe(true);
  });

  it('moves the 25th to the next working day', () => {
    expect(filingDeadline('2027-01')).toBe('2027-02-25');
    expect(filingDeadline('2027-03')).toBe('2027-04-26'); // 25 Apr is a Sunday
    expect(filingDeadline('2027-08')).toBe('2027-09-27'); // Saturday
    expect(filingDeadline('2027-11')).toBe('2027-12-27'); // Saturday + Christmas
    expect(filingDeadline('2027-12')).toBe('2028-01-25');
    expect(filingDeadline('2026-09')).toBe('2026-10-26'); // Sunday
  });

  it('handles month arithmetic and validation', () => {
    expect(nextMonth('2026-12')).toBe('2027-01');
    expect(prevMonth('2027-01')).toBe('2026-12');
    expect(monthEnd('2028-02')).toBe('2028-02-29');
    expect(isValidMonth('2027-13')).toBe(false);
    expect(isValidMonth('2027-07')).toBe(true);
    expect(isValidIsoDate('2027-02-30')).toBe(false);
    expect(isValidIsoDate('2027-02-28')).toBe(true);
  });
});
