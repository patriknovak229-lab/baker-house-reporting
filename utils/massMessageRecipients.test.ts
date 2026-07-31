import { describe, it, expect } from 'vitest';
import {
  resolveRecipients,
  tallyRecipients,
  addDays,
  type ResolveOptions,
} from './massMessageRecipients';
import type { Reservation } from '@/types/reservation';

const TODAY = '2026-07-31';

/** Minimal valid Reservation with overridable fields. Defaults to a live,
 *  in-house Booking.com stay so tests only set what they're exercising. */
function res(overrides: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: 'BH-1000',
    firstName: 'Jane',
    lastName: 'Doe',
    channel: 'Booking.com',
    room: 'K.201',
    checkInDate: '2026-07-30',
    checkOutDate: '2026-08-02',
    reservationDate: '2026-07-01',
    bookingTimestamp: '2026-07-01T10:00:00Z',
    numberOfNights: 3,
    numberOfGuests: 2,
    email: 'conduit@booking.com',
    phone: '+420123456789',
    price: 9000,
    nationality: 'GB',
    cleaningStatus: 'Pending',
    paymentStatus: 'Paid',
    amountPaid: 9000,
    commissionAmount: 0,
    paymentChargeAmount: 0,
    additionalEmail: '',
    paymentStatusOverride: null,
    notes: '',
    manualFlagOverrides: {},
    ratingStatus: 'none',
    invoiceData: null,
    invoiceStatus: 'Not Issued',
    ...overrides,
  };
}

const opts = (o: Partial<ResolveOptions> = {}): ResolveOptions => ({
  segment: 'staying',
  days: 0,
  emailDirect: true,
  today: TODAY,
  ...o,
});

