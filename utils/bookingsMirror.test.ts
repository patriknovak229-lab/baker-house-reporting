import { describe, it, expect } from 'vitest';
import { toBookingsMirrorRow, bookingsMirrorWriteEnabled, isMirrorRowWritable } from './bookingsMirror';
import { mapToReservation, type Beds24Booking } from './beds24Reservations';
import type { Reservation } from '@/types/reservation';

/** Minimal normalized reservation; individual tests override the fields they assert. */
function reservation(over: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: 'BH-12345',
    firstName: 'Jan',
    lastName: 'Novák',
    channel: 'Booking.com',
    room: 'K.201',
    checkInDate: '2026-09-01',
    checkOutDate: '2026-09-04',
    reservationDate: '2026-08-01',
    bookingTimestamp: '2026-08-01T09:30:00.000Z',
    numberOfNights: 3,
    numberOfGuests: 2,
    email: 'jan@example.com',
    phone: '+420777123456',
    price: 9000,
    nationality: 'CZ',
    cleaningStatus: 'Pending',
    paymentStatus: 'Paid',
    amountPaid: 9000,
    commissionAmount: 1350.5,
    paymentChargeAmount: 0,
    additionalEmail: '',
    paymentStatusOverride: null,
    notes: '',
    manualFlagOverrides: {},
    ratingStatus: 'none',
    syncedRating: null,
    invoiceData: null,
    invoiceStatus: 'Not Issued',
    ...over,
  };
}

const row = (r: Reservation, apiReference?: string | null) =>
  toBookingsMirrorRow(r, { source: 'beds24-booking', apiReference });

describe('bookingsMirrorWriteEnabled', () => {
  const set = (v: string | undefined) => {
    if (v === undefined) delete process.env.WRITE_BOOKINGS_MIRROR;
    else process.env.WRITE_BOOKINGS_MIRROR = v;
  };

  it('is off unless explicitly enabled — deploying the mirror must be a no-op', () => {
    const original = process.env.WRITE_BOOKINGS_MIRROR;
    try {
      set(undefined);
      expect(bookingsMirrorWriteEnabled()).toBe(false);
      set('');
      expect(bookingsMirrorWriteEnabled()).toBe(false);
      set('false');
      expect(bookingsMirrorWriteEnabled()).toBe(false);
      set('yes');
      expect(bookingsMirrorWriteEnabled()).toBe(false);
      set('TRUE');
      expect(bookingsMirrorWriteEnabled()).toBe(true);
      set('1');
      expect(bookingsMirrorWriteEnabled()).toBe(true);
    } finally {
      set(original);
    }
  });
});

