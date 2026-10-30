import { describe, it, expect } from 'vitest';
import { isGridDue, isoWeekday } from './parityGridSchedule';

const MONDAY = { gridWeekday: 1, gridMaxGapDays: 7 };

describe('isoWeekday', () => {
  it('maps Monday to 1 and Sunday to 7', () => {
    expect(isoWeekday('2026-11-02')).toBe(1);
    expect(isoWeekday('2026-11-08')).toBe(7);
  });
});

describe('isGridDue (weekly, Monday)', () => {
  it('is due when there has never been a grid run', () => {
    expect(isGridDue(null, '2026-11-04', MONDAY)).toBe(true);
  });

  it('is due on Monday when the last run was last week', () => {
    expect(isGridDue('2026-10-26', '2026-11-02', MONDAY)).toBe(true);
  });

  it('is not due again on the Monday it already ran', () => {
    expect(isGridDue('2026-11-02', '2026-11-02', MONDAY)).toBe(false);
  });

  it('is not due mid-week after a Monday run', () => {
    expect(isGridDue('2026-11-02', '2026-11-03', MONDAY)).toBe(false);
    expect(isGridDue('2026-11-02', '2026-11-08', MONDAY)).toBe(false);
  });

  it('catches up the day after a missed Monday, then stays on Mondays', () => {
    // Last run Mon 26 Oct, Mac asleep on Mon 2 Nov → Tue 3 Nov is 8 days on.
    expect(isGridDue('2026-10-26', '2026-11-03', MONDAY)).toBe(true);
    // Ran Tue 3 Nov → nothing until Monday 9 Nov.
    expect(isGridDue('2026-11-03', '2026-11-06', MONDAY)).toBe(false);
    expect(isGridDue('2026-11-03', '2026-11-09', MONDAY)).toBe(true);
  });

  it('runs on the first Monday after switching from the daily cadence', () => {
    // Last daily run was Fri 30 Oct 2026.
    expect(isGridDue('2026-10-30', '2026-10-31', MONDAY)).toBe(false);
    expect(isGridDue('2026-10-30', '2026-11-02', MONDAY)).toBe(true);
  });
});