describe('addDays', () => {
  it('adds days across month boundaries', () => {
    expect(addDays('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDays('2026-07-31', 0)).toBe('2026-07-31');
    expect(addDays('2026-07-31', 3)).toBe('2026-08-03');
  });
});

describe('segment: staying', () => {
  it('includes an in-house guest', () => {
    const out = resolveRecipients([res()], opts({ segment: 'staying' }));
    expect(out).toHaveLength(1);
  });

  it('includes a guest arriving today and a guest leaving today (checkout-inclusive)', () => {
    const arrivingToday = res({ reservationNumber: 'BH-1', checkInDate: TODAY, checkOutDate: '2026-08-03' });
    const leavingToday = res({ reservationNumber: 'BH-2', checkInDate: '2026-07-28', checkOutDate: TODAY });
    const out = resolveRecipients([arrivingToday, leavingToday], opts({ segment: 'staying' }));
    expect(out.map((r) => r.reservationNumber).sort()).toEqual(['BH-1', 'BH-2']);
  });

  it('excludes a guest who already left and one who has not arrived', () => {
    const left = res({ reservationNumber: 'BH-1', checkInDate: '2026-07-20', checkOutDate: '2026-07-30' });
    const future = res({ reservationNumber: 'BH-2', checkInDate: '2026-08-05', checkOutDate: '2026-08-08' });
    const out = resolveRecipients([left, future], opts({ segment: 'staying' }));
    expect(out).toHaveLength(0);
  });
});

describe('segment: arriving', () => {
  it('includes check-ins from today through today+days inclusive', () => {
    const today = res({ reservationNumber: 'BH-1', checkInDate: TODAY, checkOutDate: '2026-08-04' });
    const inWindow = res({ reservationNumber: 'BH-2', checkInDate: '2026-08-03', checkOutDate: '2026-08-06' });
    const justOut = res({ reservationNumber: 'BH-3', checkInDate: '2026-08-04', checkOutDate: '2026-08-06' });
    const out = resolveRecipients([today, inWindow, justOut], opts({ segment: 'arriving', days: 3 }));
    expect(out.map((r) => r.reservationNumber).sort()).toEqual(['BH-1', 'BH-2']);
  });

  it('days=0 means arriving today only', () => {
    const today = res({ reservationNumber: 'BH-1', checkInDate: TODAY, checkOutDate: '2026-08-04' });
    const tomorrow = res({ reservationNumber: 'BH-2', checkInDate: '2026-08-01', checkOutDate: '2026-08-04' });
    const out = resolveRecipients([today, tomorrow], opts({ segment: 'arriving', days: 0 }));
    expect(out.map((r) => r.reservationNumber)).toEqual(['BH-1']);
  });
});

describe('segment: leaving', () => {
  it('includes check-outs from today through today+days inclusive', () => {
    const leavingToday = res({ reservationNumber: 'BH-1', checkInDate: '2026-07-28', checkOutDate: TODAY });
    const leavingIn2 = res({ reservationNumber: 'BH-2', checkInDate: '2026-07-28', checkOutDate: '2026-08-02' });
    const leavingIn5 = res({ reservationNumber: 'BH-3', checkInDate: '2026-07-28', checkOutDate: '2026-08-05' });
    const out = resolveRecipients([leavingToday, leavingIn2, leavingIn5], opts({ segment: 'leaving', days: 2 }));
    expect(out.map((r) => r.reservationNumber).sort()).toEqual(['BH-1', 'BH-2']);
  });
});

describe('exclusions', () => {
  it('drops blackouts, cancellations, non-arrivals, refunds, and non-BH rows', () => {
    const rows = [
      res({ reservationNumber: 'BH-1', isBlackout: true }),
      res({ reservationNumber: 'BH-2', isCancelled: true }),
      res({
        reservationNumber: 'BH-3',
        nonArrival: { flaggedAt: 'x', flaggedBy: 'y', originalPriceCzk: 1 },
      }),
      res({ reservationNumber: 'BH-4', paymentStatus: 'Refunded' }),
      res({ reservationNumber: 'OV-656437-2026-07-30-2026-08-02' }),
    ];
    const out = resolveRecipients(rows, opts({ segment: 'staying' }));
    expect(out).toHaveLength(0);
  });
});

describe('channel classification', () => {
  it('OTA → chat with the parsed Beds24 booking id', () => {
    const out = resolveRecipients([res({ reservationNumber: 'BH-12345', channel: 'Airbnb' })], opts());
    expect(out[0]).toMatchObject({ delivery: 'chat', bookingId: 12345 });
  });

  it('OTA with an unparseable id → unreachable/bad-booking-id', () => {
    const out = resolveRecipients([res({ reservationNumber: 'BH-xyz', channel: 'Booking.com' })], opts());
    expect(out[0]).toMatchObject({ delivery: 'unreachable', reason: 'bad-booking-id' });
  });

  it('Direct with a real email → email', () => {
    const out = resolveRecipients(
      [res({ reservationNumber: 'BH-5', channel: 'Direct-Web', additionalEmail: 'guest@real.com' })],
      opts(),
    );
    expect(out[0]).toMatchObject({ delivery: 'email', email: 'guest@real.com' });
  });

  it('Direct with no email → unreachable/no-email', () => {
    const out = resolveRecipients(
      [res({ reservationNumber: 'BH-6', channel: 'Direct-Phone', email: '', additionalEmail: '' })],
      opts(),
    );
    expect(out[0]).toMatchObject({ delivery: 'unreachable', reason: 'no-email' });
  });

  it('Direct is unreachable/email-disabled when emailDirect is off', () => {
    const out = resolveRecipients(
      [res({ reservationNumber: 'BH-7', channel: 'Direct', additionalEmail: 'guest@real.com' })],
      opts({ emailDirect: false }),
    );
    expect(out[0]).toMatchObject({ delivery: 'unreachable', reason: 'email-disabled' });
  });

  it('email preference: additionalEmail > invoice billing > raw email', () => {
    const billingOnly = res({
      reservationNumber: 'BH-8',
      channel: 'Direct',
      email: 'raw@x.com',
      additionalEmail: '',
      invoiceData: {
        companyName: '', companyAddress: '', ico: '', vatNumber: '',
        billingEmail: 'billing@x.com',
      },
    });
    const out = resolveRecipients([billingOnly], opts());
    expect(out[0].email).toBe('billing@x.com');
  });
});

describe('dedup', () => {
  it('collapses two direct bookings sharing an email to one email', () => {
    const a = res({ reservationNumber: 'BH-10', channel: 'Direct', additionalEmail: 'Same@x.com' });
    const b = res({ reservationNumber: 'BH-11', channel: 'Direct', additionalEmail: 'same@x.com' });
    const out = resolveRecipients([a, b], opts());
    const emails = out.filter((r) => r.delivery === 'email');
    expect(emails).toHaveLength(1);
  });

  it('keeps two distinct OTA bookings as separate chat sends', () => {
    const a = res({ reservationNumber: 'BH-20', channel: 'Booking.com' });
    const b = res({ reservationNumber: 'BH-21', channel: 'Airbnb' });
    const out = resolveRecipients([a, b], opts());
    expect(out.filter((r) => r.delivery === 'chat')).toHaveLength(2);
  });
});

describe('tallyRecipients', () => {
  it('counts each delivery bucket', () => {
    const rows = [
      res({ reservationNumber: 'BH-1', channel: 'Booking.com' }),
      res({ reservationNumber: 'BH-2', channel: 'Direct', additionalEmail: 'a@x.com' }),
      res({ reservationNumber: 'BH-3', channel: 'Direct', email: '', additionalEmail: '' }),
    ];
    const counts = tallyRecipients(resolveRecipients(rows, opts()));
    expect(counts).toEqual({ chat: 1, email: 1, unreachable: 1, total: 3 });
  });
});
