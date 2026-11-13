import { describe, it, expect } from 'vitest';
import { canAutoCancel, depositsFor, dueStep, overdueSchedules, retryBackoffMs, type ScheduleCore } from './rules';

// Patrik's example: arrival 10 Dec, 3 nights → deadline 3 Dec.
const base: ScheduleCore & { id: string } = {
  id: 'WP-1',
  status: 'scheduled',
  reminderAt: '2026-11-28T08:00:00.000Z',
  attempt1At: '2026-12-01T07:00:00.000Z',
  attempt2At: '2026-12-02T15:00:00.000Z',
  firstDeclineAt: null,
  autoDeclines: 0,
  emails: {},
  deadlineDate: '2026-12-03',
  noAutoCancel: false,
  retryNotBefore: null,
};
const at = (iso: string) => new Date(iso);

describe('dueStep — the timeline', () => {
  it('nothing before the reminder', () => {
    expect(dueStep(base, at('2026-11-20T10:00:00Z'), 'auto')).toBeNull();
  });

  it('reminder on 28 Nov, once', () => {
    expect(dueStep(base, at('2026-11-28T08:30:00Z'), 'auto')).toBe('reminder');
    expect(dueStep({ ...base, emails: { reminder: '2026-11-28T08:31:00Z' } }, at('2026-11-28T09:00:00Z'), 'auto')).toBeNull();
  });

  it('no reminder in the last 2 h before the charge', () => {
    expect(dueStep(base, at('2026-12-01T05:30:00Z'), 'auto')).toBeNull();
  });

  it('1st attempt from 1 Dec 08:00 Prague, also when the run comes late', () => {
    expect(dueStep(base, at('2026-12-01T06:59:00Z'), 'auto')).toBeNull();
    expect(dueStep(base, at('2026-12-01T07:00:00Z'), 'auto')).toBe('attempt1');
    expect(dueStep(base, at('2026-12-02T18:00:00Z'), 'auto')).toBe('attempt1');
  });

  it('2nd attempt on 2 Dec 16:00 after one decline', () => {
    const failed = { ...base, status: 'failed' as const, autoDeclines: 1, firstDeclineAt: '2026-12-01T07:05:00Z', emails: { failed: '2026-12-01T07:06:00Z' } };
    expect(dueStep(failed, at('2026-12-02T14:59:00Z'), 'auto')).toBeNull();
    expect(dueStep(failed, at('2026-12-02T15:00:00Z'), 'auto')).toBe('attempt2');
  });

  it('a late 1st decline still leaves the guest 20 h', () => {
    const late = { ...base, status: 'failed' as const, autoDeclines: 1, firstDeclineAt: '2026-12-02T12:00:00Z', emails: { failed: '2026-12-02T12:00:00Z' } };
    expect(dueStep(late, at('2026-12-02T15:30:00Z'), 'auto')).toBeNull();
    expect(dueStep(late, at('2026-12-03T08:00:00Z'), 'auto')).toBe('attempt2');
  });

  it('two declines → cancel while free cancellation lasts, otherwise an admin decides', () => {
    const twice = { ...base, status: 'failed' as const, autoDeclines: 2, firstDeclineAt: '2026-12-01T07:05:00Z', emails: { failed: '2026-12-01T07:06:00Z' } };
    expect(dueStep(twice, at('2026-12-02T15:10:00Z'), 'auto')).toBe('cancel');
    expect(dueStep(twice, at('2026-12-03T22:00:00Z'), 'auto')).toBe('cancel');     // 23:00 Prague on the deadline day
    expect(dueStep(twice, at('2026-12-03T23:00:00Z'), 'auto')).toBe('decide');     // 00:00 Prague on 4 Dec
    expect(dueStep({ ...twice, noAutoCancel: true }, at('2026-12-02T15:10:00Z'), 'auto')).toBe('decide');
    expect(dueStep(twice, at('2026-12-02T15:10:00Z'), 'manual')).toBe('decide');
  });

  it('closed statuses have nothing due', () => {
    for (const status of ['paid', 'paid_other', 'cancelled', 'cancelled_unpaid', 'closed'] as const) {
      expect(dueStep({ ...base, status }, at('2026-12-02T15:10:00Z'), 'auto')).toBeNull();
    }
  });
});

describe('canAutoCancel', () => {
  it('needs auto mode, no ops exception, and the free-cancellation window', () => {
    const now = at('2026-12-02T15:10:00Z');
    expect(canAutoCancel(base, now, 'auto')).toBe(true);
    expect(canAutoCancel(base, now, 'manual')).toBe(false);
    expect(canAutoCancel({ ...base, noAutoCancel: true }, now, 'auto')).toBe(false);
    expect(canAutoCancel(base, at('2026-12-04T08:00:00Z'), 'auto')).toBe(false);
  });
});

