import { describe, it, expect } from 'vitest';
import { mapToReservation, mapChannel, compactInvoiceItems, APP_PHONE_MARKER, type Beds24Booking } from './beds24Reservations';

// Regression guard for the pipeline extracted out of app/api/bookings/route.ts:
// occupancy correctness depends on room mapping, dates and status being stable.
function booking(overrides: Partial<Beds24Booking> = {}): Beds24Booking {
  return {
    id: 111,
    roomId: 656437, // K.201
    masterId: null,
    arrival: '2026-08-01',
    departure: '2026-08-04',
    numAdult: 2,
    numChild: 0,
    price: 9000,
    deposit: 0,
    commission: 0,
    rateDescription: '',
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    phone: '+420123456789',
    country: null,
    country2: 'GB',
    apiSource: 'Booking.com',
    referer: '',
    bookingTime: '2026-07-01T10:00:00Z',
    status: 'confirmed',
    comments: '',
    ...overrides,
  };
}

describe('mapToReservation', () => {
  it('maps a physical-room Booking.com stay (room, dates, nights, channel)', () => {
    const r = mapToReservation(booking());
    expect(r).toMatchObject({
      reservationNumber: 'BH-111',
      room: 'K.201',
      checkInDate: '2026-08-01',
      checkOutDate: '2026-08-04',
      numberOfNights: 3,
      channel: 'Booking.com',
    });
    expect(r.isBlackout).toBeFalsy();
    expect(r.isCancelled).toBeFalsy();
  });

  it('flags a blackout (status "black")', () => {
    const r = mapToReservation(booking({ status: 'black' }));
    expect(r.isBlackout).toBe(true);
  });

  it('flags a cancellation (status "cancelled")', () => {
    const r = mapToReservation(booking({ status: 'cancelled' }));
    expect(r.isCancelled).toBe(true);
  });

  it('labels an unknown room id rather than mis-attributing it', () => {
    const r = mapToReservation(booking({ roomId: 999999 }));
    expect(r.room).toBe('Unknown room 999999');
  });

  it('reads the additional guests the New Booking modal writes into comments', () => {
    const r = mapToReservation(booking({
      comments: `${APP_PHONE_MARKER}\n[ADDITIONAL GUESTS: Jana Nováková; Petr Novák]\nLate arrival`,
    }));
    expect(r.additionalGuests).toEqual(['Jana Nováková', 'Petr Novák']);
    expect(r.firstName).not.toContain('Jana');
  });

  it('leaves additionalGuests off a booking without the marker', () => {
    expect('additionalGuests' in mapToReservation(booking())).toBe(false);
  });
});

describe('mapChannel', () => {
  it('recognises OTAs and the app phone-booking marker', () => {
    expect(mapChannel('Booking.com', '', '')).toBe('Booking.com');
    expect(mapChannel('Airbnb', '', '')).toBe('Airbnb');
    expect(mapChannel('Direct', 'API', '[Created via Reporting App — Phone]')).toBe('Direct-Phone');
    expect(mapChannel('Direct', 'API', '')).toBe('Direct-Web');
  });

  it('recognises Google Hotel Ads bookings (BH-95080626)', () => {
    expect(mapChannel('Google Ads', 'google', '')).toBe('Google');
  });
});

/**
 * Google Hotel Ads go through the Beds24 booking page, which fills `deposit`
 * with the amount it ASKED for whether or not the guest paid. Only Beds24's
 * payment lines may make such a booking Paid. Bookings go through
 * compactInvoiceItems first, as they do in the sync.
 */
describe('payment status', () => {
  const synced = (b: Beds24Booking) => mapToReservation(compactInvoiceItems(b));
  const charge = (amount: number) => ({ type: 'charge', subType: 1, amount });
  const payment = (amount: number) => ({ type: 'payment', subType: 200, amount });
  const google = (overrides: Partial<Beds24Booking> = {}) =>
    booking({ apiSource: 'Google Ads', referer: 'google', status: 'confirmed', price: 11968.8, deposit: 11968.8, ...overrides });

  it('BH-95080626 (never paid, deposit = price, no payment line) is Unpaid', () => {
    const r = synced(google({ id: 95080626, status: 'cancelled', invoiceItems: [charge(11968.8)] }));
    expect(r.channel).toBe('Google');
    expect(r).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: 0 });
  });

  it('a Google booking with a payment line equal to the price is Paid', () => {
    const r = synced(google({ invoiceItems: [charge(11968.8), payment(11968.8)] }));
    expect(r).toMatchObject({ paymentStatus: 'Paid', amountPaid: 11968.8 });
  });

  it('a Google booking paid in part is Partially Paid', () => {
    const r = synced(google({ invoiceItems: [charge(11968.8), payment(1196.88)] }));
    expect(r).toMatchObject({ paymentStatus: 'Partially Paid', amountPaid: 1196.88 });
  });

  it('a Google booking cached before invoice items were fetched is Unpaid', () => {
    expect(mapToReservation(google())).toMatchObject({ paymentStatus: 'Unpaid', amountPaid: 0 });
  });

  it('Direct-Web still reads deposit, which the rental site writes only after Stripe succeeds', () => {
    const r = synced(booking({ apiSource: 'Direct', referer: 'API', price: 9000, deposit: 9000, invoiceItems: [charge(9000)] }));
    expect(r.channel).toBe('Direct-Web');
    expect(r).toMatchObject({ paymentStatus: 'Paid', amountPaid: 9000 });
  });

  it('folds invoice items into paymentsReceived and drops the array', () => {
    const b = compactInvoiceItems(booking({ invoiceItems: [charge(4431.75), payment(3231.75), payment(-231.75)] }));
    expect(b.paymentsReceived).toBe(3000);
    expect('invoiceItems' in b).toBe(false);
  });
});

/**
 * Phone bookings sell the same single direct rate as the website, so the mapper
 * has to hand them out on Standard — legacy Direct (Beds24-UI entries of unknown
 * origin) must still come back without a rate.
 */
describe('Direct-Phone rate plan end-to-end', () => {
  const future = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const phone = () =>
    booking({
      apiSource: 'Direct',
      referer: 'API', // Beds24 overrides referer on every V2 POST
      comments: `${APP_PHONE_MARKER} taken by phone`,
      arrival: future(5),
      departure: future(8),
      bookingTime: `${future(-2)} 09:00:00`,
    });

  it('maps an app phone booking to Direct-Phone on the Standard rate', () => {
    const r = mapToReservation(phone());
    expect(r.channel).toBe('Direct-Phone');
    expect(r.rateType).toBe('Standard');
  });

  it('leaves legacy Direct without a rate', () => {
    const r = mapToReservation({ ...phone(), comments: '', referer: '' });
    expect(r.channel).toBe('Direct');
    expect(r.rateType).toBeUndefined();
  });
});
