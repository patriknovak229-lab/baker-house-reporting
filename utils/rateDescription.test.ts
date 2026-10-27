import { describe, expect, it } from 'vitest';
import {
  buildRateIdPlanMap,
  firstLine,
  originalNightly,
  parseRateLine,
  promoFamily,
  resolvePlan,
} from './rateDescription';

// Lines copied verbatim from the archive (bookings_mirror.raw ->> 'rateDescription').
describe('parseRateLine', () => {
  it('reads plan, promotion and Genius off a Booking.com night line', () => {
    const p = parseRateLine(
      '2026-08-10 (66698026 Flexible Urban 1KK rewritten from  Early Booker Deal) CZK 2149.16 genius',
    );
    expect(p).toEqual({
      rateId: '66698026',
      plan: 'Flexible',
      promoName: 'Early Booker Deal',
      promo: 'Early Booker Deal',
      genius: true,
    });
  });

  it('keeps a bracketed promotion name whole', () => {
    const p = parseRateLine(
      '2026-04-24 (60681828 Standard Rate rewritten from  Mobile(App) Rate) CZK 2894.91 genius',
    );
    expect(p.plan).toBe('Standard');
    expect(p.promoName).toBe('Mobile(App) Rate');
    expect(p.promo).toBe('Mobile rate');
  });

  it('recognises every plan spelling in the archive', () => {
    const plan = (s: string) => parseRateLine(`2026-06-21 (1 ${s}) CZK 1 `).plan;
    expect(plan('Non-refundable Rate-One-Bedroom Apartment-1541267401')).toBe('Non-refundable');
    expect(plan('Non-Ref K201')).toBe('Non-refundable');
    expect(plan('Non Refundable O308')).toBe('Non-refundable');
    expect(plan('One Night Stays K201')).toBe('One-night');
    expect(plan('Weekly Rate-One-Bedroom Apartment-1541267401')).toBe('Weekly');
    expect(plan('Flexibl - 1 day')).toBe('Flexible');
    expect(plan('Flexible 1 day Urban')).toBe('Flexible');
    expect(plan('Standard Rate')).toBe('Standard');
  });

  it('leaves the plan open when the line carries only a rate id', () => {
    const p = parseRateLine('2026-11-10 (65571709 rewritten from  Early Booker Deal) CZK 1551.36 genius');
    expect(p.rateId).toBe('65571709');
    expect(p.plan).toBeNull();
    expect(p.promo).toBe('Early Booker Deal');
  });

  it('treats a rate rewritten from another rate as that rate, not a promotion', () => {
    const p = parseRateLine(
      '2026-05-02 (60681828 Standard Rate rewritten from 60681829 Non-refundable Rate-One-Bedroom Apartment-1541267401) CZK 2100 genius',
    );
    expect(p.plan).toBe('Non-refundable');
    expect(p.promo).toBe('No promotion');
    expect(p.promoName).toBeNull();
  });

  it('reads the older bare-rate shape', () => {
    const p = parseRateLine('2026-02-06 Rate (60681828) CZK 1955.34\r');
    expect(p.rateId).toBe('60681828');
    expect(p.plan).toBeNull();
  });

  it('maps Airbnb cancellation policies onto the plan ladder', () => {
    expect(parseRateLine('Cancel policy tiered_pricing_non_refundable').plan).toBe('Non-refundable');
    expect(parseRateLine('Cancel policy moderate').plan).toBe('Flexible');
    expect(parseRateLine('Cancel policy firm_14').plan).toBe('Standard');
  });

  it('returns an empty parse for direct bookings', () => {
    expect(parseRateLine('')).toEqual({
      rateId: null,
      plan: null,
      promoName: null,
      promo: 'No promotion',
      genius: false,
    });
  });
});

describe('promoFamily', () => {
  it('groups operator-named promotions by intent', () => {
    expect(promoFamily('Last Minute Deal deal - 3 dny predem (ne-ct')).toBe('Last Minute Deal');
    expect(promoFamily('Super Last Minute')).toBe('Super Last Minute');
    expect(promoFamily('Super Early Booker Deal')).toBe('Early Booker Deal');
    expect(promoFamily('Limited Time Deal August')).toBe('Limited Time Deal');
    expect(promoFamily('August Deal')).toBe('Seasonal deal');
    expect(promoFamily('Sezonni nabidka - Aug/Sept')).toBe('Seasonal deal');
    expect(promoFamily(null)).toBe('No promotion');
  });
});

describe('resolvePlan', () => {
  it('fills a nameless line from the rate id, then from rate_type', () => {
    const named = parseRateLine('2026-08-12 (65571709 Weekly rate Urban rewritten from  Early Booker Deal) CZK 1621.67 genius');
    const nameless = parseRateLine('2026-11-10 (65571709 rewritten from  Early Booker Deal) CZK 1551.36 genius');
    const ids = buildRateIdPlanMap([named, nameless]);
    expect(resolvePlan(nameless, null, ids)).toBe('Weekly');
    expect(resolvePlan(parseRateLine(''), 'Flexi', ids)).toBe('Flexible');
    expect(resolvePlan(parseRateLine(''), null, ids)).toBe('Unspecified');
  });
});

describe('originalNightly', () => {
  it('averages the per-night lines of a cancelled Booking.com stay', () => {
    const text = [
      '2026-03-22 (60681828 Standard Rate) CZK 1955 genius',
      '2026-03-23 (60681828 Standard Rate) CZK 1955 genius',
      '2026-03-24 (60681828 Standard Rate) CZK 2012.80 genius',
      'Total Commission: 268.76',
    ].join('\n');
    expect(originalNightly(text, 3)).toBeCloseTo(1974.27, 2);
  });

  it('is not diluted when Beds24 truncated a long stay to fewer lines than nights', () => {
    const text = '2026-04-06 (60681830 Weekly Rate) CZK 2000.90 genius\n2026-04-07 (60681830 Weekly Rate) CZK 1999.10 genius';
    expect(originalNightly(text, 14)).toBeCloseTo(2000, 2);
  });

  it('spreads Airbnb base price over the stay', () => {
    expect(
      originalNightly('Cancel policy moderate\nBase Price 6489.75 CZK\nHost Fee -1217.15 CZK\n', 3),
    ).toBeCloseTo(2163.25, 2);
  });

  it('is null when there is nothing to read', () => {
    expect(originalNightly('', 2)).toBeNull();
    expect(originalNightly(null, 2)).toBeNull();
  });

  it('firstLine strips the rest of the stay', () => {
    expect(firstLine('a\r\nb')).toBe('a');
  });
});
