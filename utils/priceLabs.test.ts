import { describe, it, expect } from 'vitest';
import { listingPricesProblem, type ListingPrices } from './priceLabs';

const base: ListingPrices = { id: '311322___679714', pms: 'beds24', currency: 'CZK', last_refreshed_at: null };

describe('listingPricesProblem', () => {
  it('accepts a normal answer, including booked nights (user_price -1)', () => {
    expect(
      listingPricesProblem({
        ...base,
        data: [
          { date: '2026-11-07', price: 3149, user_price: -1, demand_desc: 'Unavailable' },
          { date: '2026-11-08', price: 2900, user_price: 2950, demand_desc: 'Normal Demand' },
        ],
      }),
    ).toBeNull();
  });

  it('rejects the in-band error PriceLabs sends with HTTP 200', () => {
    expect(
      listingPricesProblem({ ...base, error: 'Listing does not exist in PriceLabs', error_status: 'LISTING_NOT_PRESENT' }),
    ).toBe('LISTING_NOT_PRESENT: Listing does not exist in PriceLabs');
  });

  it('rejects a missing entry or an empty night list', () => {
    expect(listingPricesProblem(null)).toBe('no entry for the listing');
    expect(listingPricesProblem({ ...base, data: [] })).toBe('no nights returned');
    expect(listingPricesProblem({ ...base })).toBe('no nights returned');
  });

  it('rejects nights that carry no price and no demand', () => {
    expect(
      listingPricesProblem({ ...base, data: [{ date: '2026-11-07', price: -1, user_price: -1 }] }),
    ).toBe('1 nights returned, none with a price or demand');
  });
});
