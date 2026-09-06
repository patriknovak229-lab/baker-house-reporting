import { describe, it, expect } from 'vitest';
import {
  parseMultiplier, sumCalendarPrice, extractPrice, offersForRoom, previousDay,
  bestDiscount, RATE_MODEL,
} from './beds24Pricing';

const URBAN = 679714;      // offers a non-refundable rate
const O308 = 674672;       // offers a non-refundable rate
const K201 = 656437;       // does not
const DELUXE_1KK = 648816; // does not

/** A calendar response in the shape Beds24 returns for includePrices+includeMultiplier. */
function calendar(days: { from: string; to?: string; price1?: number; multiplier?: number }[]) {
  return { success: true, data: [{ roomId: 679714, calendar: days }] };
}

describe('parseMultiplier', () => {
  it('reads a factor as-is and a percentage as a factor', () => {
    expect(parseMultiplier('0.75')).toBe(0.75);
    expect(parseMultiplier(0.75)).toBe(0.75);
    // Beds24 types this as a string with no documented format, so 75 must mean 75%.
    expect(parseMultiplier('75')).toBe(0.75);
    expect(parseMultiplier('110')).toBeCloseTo(1.1);
    expect(parseMultiplier('1,25')).toBe(1.25); // comma decimal
  });

  it('refuses junk rather than scaling a guest-facing price by it', () => {
    for (const bad of [null, undefined, '', 'abc', 0, -1, '0', NaN, {}, []]) {
      expect(parseMultiplier(bad)).toBeNull();
    }
    // A "factor" this large is neither a factor nor a sane percentage.
    expect(parseMultiplier('5000')).toBeNull();
  });

  it('treats a missing multiplier as no adjustment, not as zero', () => {
    // The caller's `?? 1` only works because absence is null, never 0.
    expect(parseMultiplier(undefined)).toBeNull();
    expect(parseMultiplier(0)).toBeNull();
  });
});

describe('sumCalendarPrice', () => {
  it('sums only the nights inside the stay, departure exclusive', () => {
    const data = calendar([
      { from: '2026-09-01', price1: 1000 },
      { from: '2026-09-02', price1: 1000 },
      { from: '2026-09-03', price1: 1000 }, // departure night — not charged
    ]);
    expect(sumCalendarPrice(data, '2026-09-01', '2026-09-03')).toBe(2000);
  });

  it('applies the per-date multiplier to each night', () => {
    const data = calendar([
      { from: '2026-09-01', price1: 1000, multiplier: 1.5 }, // peak date
      { from: '2026-09-02', price1: 1000 },                  // absent = 1
      { from: '2026-09-03', price1: 1000, multiplier: 0.5 },
    ]);
    expect(sumCalendarPrice(data, '2026-09-01', '2026-09-04')).toBe(3000);
  });

  it('expands a from/to range entry across its nights', () => {
    const data = calendar([{ from: '2026-09-01', to: '2026-09-05', price1: 500, multiplier: 2 }]);
    // 01,02,03 are inside [01,04) → 3 nights at 1000
    expect(sumCalendarPrice(data, '2026-09-01', '2026-09-04')).toBe(3000);
  });

  it('returns null when no night in the span carries a price', () => {
    expect(sumCalendarPrice(calendar([{ from: '2026-10-01', price1: 900 }]), '2026-09-01', '2026-09-03')).toBeNull();
    expect(sumCalendarPrice({ success: true, data: [] }, '2026-09-01', '2026-09-03')).toBeNull();
  });

  it('ignores a junk multiplier instead of zeroing the night', () => {
    // A price silently multiplied by 0 would read as a free stay.
    const data = calendar([{ from: '2026-09-01', price1: 1000, multiplier: 0 as number }]);
    expect(sumCalendarPrice(data, '2026-09-01', '2026-09-02')).toBe(1000);
  });
});

describe('extractPrice / offersForRoom', () => {
  const offersResponse = {
    success: true,
    data: [
      { roomId: 679714, offers: [{ offerId: 1, offerName: 'Standard', price: 2500, unitsAvailable: 2 }] },
      { roomId: 648816, offers: [] },
    ],
  };

  it('takes the first offer — Beds24 orders its own offers (operator decision)', () => {
    expect(extractPrice(offersForRoom(offersResponse, 679714))).toBe(2500);
  });

  it('an empty or missing offer list means not sellable, not free', () => {
    expect(extractPrice(offersForRoom(offersResponse, 648816))).toBeNull();
    expect(extractPrice(offersForRoom(offersResponse, 999999))).toBeNull();
  });
});

describe('previousDay', () => {
  it('turns a departure date into the last charged night, across a month end', () => {
    expect(previousDay('2026-10-01')).toBe('2026-09-30');
    expect(previousDay('2026-03-01')).toBe('2026-02-28');
  });
});

describe('bestDiscount — the ladder verified against six live Beds24 offers', () => {
  it('gives the weekly discount from 7 nights, to every room', () => {
    for (const roomId of [URBAN, O308, K201, DELUXE_1KK]) {
      expect(bestDiscount(roomId, 7).factor).toBe(0.8);
      expect(bestDiscount(roomId, 30).factor).toBe(0.8);
    }
  });

  it('does not stack: a long stay takes the weekly discount INSTEAD of the non-refundable one', () => {
    // 0.8, never 0.8 × 0.93. Live data: Urban 30n = base × 0.75 × 0.80 exactly.
    expect(bestDiscount(URBAN, 30).factor).toBe(0.8);
    expect(bestDiscount(URBAN, 30).reason).toMatch(/weekly/i);
  });

  it('applies the non-refundable rate below a week, only where that rate exists', () => {
    expect(bestDiscount(URBAN, 3).factor).toBe(0.93);
    expect(bestDiscount(O308, 3).factor).toBe(0.93);
    // These two quoted at the plain multiplier for 3 nights in the live check.
    expect(bestDiscount(K201, 3).factor).toBe(1);
    expect(bestDiscount(DELUXE_1KK, 3).factor).toBe(1);
  });

  it('steps exactly at the weekly threshold, not around it', () => {
    expect(bestDiscount(K201, 6).factor).toBe(1);
    expect(bestDiscount(K201, 7).factor).toBe(0.8);
    expect(bestDiscount(URBAN, 6).factor).toBe(0.93);
    expect(bestDiscount(URBAN, 7).factor).toBe(0.8);
  });

  it('reproduces the live offers to the cent', () => {
    // base × webMultiplier × discount, checked against real Beds24 quotes.
    const price = (base: number, roomId: number, nights: number) =>
      Math.round(base * RATE_MODEL.webMultiplier * bestDiscount(roomId, nights).factor * 100) / 100;

    expect(price(21212, K201, 3)).toBe(15909);
    expect(price(12971, DELUXE_1KK, 3)).toBe(9728.25);
    expect(price(11353, URBAN, 3)).toBe(7918.72);
    expect(price(18031, O308, 3)).toBe(12576.62);
    expect(price(93292, URBAN, 30)).toBe(55975.2);
    expect(price(104629, DELUXE_1KK, 30)).toBe(62777.4);
  });
});
