import { describe, it, expect } from 'vitest';
import {
  effectiveAttempt2At,
  formatCzk,
  formatPragueDateTime,
  payLaterSchedule,
  pragueDateOf,
  pragueTimeToUtc,
  withinFreeCancellation,
} from './dates';

// Projects/PayLater/contract.md §1 — the rental site runs the same table.
const FIXTURES: Array<{
  name: string;
  arrival: string;
  departure: string;
  now: string;
  window: number;
  deadline: string;
  attempt1At: string;
  attempt2At: string;
  reminderAt: string | null;
  qualifies: boolean;
}> = [
  { name: '1 base', arrival: '2026-12-10', departure: '2026-12-13', now: '2026-11-10T10:00:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: '2026-11-28T08:00:00.000Z', qualifies: true },
  { name: '2 seven nights', arrival: '2027-01-20', departure: '2027-01-27', now: '2026-12-01T12:00:00Z', window: 14, deadline: '2027-01-06', attempt1At: '2027-01-04T07:00:00.000Z', attempt2At: '2027-01-05T15:00:00.000Z', reminderAt: '2027-01-01T08:00:00.000Z', qualifies: true },
  { name: '3 summer time', arrival: '2027-07-15', departure: '2027-07-18', now: '2027-06-01T08:00:00Z', window: 7, deadline: '2027-07-08', attempt1At: '2027-07-06T06:00:00.000Z', attempt2At: '2027-07-07T14:00:00.000Z', reminderAt: '2027-07-03T07:00:00.000Z', qualifies: true },
  { name: '4 DST starts 28 Mar', arrival: '2027-04-06', departure: '2027-04-09', now: '2027-03-01T08:00:00Z', window: 7, deadline: '2027-03-30', attempt1At: '2027-03-28T06:00:00.000Z', attempt2At: '2027-03-29T14:00:00.000Z', reminderAt: '2027-03-25T08:00:00.000Z', qualifies: true },
  { name: '5 DST ends 25 Oct', arrival: '2026-11-03', departure: '2026-11-05', now: '2026-10-01T08:00:00Z', window: 7, deadline: '2026-10-27', attempt1At: '2026-10-25T07:00:00.000Z', attempt2At: '2026-10-26T15:00:00.000Z', reminderAt: '2026-10-22T07:00:00.000Z', qualifies: true },
  { name: '6 year end', arrival: '2027-01-05', departure: '2027-01-07', now: '2026-12-01T08:00:00Z', window: 7, deadline: '2026-12-29', attempt1At: '2026-12-27T07:00:00.000Z', attempt2At: '2026-12-28T15:00:00.000Z', reminderAt: '2026-12-24T08:00:00.000Z', qualifies: true },
  { name: '7 six nights', arrival: '2026-12-10', departure: '2026-12-16', now: '2026-11-10T10:00:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: '2026-11-28T08:00:00.000Z', qualifies: true },
  { name: '8 last minute to qualify', arrival: '2026-12-10', departure: '2026-12-13', now: '2026-11-30T22:59:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: null, qualifies: true },
  { name: '9 too late', arrival: '2026-12-10', departure: '2026-12-13', now: '2026-11-30T23:00:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: null, qualifies: false },
  { name: '10 reminder < 24 h away', arrival: '2026-12-10', departure: '2026-12-13', now: '2026-11-27T12:00:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: null, qualifies: true },
  { name: '11 reminder just over 24 h', arrival: '2026-12-10', departure: '2026-12-13', now: '2026-11-27T07:59:00Z', window: 7, deadline: '2026-12-03', attempt1At: '2026-12-01T07:00:00.000Z', attempt2At: '2026-12-02T15:00:00.000Z', reminderAt: '2026-11-28T08:00:00.000Z', qualifies: true },
];

describe('payLaterSchedule — contract fixtures', () => {
  for (const f of FIXTURES) {
    it(f.name, () => {
      const s = payLaterSchedule(f.arrival, f.departure, new Date(f.now));
      expect(s).not.toBeNull();
      expect(s!.windowDays).toBe(f.window);
      expect(s!.deadlineDate).toBe(f.deadline);
      expect(s!.attempt1At.toISOString()).toBe(f.attempt1At);
      expect(s!.attempt2At.toISOString()).toBe(f.attempt2At);
      expect(s!.reminderAt?.toISOString() ?? null).toBe(f.reminderAt);
      expect(s!.qualifies).toBe(f.qualifies);
    });
  }

  it('rejects impossible stays', () => {
    expect(payLaterSchedule('2026-12-10', '2026-12-10', new Date())).toBeNull();
    expect(payLaterSchedule('2026-12-10', '2026-12-09', new Date())).toBeNull();
    expect(payLaterSchedule('10.12.2026', '2026-12-13', new Date())).toBeNull();
  });
});

describe('Prague time helpers', () => {
  it('converts wall-clock times through CET and CEST', () => {
    expect(pragueTimeToUtc('2026-12-01', 8).toISOString()).toBe('2026-12-01T07:00:00.000Z');
    expect(pragueTimeToUtc('2027-07-06', 8).toISOString()).toBe('2027-07-06T06:00:00.000Z');
  });

  it('dates instants in Prague, not UTC', () => {
    expect(pragueDateOf(new Date('2026-11-30T22:59:00Z'))).toBe('2026-11-30');
    expect(pragueDateOf(new Date('2026-11-30T23:00:00Z'))).toBe('2026-12-01');
  });

  it('free cancellation runs to 23:59 Prague on the deadline day', () => {
    expect(withinFreeCancellation('2026-12-03', new Date('2026-12-03T22:59:00Z'))).toBe(true);
    expect(withinFreeCancellation('2026-12-03', new Date('2026-12-03T23:00:00Z'))).toBe(false);
  });

  it('formats for guests', () => {
    expect(formatPragueDateTime(new Date('2026-12-02T15:00:00.000Z'), 'cs')).toBe('2. 12. 2026 v 16:00');
    expect(formatPragueDateTime(new Date('2026-12-02T15:00:00.000Z'), 'en')).toBe('2 December 2026 at 16:00');
    expect(formatCzk(1234500).replace(/\s/g, ' ')).toBe('12 345 Kč');
    expect(formatCzk(1234550).replace(/\s/g, ' ')).toBe('12 345,50 Kč');
  });
});

describe('effectiveAttempt2At', () => {
  const planned = new Date('2026-12-02T15:00:00.000Z');

  it('keeps the planned time when the 1st decline was on schedule', () => {
    expect(effectiveAttempt2At(planned, new Date('2026-12-01T07:10:00Z')).toISOString()).toBe(planned.toISOString());
  });

  it('pushes the 2nd attempt to 20 h after a late 1st decline', () => {
    expect(effectiveAttempt2At(planned, new Date('2026-12-02T10:00:00Z')).toISOString()).toBe('2026-12-03T06:00:00.000Z');
  });

  it('is the planned time when nothing was declined yet', () => {
    expect(effectiveAttempt2At(planned, null).toISOString()).toBe(planned.toISOString());
  });
});
