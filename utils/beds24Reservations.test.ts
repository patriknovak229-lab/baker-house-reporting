import { describe, it, expect } from 'vitest';
import { mapToReservation, mapChannel, compactInvoiceItems, mergeGroupedBookings, APP_PHONE_MARKER, type Beds24Booking } from './beds24Reservations';

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

describe('mergeGroupedBookings — multi-apartment bookings', () => {
  const merged = (bookings: Beds24Booking[]) => mergeGroupedBookings(bookings).map(mapToReservation);

  // BH-95377263: Booking.com sold O.308 + an Urban studio as two bookings. The
  // studio stayed on the Urban virtual room, and the merge used to drop it —
  // the app showed plain "O.308" at the summed price, the resolver never saw
  // the studio, and its 2 guests vanished.
  const o308 = booking({
    id: 95377263, roomId: 674672, arrival: '2026-11-16', departure: '2026-11-18',
    numAdult: 4, price: 6290.2, status: 'new',
  });
  const urbanOnVr = booking({
    id: 95377264, masterId: 95377263, roomId: 679714, arrival: '2026-11-16', departure: '2026-11-18',
    numAdult: 2, price: 3897.58, status: 'new',
  });

  it('keeps an apartment still on a virtual room, flagged by its own booking number', () => {
    const rows = merged([{ ...o308 }, { ...urbanOnVr }]);
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.reservationNumber).toBe('BH-95377263');
    expect(r.room).toBe('O.308 + 1KK Urban Studios');
    expect(r.linkedRooms).toEqual(['O.308', '1KK Urban Studios']);
    expect(r.isUnallocatedVR).toBe(true);
    expect(r.unallocatedLegs).toEqual([{ reservationNumber: 'BH-95377264', room: '1KK Urban Studios' }]);
    expect(r.price).toBeCloseTo(10187.78, 2);
    expect(r.numberOfGuests).toBe(6);
    expect(r.linkedRoomShares![0]).toBeCloseTo(6290.2 / 10187.78, 6);
    expect(r.linkedRoomShares![1]).toBeCloseTo(3897.58 / 10187.78, 6);
  });

  it('clears the flag once the studio is in a unit, keeping each apartment\'s share', () => {
    const r = merged([{ ...o308 }, { ...urbanOnVr, roomId: 679705 }])[0];
    expect(r.room).toBe('O.308 + K.106');
    expect(r.isUnallocatedVR).toBeFalsy();
    expect(r.unallocatedLegs).toBeUndefined();
    expect(r.linkedRoomShares).toHaveLength(2);
    expect(r.numberOfGuests).toBe(6);
  });

  it('lists the master as the waiting apartment when it is the one on the virtual room', () => {
    const r = merged([
      { ...o308, roomId: 679714, price: 3897.58, numAdult: 2 },
      { ...urbanOnVr, roomId: 674672, price: 6290.2, numAdult: 4 },
    ])[0];
    expect(r.room).toBe('1KK Urban Studios + O.308');
    expect(r.unallocatedLegs).toEqual([{ reservationNumber: 'BH-95377263', room: '1KK Urban Studios' }]);
  });

  it('keeps both studios when two apartments wait on the same virtual room', () => {
    const r = merged([
      { ...o308, roomId: 679714, price: 4000 },
      { ...urbanOnVr, price: 4000 },
    ])[0];
    expect(r.linkedRooms).toEqual(['1KK Urban Studios', '1KK Urban Studios']);
    expect(r.unallocatedLegs!.map((l) => l.reservationNumber)).toEqual(['BH-95377263', 'BH-95377264']);
    expect(r.linkedRoomShares).toBeUndefined(); // equal prices → plain equal split
  });

  it('leaves equal-price Booking.com pairs on the equal split (BH-92334430)', () => {
    const r = merged([
      booking({ id: 92334430, roomId: 679704, price: 5374.34 }),
      booking({ id: 92334431, masterId: 92334430, roomId: 679703, price: 5374.34 }),
    ])[0];
    expect(r.room).toBe('K.103 + K.102');
    expect(r.linkedRoomShares).toBeUndefined();
    expect(r.numberOfGuests).toBe(4);
  });

  it('does not add up an Airbnb package\'s guests — its zero-price sub repeats them (BH-93698942)', () => {
    const r = merged([
      booking({ id: 93698942, roomId: 648772, price: 37548, numAdult: 4, apiSource: 'Airbnb' }),
      booking({ id: 93698943, masterId: 93698942, roomId: 648596, price: 0, numAdult: 4, apiSource: 'Airbnb' }),
    ])[0];
    expect(r.room).toBe('K.203 + K.202');
    expect(r.numberOfGuests).toBe(4);
    expect(r.price).toBe(37548);
    expect(r.linkedRoomShares).toBeUndefined();
  });

  it('treats a virtual-room master Beds24 sub-allocated at price 0 as a wrapper, not an apartment', () => {
    const r = merged([
      booking({ id: 500, roomId: 648816, price: 8000, apiSource: 'Direct', referer: 'API' }),
      booking({ id: 501, masterId: 500, roomId: 648596, price: 0, apiSource: 'Direct', referer: 'API' }),
    ])[0];
    expect(r.room).toBe('K.202');
    expect(r.isUnallocatedVR).toBeFalsy();
    expect(r.unallocatedLegs).toBeUndefined();
  });

  it('keeps a multi-row app booking\'s row that is still on a virtual room', () => {
    const marker = `${APP_PHONE_MARKER}\n[GROUP:pkg-test]`;
    const r = merged([
      booking({ id: 600, roomId: 674672, price: 6000, apiSource: 'Direct', referer: 'API', comments: marker }),
      booking({ id: 601, roomId: 679714, price: 3000, apiSource: 'Direct', referer: 'API', comments: marker }),
    ])[0];
    expect(r.room).toBe('O.308 + 1KK Urban Studios');
    expect(r.unallocatedLegs).toEqual([{ reservationNumber: 'BH-601', room: '1KK Urban Studios' }]);
    expect(r.price).toBe(9000);
    expect(r.linkedRoomShares).toEqual([6000 / 9000, 3000 / 9000]);
    expect(r.apartmentReservationNumbers).toEqual(['BH-600', 'BH-601']);
  });

  // BH-93698209: three Weekly-rate apartments, one booking each. The cleaning
  // app keys each apartment's cleaning by that booking, so the wine published
  // under the master alone only ever reached K.102.
  it('names each apartment\'s own booking, in room order', () => {
    const r = merged([
      booking({ id: 93698209, roomId: 679703, price: 11652.08 }),
      booking({ id: 93698210, masterId: 93698209, roomId: 674672, price: 17419.5 }),
      booking({ id: 93698211, masterId: 93698209, roomId: 679704, price: 11652.08 }),
    ])[0];
    expect(r.linkedRooms).toEqual(['K.102', 'O.308', 'K.103']);
    expect(r.apartmentReservationNumbers).toEqual(['BH-93698209', 'BH-93698210', 'BH-93698211']);
  });

  it('names the apartment Beds24 placed a wrapper in, not the wrapper', () => {
    const r = merged([
      booking({ id: 500, roomId: 648816, price: 8000, apiSource: 'Direct', referer: 'API' }),
      booking({ id: 501, masterId: 500, roomId: 648596, price: 0, apiSource: 'Direct', referer: 'API' }),
    ])[0];
    expect(r.reservationNumber).toBe('BH-500');
    expect(r.apartmentReservationNumbers).toEqual(['BH-501']);
  });

  it('leaves a plain single booking without an apartment list', () => {
    expect(merged([booking()])[0].apartmentReservationNumbers).toBeUndefined();
  });
});
