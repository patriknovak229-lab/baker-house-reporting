import { describe, it, expect } from 'vitest';
import type { Reservation } from '@/types/reservation';
import type { VariableCostBundle } from './commissionCalc';
import { computeSettlement } from './commissionCalc';
import { COMMISSION_UNITS } from './commissionConfig';

/**
 * The Commission card's "Expected N cleanings vs M billed" badge.
 *
 * It exists to catch a cleaning the operator forgot to assign, so a Δ has to
 * mean something. A non-arrival used to produce a permanent false Δ1: the
 * booking keeps its revenue (the guest paid and could not cancel), so it was
 * counted as a reservation implying a cleaning — but nobody ever entered the
 * room. Flagging a non-arrival also cancels the booking in Beds24, which drops
 * its checkout task from the cleaning app, so no cleaning is ever billed for it.
 *
 * Seen live in September 2026: Urban pool showed "Expected 32 vs 31 billed",
 * and the whole Δ was BH-91710143, a K.103 non-arrival whose freed nights were
 * resold to a guest departing on the same date.
 */

const K102 = '679703'; // Beds24 roomIds for the Urban pool
const K103 = '679704';

function res(over: Partial<Reservation> & Pick<Reservation, 'room' | 'checkInDate' | 'checkOutDate'>): Reservation {
  const nights =
    (new Date(over.checkOutDate).getTime() - new Date(over.checkInDate).getTime()) / 86_400_000;
  return {
    reservationNumber: `BH-${Math.random().toString(36).slice(2, 8)}`,
    firstName: 'A', lastName: 'B', channel: 'Direct', email: '', phone: '', nationality: 'CZ',
    reservationDate: over.checkInDate, bookingTimestamp: `${over.checkInDate}T10:00:00Z`,
    numberOfNights: nights, numberOfGuests: 2,
    price: 10_000, commissionAmount: 0, paymentChargeAmount: 0,
    cleaningStatus: 'Completed', paymentStatus: 'Paid', amountPaid: 10_000,
    additionalEmail: '', paymentStatusOverride: null, notes: '',
    manualFlagOverrides: {}, ratingStatus: 'None',
    ...over,
  } as unknown as Reservation;
}

/** A guest who paid but never came: cancelled in Beds24, revenue retained. */
function nonArrival(over: Partial<Reservation> & Pick<Reservation, 'room' | 'checkInDate' | 'checkOutDate'>): Reservation {
  return res({
    ...over,
    isCancelled: true,
    nonArrival: { flaggedAt: '2026-09-20T12:59:45.256Z', flaggedBy: 'ops@example.com', originalPriceCzk: 12_996 },
    nonArrivalNetPriceCzk: 12_996,
  } as Parameters<typeof res>[0]);
}

/** Billed cleanings, as (date|roomId) cost cells. */
function costs(cleaningKeys: string[]): VariableCostBundle {
  return {
    byDateRoom: Object.fromEntries(
      cleaningKeys.map((k) => [k, { cleaning: 500, laundry: 0, consumables: 0, wearTear: 0, misc: 0 }]),
    ),
    byReservation: {},
    subscriptionItems: [],
    manualCleaningKeys: [],
    noLaundryKeys: [],
    dismissedCleaningKeys: [],
  };
}

const URBAN = COMMISSION_UNITS.find((u) => u.id === 'K.102')!;
const settle = (reservations: Reservation[], cleaningKeys: string[]) =>
  computeSettlement(URBAN, '2026-09', reservations, costs(cleaningKeys));

