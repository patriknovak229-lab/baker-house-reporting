import { describe, expect, it } from 'vitest';
import {
  type CancelledPriceInput,
  carryPriceBeforeCancel,
  parseCancellationFeeSuggestion,
  recoverCancelledPrice,
} from './cancelledBooking';
import { countsInRevenue, reservationRevenue } from './reservationRevenue';
import type { Reservation } from '@/types/reservation';

// Payloads copied from the Redis bookings cache on 2026-11-27.
const BH_95759725_API_MESSAGE =
  '\ncommissionamount=2200.79\npaymentcharge=184.71\ncurrencycode=CZK\ntotal_cancellation_fee=12313.99\ntotalprice=0';

const BH_82866413_RATE =
  '2026-03-22 (60681828 Standard Rate) CZK 1955 genius\n' +
  '2026-03-23 (60681828 Standard Rate) CZK 1955 genius\n' +
  '2026-03-24 (60681828 Standard Rate) CZK 2012.80 genius\n' +
  '2026-03-25 (60681828 Standard Rate) CZK 2033.20 genius\n' +
  '2026-03-26 (60681828 Standard Rate) CZK 1955 genius\n' +
  'Total Commission: 1278.97\n';

describe('recoverCancelledPrice', () => {
  it('leaves a cancelled booking that still carries a price alone', () => {
    expect(recoverCancelledPrice({ status: 'cancelled', price: 12313.99, rateDescription: BH_82866413_RATE }, 3)).toBeNull();
  });

  it('ignores live bookings', () => {
    expect(recoverCancelledPrice({ status: 'confirmed', price: 0, rateDescription: BH_82866413_RATE }, 5)).toBeNull();
  });

  it('prefers the snapshot our sync kept', () => {
    const r = recoverCancelledPrice({ status: 'cancelled', price: 0, rateDescription: BH_82866413_RATE, _priceBeforeCancel: 9911 }, 5);
    expect(r).toEqual({ price: 9911, recovery: { beds24PriceCzk: 0, source: 'snapshot' } });
  });

  it('reads a zeroed Booking.com booking back from its night lines', () => {
    const r = recoverCancelledPrice({ status: 'cancelled', price: 0, rateDescription: BH_82866413_RATE }, 5);
    expect(r).toEqual({ price: 9911, recovery: { beds24PriceCzk: 0, source: 'rate-description' } });
  });

  it('flags a truncated description as approximate', () => {
    const r = recoverCancelledPrice({ status: 'cancelled', price: 0, rateDescription: BH_82866413_RATE }, 10);
    expect(r?.price).toBeCloseTo(19822, 0);
    expect(r?.recovery.approximate).toBe(true);
  });

  it("reads Airbnb's whole-stay Base Price exactly", () => {
    const rate = 'Cancel policy tiered_pricing_non_refundable\nBase Price 28784.7 CZK\nHost Fee -539';
    const r = recoverCancelledPrice({ status: 'cancelled', price: 0, rateDescription: rate }, 7);
    expect(r?.price).toBe(28784.7);
    expect(r?.recovery.approximate).toBeUndefined();
  });

  it('gives up on a direct booking with no description or snapshot', () => {
    expect(recoverCancelledPrice({ status: 'cancelled', price: 0, rateDescription: '' }, 3)).toBeNull();
  });
});

describe('carryPriceBeforeCancel', () => {
  it('remembers the live price when the cancelled copy arrives zeroed', () => {
    const prev = { status: 'confirmed', price: 4800 };
    expect(carryPriceBeforeCancel(prev, { status: 'cancelled', price: 0 })).toEqual({
      status: 'cancelled',
      price: 0,
      _priceBeforeCancel: 4800,
    });
  });

  it('keeps the remembered price across later syncs', () => {
    const prev: CancelledPriceInput = { status: 'cancelled', price: 0, _priceBeforeCancel: 4800 };
    const next: CancelledPriceInput = { status: 'cancelled', price: 0 };
    expect(carryPriceBeforeCancel(prev, next)._priceBeforeCancel).toBe(4800);
  });

  it('snapshots a cancelled booking that still has its price, for when Beds24 zeroes it', () => {
    const next = carryPriceBeforeCancel<CancelledPriceInput>(undefined, { status: 'cancelled', price: 12313.99 });
    expect(next._priceBeforeCancel).toBe(12313.99);
  });

  it('drops the field when a booking is reinstated', () => {
    const next = carryPriceBeforeCancel(undefined, { status: 'confirmed', price: 100, _priceBeforeCancel: 90 });
    expect(next).toEqual({ status: 'confirmed', price: 100 });
  });

  it('adds nothing when no price was ever seen', () => {
    const next = { status: 'cancelled', price: 0 };
    expect(carryPriceBeforeCancel(undefined, next)).toBe(next);
  });
});

describe('parseCancellationFeeSuggestion', () => {
  it("reads Booking.com's cancel payload (BH-95759725)", () => {
    expect(parseCancellationFeeSuggestion(BH_95759725_API_MESSAGE)).toEqual({
      amountCzk: 12313.99,
      commissionCzk: 2200.79,
      paymentChargeCzk: 184.71,
    });
  });

  it('returns null for a free cancellation (fee 0) or no payload', () => {
    expect(parseCancellationFeeSuggestion('\ncommissionamount=0\ntotal_cancellation_fee=0\ntotalprice=0')).toBeNull();
    expect(parseCancellationFeeSuggestion('')).toBeNull();
    expect(parseCancellationFeeSuggestion(undefined)).toBeNull();
  });

  it('ignores a fee in another currency', () => {
    expect(parseCancellationFeeSuggestion('currencycode=EUR\ntotal_cancellation_fee=500')).toBeNull();
  });
});

describe('revenue of a cancelled booking', () => {
  const base = {
    price: 12313.99,
    commissionAmount: 2385.5,
    paymentChargeAmount: 0,
    isCancelled: true,
  } as Reservation;

  it('earns nothing without a recorded fee', () => {
    expect(countsInRevenue(base)).toBe(false);
    expect(reservationRevenue(base)).toEqual({ gbv: 0, commission: 0, fee: 0 });
  });

  it('earns the fee less the channel cut on it', () => {
    const r = {
      ...base,
      cancellationFee: {
        amountCzk: 12313.99,
        commissionCzk: 2200.79,
        paymentChargeCzk: 184.71,
        flaggedAt: '2026-11-27T19:00:00Z',
        flaggedBy: 'ops@example.com',
      },
    } as Reservation;
    expect(countsInRevenue(r)).toBe(true);
    expect(reservationRevenue(r)).toEqual({ gbv: 12313.99, commission: 2200.79, fee: 184.71 });
  });

  it('a 0 Kč fee does not count the booking', () => {
    const r = {
      ...base,
      cancellationFee: { amountCzk: 0, commissionCzk: 0, paymentChargeCzk: 0, flaggedAt: '', flaggedBy: '' },
    } as Reservation;
    expect(countsInRevenue(r)).toBe(false);
  });

  it('live bookings are unaffected', () => {
    const live = { ...base, isCancelled: false } as Reservation;
    expect(countsInRevenue(live)).toBe(true);
    expect(reservationRevenue(live)).toEqual({ gbv: 12313.99, commission: 2385.5, fee: 0 });
  });
});
