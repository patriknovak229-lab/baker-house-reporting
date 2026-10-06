import { describe, it, expect } from 'vitest';
import {
  generateStays,
  validateSchedule,
  isoWeekday,
  addDays,
  describeNights,
  computeStayPrice,
  MAX_STAYS,
} from './corporateSchedule';
import { summariseStays, parseCorporateMarker, corporateMarker } from './corporateShared';

describe('isoWeekday / addDays', () => {
  it('uses ISO numbering (Mon = 1, Sun = 7)', () => {
    expect(isoWeekday('2026-10-12')).toBe(1); // the Monday from the operator's example
    expect(isoWeekday('2026-10-18')).toBe(7);
    expect(isoWeekday('2026-12-17')).toBe(4);
  });
  it('adds days across month boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
  });
});

describe('generateStays — the operator example', () => {
  // "1KK for Monday and Tuesday every week, starting Monday 12 Oct, ending 17 Dec"
  const spec = { startDate: '2026-10-12', endDate: '2026-12-17', nightWeekdays: [1, 2] };

  it('produces one two-night stay per week', () => {
    const stays = generateStays(spec);
    expect(stays).toHaveLength(10);
    expect(stays.every((s) => s.nights === 2)).toBe(true);
    expect(stays[0]).toEqual({ seq: 1, arrival: '2026-10-12', departure: '2026-10-14', nights: 2 });
    expect(stays[9]).toEqual({ seq: 10, arrival: '2026-12-14', departure: '2026-12-16', nights: 2 });
  });

  it('totals 20 nights and numbers stays in date order', () => {
    const stays = generateStays(spec);
    expect(stays.reduce((n, s) => n + s.nights, 0)).toBe(20);
    expect(stays.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('treats the end date as the last NIGHT, so a Monday end date still books that night', () => {
    const stays = generateStays({ ...spec, endDate: '2026-12-14' });
    expect(stays).toHaveLength(10);
    // Only the Monday night fits — a one-night stay checking out Tuesday.
    expect(stays[9]).toEqual({ seq: 10, arrival: '2026-12-14', departure: '2026-12-15', nights: 1 });
  });
});

describe('generateStays — merging', () => {
  it('merges consecutive nights across the week boundary (Sat + Sun + Mon → one stay)', () => {
    const stays = generateStays({ startDate: '2026-10-12', endDate: '2026-10-25', nightWeekdays: [6, 7, 1] });
    // Mon 12 Oct alone (its Sat/Sun are before the start), then Sat 17 → Tue 20, then Sat 24 + Sun 25 (end of period).
    expect(stays).toEqual([
      { seq: 1, arrival: '2026-10-12', departure: '2026-10-13', nights: 1 },
      { seq: 2, arrival: '2026-10-17', departure: '2026-10-20', nights: 3 },
      { seq: 3, arrival: '2026-10-24', departure: '2026-10-26', nights: 2 },
    ]);
  });

  it('turns every night into one continuous stay', () => {
    const stays = generateStays({ startDate: '2026-11-01', endDate: '2026-11-30', nightWeekdays: [1, 2, 3, 4, 5, 6, 7] });
    expect(stays).toEqual([{ seq: 1, arrival: '2026-11-01', departure: '2026-12-01', nights: 30 }]);
  });

  it('splits non-consecutive nights in the same week into separate stays', () => {
    const stays = generateStays({ startDate: '2026-10-12', endDate: '2026-10-18', nightWeekdays: [1, 4] });
    expect(stays).toEqual([
      { seq: 1, arrival: '2026-10-12', departure: '2026-10-13', nights: 1 },
      { seq: 2, arrival: '2026-10-15', departure: '2026-10-16', nights: 1 },
    ]);
  });

  it('starts counting from the start date even when it is not a chosen night', () => {
    const stays = generateStays({ startDate: '2026-10-14', endDate: '2026-10-27', nightWeekdays: [1, 2] });
    expect(stays.map((s) => s.arrival)).toEqual(['2026-10-19', '2026-10-26']);
  });

  it('returns no stays when no chosen weekday falls in the period', () => {
    expect(generateStays({ startDate: '2026-10-13', endDate: '2026-10-18', nightWeekdays: [1] })).toEqual([]);
  });
});

describe('validateSchedule', () => {
  it('accepts a sane spec', () => {
    expect(validateSchedule({ startDate: '2026-10-12', endDate: '2026-12-17', nightWeekdays: [1, 2] })).toBeNull();
  });
  it('rejects malformed dates, reversed dates, empty weekdays and bad weekday numbers', () => {
    expect(validateSchedule({ startDate: '12/10/2026', endDate: '2026-12-17', nightWeekdays: [1] })).toMatch(/Start date/);
    expect(validateSchedule({ startDate: '2026-10-12', endDate: '2026-02-30', nightWeekdays: [1] })).toMatch(/End date/);
    expect(validateSchedule({ startDate: '2026-12-17', endDate: '2026-10-12', nightWeekdays: [1] })).toMatch(/before/);
    expect(validateSchedule({ startDate: '2026-10-12', endDate: '2026-12-17', nightWeekdays: [] })).toMatch(/at least one/);
    expect(validateSchedule({ startDate: '2026-10-12', endDate: '2026-12-17', nightWeekdays: [0] })).toMatch(/ISO/);
    expect(validateSchedule({ startDate: '2026-10-12', endDate: '2026-12-17', nightWeekdays: [8] })).toMatch(/ISO/);
  });
  it('caps the period length', () => {
    expect(validateSchedule({ startDate: '2026-01-01', endDate: '2027-06-01', nightWeekdays: [1] })).toMatch(/at most/);
  });
  it('generateStays throws on an invalid spec instead of guessing', () => {
    expect(() => generateStays({ startDate: '2026-12-17', endDate: '2026-10-12', nightWeekdays: [1] })).toThrow(/before/);
  });
  it('caps the number of stays', () => {
    // 400 days of alternating nights (Mon/Wed/Fri) → ~171 stays, over the cap.
    expect(() => generateStays({ startDate: '2026-01-05', endDate: '2027-02-08', nightWeekdays: [1, 3, 5] })).toThrow(
      new RegExp(`limit is ${MAX_STAYS}`),
    );
  });
});

describe('describeNights', () => {
  it('reads naturally', () => {
    expect(describeNights([1, 2])).toBe('Mon + Tue nights');
    expect(describeNights([2, 1])).toBe('Mon + Tue nights');
    expect(describeNights([1])).toBe('Mon night');
    expect(describeNights([1, 2, 3, 4, 5])).toBe('Mon–Fri nights');
    expect(describeNights([1, 2, 3, 4, 5, 6, 7])).toBe('every night');
    expect(describeNights([])).toBe('no nights');
  });
});

describe('computeStayPrice', () => {
  it('flat = rate × nights, discount ignored, whole CZK', () => {
    expect(computeStayPrice({ mode: 'flat', nights: 2, flatNightPriceCzk: 1850, discountPercent: 50 })).toBe(3700);
    expect(computeStayPrice({ mode: 'flat', nights: 3, flatNightPriceCzk: 1333.33 })).toBe(4000);
  });
  it('flat without a rate is unknown, not zero', () => {
    expect(computeStayPrice({ mode: 'flat', nights: 2, flatNightPriceCzk: null })).toBeNull();
  });
  it('dynamic = web price minus discount, rounded', () => {
    expect(computeStayPrice({ mode: 'dynamic', nights: 2, listPriceCzk: 4500, discountPercent: 15 })).toBe(3825);
    expect(computeStayPrice({ mode: 'dynamic', nights: 2, listPriceCzk: 4499.5, discountPercent: 0 })).toBe(4500);
  });
  it('dynamic without a quote is unknown', () => {
    expect(computeStayPrice({ mode: 'dynamic', nights: 2, listPriceCzk: null, discountPercent: 10 })).toBeNull();
  });
  it('clamps a silly discount', () => {
    expect(computeStayPrice({ mode: 'dynamic', nights: 1, listPriceCzk: 1000, discountPercent: 250 })).toBe(0);
    expect(computeStayPrice({ mode: 'dynamic', nights: 1, listPriceCzk: 1000, discountPercent: -10 })).toBe(1000);
  });
  it('never prices zero nights', () => {
    expect(computeStayPrice({ mode: 'flat', nights: 0, flatNightPriceCzk: 1000 })).toBeNull();
  });
});

describe('summariseStays', () => {
  const stay = (status: 'planned' | 'created' | 'failed' | 'skipped' | 'cancelled', arrival: string, priceCzk: number | null) => ({
    status,
    nights: 2,
    priceCzk,
    arrival,
    departure: addDays(arrival, 2),
  });

  it('counts every status but totals only the stays that still count', () => {
    const s = summariseStays([
      stay('created', '2026-10-12', 3700),
      stay('planned', '2026-10-19', 3700),
      stay('failed', '2026-10-26', null),
      stay('skipped', '2026-11-02', 3700),
      stay('cancelled', '2026-11-09', 3700),
    ]);
    expect(s).toMatchObject({ stays: 5, created: 1, planned: 1, failed: 1, skipped: 1, cancelled: 1 });
    expect(s.nights).toBe(6);
    expect(s.priceCzk).toBe(7400);
    expect(s.unpriced).toBe(1);
    expect(s.firstArrival).toBe('2026-10-12');
    expect(s.lastDeparture).toBe('2026-10-28');
  });

  it('handles an empty agreement', () => {
    expect(summariseStays([])).toMatchObject({ stays: 0, nights: 0, priceCzk: 0, firstArrival: null, lastDeparture: null });
  });
});

describe('corporate marker', () => {
  it('round-trips through Beds24 comments next to other markers', () => {
    const comments = `[Created via Reporting App — Phone]\n${corporateMarker('CA-mg1x2a-k9z3')}\nCorporate stay 3/10 · Acme s.r.o.`;
    expect(parseCorporateMarker(comments)).toBe('CA-mg1x2a-k9z3');
  });
  it('is absent on ordinary bookings', () => {
    expect(parseCorporateMarker('PRE-PAID')).toBeNull();
    expect(parseCorporateMarker('')).toBeNull();
    expect(parseCorporateMarker(null)).toBeNull();
  });
});