describe('expected-cleanings reconciliation', () => {
  it('reconciles when every checkout has a billed cleaning', () => {
    const s = settle(
      [
        res({ room: 'K.102', checkInDate: '2026-09-03', checkOutDate: '2026-09-07' }),
        res({ room: 'K.103', checkInDate: '2026-09-10', checkOutDate: '2026-09-14' }),
      ],
      [`2026-09-07|${K102}`, `2026-09-14|${K103}`],
    );
    expect(s.reconciles).toBe(true);
  });

  it('still flags a checkout whose cleaning was never assigned', () => {
    // The badge has to keep doing its job — this is the case it exists for.
    const s = settle(
      [
        res({ room: 'K.102', checkInDate: '2026-09-03', checkOutDate: '2026-09-07' }),
        res({ room: 'K.103', checkInDate: '2026-09-10', checkOutDate: '2026-09-14' }),
      ],
      [`2026-09-07|${K102}`],
    );
    expect(s.reconciles).toBe(false);
    expect(s.reconcileNote).toContain('Expected 2 cleanings vs 1 billed');
  });

  it('does not expect a cleaning for a guest who never arrived', () => {
    const s = settle(
      [
        res({ room: 'K.102', checkInDate: '2026-09-03', checkOutDate: '2026-09-07' }),
        nonArrival({ room: 'K.103', checkInDate: '2026-09-20', checkOutDate: '2026-09-25' }),
      ],
      [`2026-09-07|${K102}`],
    );
    expect(s.reconciles).toBe(true);
  });

  it('keeps the replacement guest’s cleaning expected when the freed nights are resold', () => {
    // The live September case: the non-arrival and the guest who took the freed
    // nights both depart K.103 on the 25th. Subtracting the BOOKING is right;
    // suppressing the (date, room) cell would wrongly excuse a missing cleaning
    // for the guest who actually stayed.
    const reservations = [
      nonArrival({ room: 'K.103', checkInDate: '2026-09-20', checkOutDate: '2026-09-25' }),
      res({ room: 'K.103', checkInDate: '2026-09-24', checkOutDate: '2026-09-25' }),
    ];
    expect(settle(reservations, [`2026-09-25|${K103}`]).reconciles).toBe(true);
    // ...and with no cleaning billed at all, the real guest still raises a Δ.
    const missing = settle(reservations, []);
    expect(missing.reconciles).toBe(false);
    expect(missing.reconcileNote).toContain('Expected 1 cleanings vs 0 billed');
  });

  it('does not subtract a non-arrival twice when it departs next month', () => {
    // Already excluded by the next-month rule; subtracting again would
    // under-state expected cleanings and hide a genuinely missing one.
    const s = settle(
      [
        nonArrival({ room: 'K.102', checkInDate: '2026-09-28', checkOutDate: '2026-10-03' }),
        res({ room: 'K.103', checkInDate: '2026-09-10', checkOutDate: '2026-09-14' }),
      ],
      [],
    );
    expect(s.reconciles).toBe(false);
    expect(s.reconcileNote).toContain('Expected 1 cleanings vs 0 billed');
  });

  it('expects a cleaning for a guest who checks out on the 1st', () => {
    // Last night 31 Aug, checkout 1 Sep. Costs are on a checkout-date basis so
    // the cleaning is billed to September, but the stay has zero nights in
    // September — the engine's pre-filter (nights > 0) drops the reservation
    // entirely, so this used to read as an unexplained extra cleaning.
    const s = settle(
      [res({ room: 'K.102', checkInDate: '2026-08-28', checkOutDate: '2026-09-01' })],
      [`2026-09-01|${K102}`],
    );
    expect(s.reconciles).toBe(true);
  });

  it('still flags a 1st-of-month checkout whose cleaning was never assigned', () => {
    const s = settle([res({ room: 'K.102', checkInDate: '2026-08-28', checkOutDate: '2026-09-01' })], []);
    expect(s.reconciles).toBe(false);
    expect(s.reconcileNote).toContain('Expected 1 cleanings vs 0 billed');
  });

  it('does not double-count a stay that merely spans the month boundary', () => {
    // 28 Aug → 10 Sep HAS nights in September, so it is already counted the
    // normal way; the carry-in rule must not add it a second time.
    const s = settle(
      [res({ room: 'K.102', checkInDate: '2026-08-28', checkOutDate: '2026-09-10' })],
      [`2026-09-10|${K102}`],
    );
    expect(s.reconciles).toBe(true);
  });

  it('does not expect a carry-in cleaning for a cancelled booking', () => {
    const s = settle(
      [res({ room: 'K.102', checkInDate: '2026-08-28', checkOutDate: '2026-09-01', isCancelled: true })],
      [],
    );
    expect(s.reconciles).toBe(true);
  });

  it('keeps the non-arrival’s revenue — only the cleaning expectation changes', () => {
    const s = settle([nonArrival({ room: 'K.103', checkInDate: '2026-09-20', checkOutDate: '2026-09-25' })], []);
    expect(s.reconciles).toBe(true);
    expect(s.gbv).toBeGreaterThan(0); // pool ÷3 of the retained 12 996
  });
});
