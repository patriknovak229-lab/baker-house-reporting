import { describe, it, expect } from 'vitest';
import {
  buildCorporateBookingPayload,
  describeBeds24Failure,
  effectiveGuest,
  extractBookingId,
  parseBeds24BatchResponse,
} from './corporateBooking';
import { APP_PHONE_MARKER } from './beds24Reservations';
import { corporateMarker, parseCorporateMarker, type CorporateAgreement, type CorporateStay } from './corporateShared';

function agreement(overrides: Partial<CorporateAgreement> = {}): CorporateAgreement {
  return {
    id: 'CA-mg1x2a-k9z3',
    companyName: 'Acme s.r.o.',
    companyAddress: null,
    ico: '12345678',
    vatNumber: null,
    billingEmail: 'invoices@acme.cz',
    billingCadence: 'monthly',
    repName: 'Jana Nová',
    repPhone: '+420777000111',
    repEmail: 'jana@acme.cz',
    guestFirstName: null,
    guestLastName: null,
    guestPhone: null,
    guestEmail: null,
    adults: 1,
    children: 0,
    nationality: 'CZ',
    roomIds: [679714, 648816],
    preferredRoomId: 679714,
    startDate: '2026-10-12',
    endDate: '2026-12-17',
    nightWeekdays: [1, 2],
    pricingMode: 'flat',
    flatNightPriceCzk: 1850,
    discountPercent: 0,
    notes: 'Parking needed',
    status: 'draft',
    createdBy: 'op@example.com',
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  };
}

function stay(overrides: Partial<CorporateStay> = {}): CorporateStay {
  return {
    id: 'CS-mg1x2a-k9z3-003',
    agreementId: 'CA-mg1x2a-k9z3',
    seq: 3,
    arrival: '2026-10-26',
    departure: '2026-10-28',
    nights: 2,
    roomId: 679714,
    guestFirstName: null,
    guestLastName: null,
    guestPhone: null,
    guestEmail: null,
    listPriceCzk: null,
    priceCzk: 3700,
    priceSource: 'flat',
    status: 'planned',
    beds24BookingId: null,
    reservationNumber: null,
    error: null,
    bookedAt: null,
    createdAt: '2026-10-06T10:00:00.000Z',
    updatedAt: '2026-10-06T10:00:00.000Z',
    ...overrides,
  };
}

describe('effectiveGuest', () => {
  it('the stay’s own guest wins over the agreement default', () => {
    const g = effectiveGuest(agreement({ guestFirstName: 'Petr', guestLastName: 'Svoboda', guestPhone: '+420111' }), stay({ guestFirstName: 'Eva', guestLastName: 'Kratochvílová' }));
    expect(g).toMatchObject({ firstName: 'Eva', lastName: 'Kratochvílová', phone: '+420111', placeholder: false });
  });
  it('falls back to the agreement default, then the company as a TBA placeholder', () => {
    expect(effectiveGuest(agreement({ guestFirstName: 'Petr', guestLastName: 'Svoboda' }), stay())).toMatchObject({ firstName: 'Petr', lastName: 'Svoboda', placeholder: false });
    expect(effectiveGuest(agreement(), stay())).toMatchObject({ firstName: 'Acme s.r.o.', lastName: 'TBA', placeholder: true });
  });
  it('phone falls through to the company contact; email never does', () => {
    const g = effectiveGuest(agreement(), stay());
    expect(g.phone).toBe('+420777000111');
    expect(g.email).toBe('');
  });
});

describe('buildCorporateBookingPayload', () => {
  const payload = buildCorporateBookingPayload(agreement(), stay(), 10);

  it('is a confirmed direct booking on the sellable room with both comment markers', () => {
    expect(payload).toMatchObject({
      roomId: 679714,
      status: 'confirmed',
      arrival: '2026-10-26',
      departure: '2026-10-28',
      numAdult: 1,
      numChild: 0,
      company: 'Acme s.r.o.',
      country: 'cz',
      lang: 'cs',
      referer: 'PhoneDirect',
      flagText: 'Corporate',
      actions: { checkAvailability: true },
    });
    expect(payload.comments).toContain(APP_PHONE_MARKER);
    expect(payload.comments).toContain(corporateMarker('CA-mg1x2a-k9z3'));
    expect(payload.comments).toContain('Corporate stay 3/10 · Acme s.r.o.');
    expect(payload.comments).toContain('Parking needed');
    expect(parseCorporateMarker(payload.comments)).toBe('CA-mg1x2a-k9z3');
  });

  it('writes the agreed price as the booking price and one accommodation charge', () => {
    expect(payload.price).toBe(3700);
    expect(payload.invoiceItems).toEqual([{ type: 'charge', subType: 1, description: 'Accommodation', qty: 1, amount: 3700 }]);
  });

  it('puts invoicing facts in the internal notes', () => {
    expect(payload.notes).toContain('IČO 12345678');
    expect(payload.notes).toContain('Monthly');
    expect(payload.notes).toContain('invoices@acme.cz');
    expect(payload.notes).toContain('Jana Nová');
  });

  it('uses the placeholder guest when none is known', () => {
    expect(payload.firstName).toBe('Acme s.r.o.');
    expect(payload.lastName).toBe('TBA');
    expect(payload.phone).toBe('+420777000111');
  });
});

describe('Beds24 batch reply parsing', () => {
  it('reads ids from the bare-array and wrapped shapes', () => {
    expect(parseBeds24BatchResponse([{ success: true, new: { id: 101 } }, { success: true, id: 102 }], 2)).toEqual([
      { ok: true, bookingId: 101, error: null },
      { ok: true, bookingId: 102, error: null },
    ]);
    expect(parseBeds24BatchResponse({ data: [{ success: true, new: { id: '103' } }] }, 1)).toEqual([{ ok: true, bookingId: 103, error: null }]);
  });

  it('reports a refused item with Beds24’s reason', () => {
    const r = parseBeds24BatchResponse([{ success: false, errors: [{ action: 'create', field: 'roomId', message: 'No availability' }] }], 1);
    expect(r[0]).toEqual({ ok: false, bookingId: null, error: 'roomId: No availability' });
  });

  it('marks everything unverified when the counts do not match', () => {
    const r = parseBeds24BatchResponse([{ success: true, new: { id: 1 } }], 2);
    expect(r).toHaveLength(2);
    expect(r.every((x) => !x.ok && x.error?.includes('cannot match'))).toBe(true);
  });

  it('a success without an id is unverified, not created', () => {
    const r = parseBeds24BatchResponse([{ success: true }], 1);
    expect(r[0].ok).toBe(false);
    expect(r[0].error).toMatch(/no id/);
  });

  it('extractBookingId never reads a nested errors array as an id', () => {
    expect(extractBookingId({ success: false, errors: [{ id: 5 }] })).toBeNull();
    expect(extractBookingId({ new: { id: 7, info: 'x' } })).toBe(7);
    expect(extractBookingId(null)).toBeNull();
  });

  it('describeBeds24Failure falls back to message/info/raw', () => {
    expect(describeBeds24Failure({ message: 'Rate limit' })).toBe('Rate limit');
    expect(describeBeds24Failure({ info: 'Nope' })).toBe('Nope');
    expect(describeBeds24Failure({ weird: true })).toBe('{"weird":true}');
  });
});
