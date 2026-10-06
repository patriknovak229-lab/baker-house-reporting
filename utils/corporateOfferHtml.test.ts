import { describe, it, expect } from 'vitest';
import { buildOfferHTML, offerTotals, offerDate, type OfferInput } from './corporateOfferHtml';

const base: OfferInput = {
  offerNumber: 'OFF-20261006-k9z3',
  issuedOn: '2026-10-06',
  validUntil: '2026-10-20',
  companyName: 'Müller & Söhne <GmbH>',
  companyAddress: 'Brno',
  ico: '12345678',
  vatNumber: null,
  contactName: 'Jana Nová',
  contactPhone: '+420 777 000 111',
  contactEmail: null,
  startDate: '2026-10-12',
  endDate: '2026-12-17',
  nightWeekdays: [1, 2],
  roomIds: [679714, 648816],
  adults: 1,
  children: 0,
  pricingMode: 'flat',
  flatNightPriceCzk: 1850,
  discountPercent: 0,
  billingCadence: 'monthly',
  notes: null,
  stays: [
    { seq: 1, arrival: '2026-10-12', departure: '2026-10-14', nights: 2, roomId: 679714, priceCzk: 3700 },
    { seq: 2, arrival: '2026-10-19', departure: '2026-10-21', nights: 2, roomId: 648816, priceCzk: 3700 },
    { seq: 3, arrival: '2026-10-26', departure: '2026-10-28', nights: 2, roomId: 679714, priceCzk: null },
  ],
};

describe('offerTotals', () => {
  it('sums nights and prices, averages over priced nights only', () => {
    expect(offerTotals(base.stays)).toEqual({ stays: 3, nights: 6, priceCzk: 7400, unpriced: 1, avgNightCzk: 1850 });
    expect(offerTotals([])).toEqual({ stays: 0, nights: 0, priceCzk: 0, unpriced: 0, avgNightCzk: null });
  });
});

/** cs-CZ number formatting uses U+00A0 as the thousands separator. */
const plain = (s: string) => s.replace(/\u00a0/g, ' ');

describe('buildOfferHTML', () => {
  const html = plain(buildOfferHTML(base));

  it('escapes operator-entered text', () => {
    expect(html).toContain('Müller &amp; Söhne &lt;GmbH&gt;');
    expect(html).not.toContain('<GmbH>');
  });

  it('carries the facts the company needs', () => {
    expect(html).toContain('OFF-20261006-k9z3');
    expect(html).toContain('Mon 12 Oct 2026 – Thu 17 Dec 2026');
    expect(html).toContain('Mon + Tue nights');
    expect(html).toContain('1KK Urban Studios');
    expect(html).toContain('1KK Deluxe Studios');
    expect(html).toContain('1 850 Kč / noc · per night');
    expect(html).toContain('7 400 Kč');
    expect(html).toContain('3 pobytů / stays · 6 nocí / nights');
    expect(html).toContain('na vyžádání'); // the unpriced stay
    expect(html).toContain('Monthly');
    expect(html).toContain('Valid until: Tue 20 Oct 2026');
    expect(html).toContain('Jana Nová · +420 777 000 111');
  });

  it('dynamic pricing shows the average with the discount note', () => {
    const dyn = plain(buildOfferHTML({
      ...base,
      pricingMode: 'dynamic',
      flatNightPriceCzk: null,
      discountPercent: 15,
      stays: base.stays.map((s) => ({ ...s, priceCzk: 3825 })),
    }));
    expect(dyn).toContain('1 913 Kč / noc · per night');
    expect(dyn).toContain('průměr / average, −15 % z webové ceny');
  });

  it('formats dates as weekday + date', () => {
    expect(offerDate('2026-10-12')).toBe('Mon 12 Oct 2026');
  });
});