describe('overdueSchedules — the watchdog', () => {
  it('flags a 1st attempt still undone 2 h after it was due (auto mode)', () => {
    expect(overdueSchedules([base], at('2026-12-01T08:59:00Z'), 'auto')).toEqual([]);
    expect(overdueSchedules([base], at('2026-12-01T09:01:00Z'), 'auto')).toEqual([
      { id: 'WP-1', step: 'attempt1', lateMs: 2 * 3600_000 + 60_000 },
    ]);
  });

  it('in manual mode only reminders count; off mode never fires', () => {
    expect(overdueSchedules([base], at('2026-12-01T09:01:00Z'), 'manual')).toEqual([]);
    expect(overdueSchedules([base], at('2026-11-28T10:30:00Z'), 'manual').map((o) => o.step)).toEqual(['reminder']);
    expect(overdueSchedules([base], at('2026-12-01T09:01:00Z'), 'off')).toEqual([]);
  });

  it('never fires for a decision that waits for a human', () => {
    const twice = { ...base, status: 'failed' as const, autoDeclines: 2, noAutoCancel: true, firstDeclineAt: '2026-12-01T07:05:00Z', emails: { failed: '2026-12-01T07:06:00Z' } };
    expect(overdueSchedules([twice], at('2026-12-02T20:00:00Z'), 'auto')).toEqual([]);
  });
});

describe('review fixes (13 Nov)', () => {
  const failed = { ...base, status: 'failed' as const, autoDeclines: 1, firstDeclineAt: '2026-12-01T07:05:00Z' };

  it('nothing follows a decline until the guest was emailed; then 20 h from the EMAIL', () => {
    expect(dueStep(failed, at('2026-12-02T15:10:00Z'), 'auto')).toBe('failed_email');
    const toldLate = { ...failed, emails: { failed: '2026-12-02T09:00:00Z' } };
    expect(dueStep(toldLate, at('2026-12-02T15:10:00Z'), 'auto')).toBeNull();
    expect(dueStep(toldLate, at('2026-12-03T05:00:00Z'), 'auto')).toBe('attempt2');
  });

  it('a failure email that never went out by the deadline → an admin decides, no cancellation', () => {
    expect(dueStep(failed, at('2026-12-04T08:00:00Z'), 'auto')).toBe('decide');
  });

  it('a running back-off holds the charge and the cancellation, and the watchdog waits for it', () => {
    const backingOff = { ...base, retryNotBefore: '2026-12-01T11:00:00Z' };
    expect(dueStep(backingOff, at('2026-12-01T09:00:00Z'), 'auto')).toBeNull();
    expect(dueStep(backingOff, at('2026-12-01T11:00:00Z'), 'auto')).toBe('attempt1');
    expect(overdueSchedules([backingOff], at('2026-12-01T12:30:00Z'), 'auto')).toEqual([]);
    expect(overdueSchedules([backingOff], at('2026-12-01T13:30:00Z'), 'auto').map((o) => o.step)).toEqual(['attempt1']);
    const twice = { ...failed, autoDeclines: 2, emails: { failed: '2026-12-01T07:06:00Z' }, retryNotBefore: '2026-12-02T20:00:00Z' };
    expect(dueStep(twice, at('2026-12-02T16:00:00Z'), 'auto')).toBeNull();
  });

  it('back-off grows and caps (a handful of attempts a day at most)', () => {
    expect(retryBackoffMs('retry', 1)).toBe(2 * 3600_000);
    expect(retryBackoffMs('retry', 2)).toBe(4 * 3600_000);
    expect(retryBackoffMs('retry', 9)).toBe(12 * 3600_000);
    expect(retryBackoffMs('unknown', 1)).toBe(30 * 60_000);
    expect(retryBackoffMs('needs_admin', 1)).toBe(12 * 3600_000);
  });

  it('Beds24 deposits follow what was actually paid', () => {
    expect(depositsFor([{ id: 1, price: 12345 }], 12345)).toEqual([{ id: 1, deposit: 12345 }]);
    expect(depositsFor([{ id: 1, price: 12345 }, { id: 2, price: 12345 }], 24690)).toEqual([{ id: 1, deposit: 12345 }, { id: 2, deposit: 12345 }]);
    expect(depositsFor([{ id: 1, price: 15000 }], 12345)).toEqual([{ id: 1, deposit: 12345 }]);
    const half = depositsFor([{ id: 1, price: 10000 }, { id: 2, price: 5000 }], 7500);
    expect(half).toEqual([{ id: 1, deposit: 5000 }, { id: 2, deposit: 2500 }]);
  });
});

