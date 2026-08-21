import { describe, it, expect } from 'vitest';
import { mapToReservation, mapChannel, APP_PHONE_MARKER, type Beds24Booking } from './beds24Reservations';

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
});

describe('mapChannel', () => {
  it('recognises OTAs and the app phone-booking marker', () => {
    expect(mapChannel('Booking.com', '', '')).toBe('Booking.com');
    expect(mapChannel('Airbnb', '', '')).toBe('Airbnb');
    expect(mapChannel('Direct', 'API', '[Created via Reporting App — Phone]')).toBe('Direct-Phone');
    expect(mapChannel('Direct', 'API', '')).toBe('Direct-Web');
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
