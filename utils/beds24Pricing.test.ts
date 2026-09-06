import { describe, it, expect } from 'vitest';
import {
  parseMultiplier, sumCalendarPrice, extractPrice, offersForRoom, previousDay,
  bestDirectRate, WEB_MULTIPLIER,
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

describe('bestDirectRate — the Beds24 Daily Price Rules, direct channel only', () => {
  it('takes the non-refundable rate where it IS sold direct', () => {
    expect(bestDirectRate(URBAN, 3, 100)?.price).toBeCloseTo(93);
    expect(bestDirectRate(O308, 3, 100)?.price).toBeCloseTo(93);
  });

  it('ignores a non-refundable rate that is not published to Direct', () => {
    // K.201 (-10%) and Deluxe 1KK (-7%) sell theirs to Booking.com and Agent
    // only, so a direct guest pays the standard rate. Live data agreed exactly.
    expect(bestDirectRate(K201, 3, 100)?.price).toBeCloseTo(100);
    expect(bestDirectRate(K201, 3, 100)?.rule).toMatch(/standard/i);
    expect(bestDirectRate(DELUXE_1KK, 3, 100)?.price).toBeCloseTo(100);
  });

  it("falls back to the cheapest direct rule when the STANDARD rate isn't sold direct", () => {
    // O.308's standard rate is Booking.com-only, so 2–6 nights start from the
    // non-refundable rate rather than from the standard one.
    expect(bestDirectRate(O308, 3, 100)?.rule).toMatch(/non refundable/i);
  });

  it('switches to the weekly discount at exactly 7 nights, and drops the non-refundable one', () => {
    expect(bestDirectRate(URBAN, 6, 100)?.price).toBeCloseTo(93);   // non-refundable still valid
    expect(bestDirectRate(URBAN, 7, 100)?.price).toBeCloseTo(80);   // maxNights 6 ends it; weekly starts
    expect(bestDirectRate(URBAN, 7, 100)?.rule).toMatch(/weekly/i);
    expect(bestDirectRate(K201, 7, 100)?.price).toBeCloseTo(80);
  });

  it('charges the one-night surcharge instead of any discount for a single night', () => {
    // The non-refundable rules start at 2 nights — a 1-night stay is dearer,
    // not cheaper, and treating it as a discount would underquote badly.
    expect(bestDirectRate(URBAN, 1, 3000)?.price).toBe(4000);
    expect(bestDirectRate(DELUXE_1KK, 1, 3000)?.price).toBe(4200);
    expect(bestDirectRate(O308, 1, 3000)?.price).toBe(4800);
    expect(bestDirectRate(K201, 1, 3000)?.price).toBe(5000);
    expect(bestDirectRate(URBAN, 1, 3000)?.rule).toMatch(/one night/i);
  });

  it('never picks a dearer flexible rate when a cheaper one applies', () => {
    for (const roomId of [URBAN, O308, K201, DELUXE_1KK]) {
      expect(bestDirectRate(roomId, 10, 100)!.price).toBeLessThanOrEqual(100);
    }
  });

  it('reproduces the six live Beds24 offers to the cent', () => {
    const price = (base: number, roomId: number, nights: number) =>
      Math.round(bestDirectRate(roomId, nights, base)!.price * WEB_MULTIPLIER * 100) / 100;

    expect(price(21212, K201, 3)).toBe(15909);
    expect(price(12971, DELUXE_1KK, 3)).toBe(9728.25);
    expect(price(11353, URBAN, 3)).toBe(7918.72);
    expect(price(18031, O308, 3)).toBe(12576.62);
    expect(price(93292, URBAN, 30)).toBe(55975.2);
    expect(price(104629, DELUXE_1KK, 30)).toBe(62777.4);
  });

  it('prices a one-night Urban stay exactly as Beds24 did', () => {
    // Live check 2026-09-07→08: base 2716 → Beds24 quoted 2787, ratio 1.000.
    // This pins the ORDER of operations, which the percentage rules cannot:
    // the surcharge joins the rate and the web multiplier then applies to it.
    //   (2716 + 1000) × 0.75 = 2787   ✓ what Beds24 charges
    //    2716 × 0.75 + 1000  = 3037   ✗ the other ordering
    const rate = bestDirectRate(URBAN, 1, 2716)!;
    expect(rate.rule).toBe('One Night Stays');
    expect(Math.round(rate.price * WEB_MULTIPLIER * 100) / 100).toBe(2787);
  });

  it('reports a one-night stay as the surcharge it is, above 1, not as a discount', () => {
    const rate = bestDirectRate(URBAN, 1, 2716)!;
    expect(rate.price / 2716).toBeGreaterThan(1);
  });

  it('returns null rather than inventing a price for an unknown room', () => {
    expect(bestDirectRate(999999, 3, 100)).toBeNull();
  });
});