describe('toBookingsMirrorRow', () => {
  it('projects the normalized reservation onto columns', () => {
    const r = row(reservation({ status: 'confirmed', rateType: 'Non-Refundable' }), 'REF-9');
    expect(r).toMatchObject({
      reservationNumber: 'BH-12345',
      source: 'beds24-booking',
      beds24Id: 12345,
      apiReference: 'REF-9',
      channel: 'Booking.com',
      room: 'K.201',
      checkInDate: '2026-09-01',
      checkOutDate: '2026-09-04',
      reservationDate: '2026-08-01',
      numberOfNights: 3,
      numberOfGuests: 2,
      status: 'confirmed',
      rateType: 'Non-Refundable',
    });
    expect(r.bookingTimestamp).toEqual(new Date('2026-08-01T09:30:00.000Z'));
  });

  it('keeps money exact as unbounded-numeric strings (sub-unit precision survives)', () => {
    const r = row(reservation({ price: 12345.678, commissionAmount: 1851.8517, amountPaid: 0.01 }));
    expect(r.price).toBe('12345.678');
    expect(r.commissionAmount).toBe('1851.8517');
    expect(r.amountPaid).toBe('0.01');
  });

  it('maps the normalizer\'s empty-string dates to null, not an invalid date', () => {
    // Blackout rows from the inventory calendar carry reservationDate: ''.
    const r = row(reservation({ reservationDate: '', bookingTimestamp: '', checkInDate: '' }));
    expect(r.reservationDate).toBeNull();
    expect(r.bookingTimestamp).toBeNull();
    expect(r.checkInDate).toBeNull();
  });

  it('never emits a value that would abort the insert batch', () => {
    const r = row(reservation({ price: NaN, numberOfNights: NaN, modifiedAt: 'not-a-date' }));
    expect(r.price).toBe('0');
    expect(r.numberOfNights).toBe(0);
    expect(r.modifiedAt).toBeNull();
  });

  it('flattens the optional booking flags to real booleans', () => {
    const plain = row(reservation());
    expect([plain.isCancelled, plain.isBlackout, plain.isUnallocatedVr]).toEqual([false, false, false]);

    const flagged = row(reservation({ isCancelled: true, isBlackout: true, isUnallocatedVR: true }));
    expect([flagged.isCancelled, flagged.isBlackout, flagged.isUnallocatedVr]).toEqual([true, true, true]);
  });

  it('stores linkedRooms only for real multi-room packages', () => {
    expect(row(reservation()).linkedRooms).toBeNull();
    expect(row(reservation({ linkedRooms: [] })).linkedRooms).toBeNull();
    expect(row(reservation({ linkedRooms: ['K.202', 'K.203'] })).linkedRooms).toEqual(['K.202', 'K.203']);
  });

  it('has no beds24 id for a synthetic inventory-override blackout row', () => {
    const r = toBookingsMirrorRow(
      reservation({ reservationNumber: 'OV-679704-2026-09-01-2026-09-03', isBlackout: true }),
      { source: 'inventory-override' },
    );
    expect(r.beds24Id).toBeNull();
    expect(r.source).toBe('inventory-override');
    expect(r.apiReference).toBeNull();
  });

  it('leaves freshness stamping to the database', () => {
    // synced_at / first_seen_at must be column-defaulted, never caller-supplied —
    // a skewed CLI clock would otherwise poison the staleness signal.
    const r = row(reservation());
    expect('syncedAt' in r).toBe(false);
    expect('firstSeenAt' in r).toBe(false);
  });

  it('carries the raw booking so history can be re-projected later', () => {
    const raw = { id: 12345, arrival: '2026-09-01' };
    const r = toBookingsMirrorRow(reservation(), { source: 'beds24-booking', raw });
    expect(r.raw).toEqual(raw);
    // Blackout rows have no source booking.
    expect(toBookingsMirrorRow(reservation(), { source: 'inventory-override' }).raw).toBeNull();
  });

  it('round-trips a real mapToReservation output — the projection stays in step with the normalizer', () => {
    const booking: Beds24Booking = {
      id: 84991234,
      roomId: 679704, // K.103
      arrival: '2026-09-10',
      departure: '2026-09-13',
      numAdult: 2,
      numChild: 1,
      price: 7500,
      deposit: 7500,
      commission: 1125,
      rateDescription: '3 nights',
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      phone: '+447700900000',
      country: null,
      country2: 'GB',
      apiSource: 'Booking.com',
      referer: '',
      bookingTime: '2026-08-05T12:00:00.000Z',
      status: 'confirmed',
      comments: 'PRE-PAID',
    };
    const r = row(mapToReservation(booking));
    expect(r).toMatchObject({
      reservationNumber: 'BH-84991234',
      beds24Id: 84991234,
      channel: 'Booking.com',
      room: 'K.103',
      checkInDate: '2026-09-10',
      checkOutDate: '2026-09-13',
      numberOfNights: 3,
      numberOfGuests: 3,
      nationality: 'GB',
      price: '7500',
      amountPaid: '7500',
      commissionAmount: '1125',
      paymentChargeAmount: '0',
      paymentStatus: 'Paid',
      isCancelled: false,
      isBlackout: false,
    });
  });
});

describe('isMirrorRowWritable', () => {
  // The archive is upsert-only, so a degraded row doesn't just look wrong — it
  // permanently overwrites good history. Both stay dates are the trust signal.
  it('accepts a normal booking', () => {
    expect(isMirrorRowWritable(row(reservation()))).toBe(true);
  });

  it('rejects a row whose stay dates were blank-coerced by the normalizer', () => {
    expect(isMirrorRowWritable(row(reservation({ checkInDate: '' })))).toBe(false);
    expect(isMirrorRowWritable(row(reservation({ checkOutDate: '' })))).toBe(false);
    expect(isMirrorRowWritable(row(reservation({ checkInDate: '', checkOutDate: '' })))).toBe(false);
  });

  it('still accepts cancellations and blackouts — they carry real dates', () => {
    expect(isMirrorRowWritable(row(reservation({ isCancelled: true, status: 'cancelled' })))).toBe(true);
    const blackout = toBookingsMirrorRow(
      reservation({ reservationNumber: 'OV-679704-2026-09-01-2026-09-03', isBlackout: true, reservationDate: '' }),
      { source: 'inventory-override' },
    );
    expect(isMirrorRowWritable(blackout)).toBe(true);
  });
});
