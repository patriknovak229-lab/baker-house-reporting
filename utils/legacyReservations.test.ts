import { describe, it, expect } from 'vitest';
import {
  assignRoom,
  cnbQuote,
  parseAirbnbPayouts,
  parseBookingComExport,
  parseCnbYear,
  parseCsv,
  parseExclusions,
  pragueLocalToIso,
  toLegacyMirrorRow,
} from './legacyReservations';

const BCOM_HEADER =
  'Číslo rezervace,Rezervoval/a,Jméno hosta,Příjezd,Odjezd,Provedení rezervace,Status,Pokoje,Počet osob,Cena,Procento provize,Výše provize,Booker country,Typ ubytovací jednotky,Délka pobytu (noci),Datum zrušení rezervace,Adresa,Telefonní číslo';

const AIRBNB_HEADER =
  'Date,Arriving by date,Type,Confirmation code,Booking date,Start date,End date,Nights,Guest,Listing,Details,Reference code,Currency,Amount,Paid out,Service fee,Fast pay fee,Cleaning fee,Gross earnings,Airbnb remitted tax,Earnings year';

const CNB = parseCnbYear(
  ['Date|1 AUD|1 EUR|100 HUF', '05.12.2025|15,000|24,200|6,100', '08.12.2025|15,100|24,300|6,200'].join('\n'),
);
const quote = (currency: string, day: string) => cnbQuote(CNB, currency, day);

describe('parseCsv', () => {
  it('handles quoted delimiters, doubled quotes, CRLF and a BOM', () => {
    const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""",3\r\n');
    expect(rows).toEqual([{ a: 'x, y', b: 'say "hi"', c: '3' }]);
  });

  it('sniffs a semicolon-separated sheet (Czech Excel)', () => {
    expect(parseCsv('a;b\n"1,5";2')).toEqual([{ a: '1,5', b: '2' }]);
  });
});

describe('pragueLocalToIso', () => {
  it('treats extranet times as Prague wall-clock (CET in winter, CEST in summer)', () => {
    expect(pragueLocalToIso('2025-12-09 14:21:09')).toBe('2025-12-09T13:21:09.000Z');
    expect(pragueLocalToIso('2026-07-01 10:00:00')).toBe('2026-07-01T08:00:00.000Z');
  });
});

describe('ČNB rates', () => {
  it('uses the last rate published on or before the day (weekends)', () => {
    expect(quote('EUR', '2025-12-07')).toEqual({ currency: 'EUR', rate: 24.2, rateDate: '2025-12-05' });
    expect(quote('EUR', '2025-12-08').rate).toBe(24.3);
  });

  it('divides multi-unit quotes ("100 HUF")', () => {
    expect(quote('HUF', '2025-12-05').rate).toBeCloseTo(0.061);
  });

  it('throws rather than guessing when no rate exists', () => {
    expect(() => quote('EUR', '2025-01-01')).toThrow(/no ČNB EUR rate/);
  });
});

describe('Booking.com export', () => {
  const csv = [
    BCOM_HEADER,
    '5000000001,"Nováková, Jana",Jana Nováková,2025-12-09,2025-12-11,2025-12-09 14:21:09,ok,1,2,112.8 EUR,13,14.664 EUR,cz,"K.2O3, K.202",2,,Street 1,+420123',
    '5000000002,"Svoboda, Petr",Petr Svoboda,2025-12-12,2025-12-14,2025-12-08 19:57:58,cancelled_by_guest,2,4,371.52 EUR,13,,sk,"Deluxe Apartment, K.2O3, K.202",2,2025-12-09 14:55:50,,',
    '5000000003,"Doe, Jan",Jan Doe,2026-01-16,2026-01-19,2026-01-13 10:00:00,ok,1,2,5420.64 CZK,13,704.68 CZK,cz,Deluxe Apartment,3,,,',
    '7000000001,"X, Y",Y X,2026-01-20,2026-01-21,2026-01-01 10:00:00,no_show,1,2,100 CZK,13,13 CZK,cz,K.201,1,,,',
  ].join('\n');
  const { reservations, rejected } = parseBookingComExport(csv, 'bcom.csv');

  it('parses rows and rejects statuses it cannot interpret', () => {
    expect(reservations.map((r) => r.ref)).toEqual(['5000000001', '5000000002', '5000000003']);
    expect(rejected).toEqual([{ sourceFile: 'bcom.csv', ref: '7000000001', reason: expect.stringMatching(/no_show/) }]);
  });

  it('never keeps contact details, even in the raw row', () => {
    expect(reservations[0].row).not.toHaveProperty('Adresa');
    expect(reservations[0].row).not.toHaveProperty('Telefonní číslo');
  });

  it('converts EUR at the arrival-day ČNB rate and keeps the original in raw', () => {
    const r = reservations[0];
    const row = toLegacyMirrorRow(r, assignRoom(r)!, quote);
    expect(row.reservationNumber).toBe('LG-BCOM-5000000001');
    expect(row.source).toBe('legacy-import');
    expect(row.apiReference).toBe('5000000001');
    expect(row.price).toBe(String(Math.round(112.8 * 24.3 * 100) / 100));
    expect(row.commissionAmount).toBe(String(Math.round(14.664 * 24.3 * 100) / 100));
    expect(row.bookingTimestamp?.toISOString()).toBe('2025-12-09T13:21:09.000Z');
    expect(row.nationality).toBe('CZ');
    expect(row.raw).toMatchObject({ legacy: { fx: { currency: 'EUR', rate: 24.3, rateDate: '2025-12-08', originalPrice: 112.8 } } });
  });

  it('a one-room studio booking does not say which studio → virtual room', () => {
    const row = toLegacyMirrorRow(reservations[2], assignRoom(reservations[2])!, quote);
    expect(row).toMatchObject({ room: '1KK Deluxe Studios', linkedRooms: null, isUnallocatedVr: true, price: '5420.64' });
  });

  it('a two-room studio booking is both studios; a cancellation carries price 0 and its cancel time', () => {
    const r = reservations[1];
    const row = toLegacyMirrorRow(r, assignRoom(r)!, quote);
    expect(row).toMatchObject({
      room: 'K.202 + K.203',
      linkedRooms: ['K.202', 'K.203'],
      isCancelled: true,
      status: 'cancelled',
      price: '0',
      commissionAmount: '0',
    });
    expect(row.raw).toMatchObject({ cancelTime: '2025-12-09T13:55:50.000Z' });
  });
});

describe('Airbnb payout report', () => {
  const csv = [
    AIRBNB_HEADER,
    '12/22/2025,12/30/2025,Payout,,,,,,,,"Transfer to X, IBAN 0227 (CZK)",G-1,CZK,,1600.53,,,,,,',
    '12/22/2025,,Reservation,HMAAA,12/18/2025,12/21/2025,12/22/2025,1,Ann Lee,New Courtyard Studio · Free Parking · Brno Centre,,,CZK,1600.53,,369.47,,1000.00,1970.00,0.00,2025',
    '12/22/2025,,Reservation,HMAAA,12/18/2025,12/21/2025,12/22/2025,1,Ann Lee,New Courtyard Studio · Free Parking · Brno Centre,,,CZK,1600.53,,369.47,,1000.00,1970.00,0.00,2025',
    '01/20/2026,,Reservation,HMBBB,01/16/2026,01/19/2026,01/23/2026,4,Sam Doe,Baker House Twins – 2 Private Studios Next Door,,,CZK,13584.09,,"3,135.84",,0.00,16720.00,0.00,2026',
    '02/20/2026,,Reservation,HMBBB,01/16/2026,01/19/2026,01/23/2026,4,Sam Doe,Baker House Twins – 2 Private Studios Next Door,,,CZK,100.00,,"10.00",,0.00,110.00,0.00,2026',
    '01/21/2026,,Resolution Adjustment,HMBBB,,,,,,,,,CZK,-50,,,,,,,',
  ].join('\n');
  const { reservations, notes } = parseAirbnbPayouts(csv, 'airbnb.csv');

  it('keeps reservation lines only, drops an identical repeat, sums instalments', () => {
    expect(reservations.map((r) => r.ref)).toEqual(['HMAAA', 'HMBBB']);
    expect(reservations[0].price.amount).toBe(1970);
    expect(reservations[1].price.amount).toBeCloseTo(16830);
    expect(reservations[1].commission.amount).toBeCloseTo(3145.84);
    expect(notes.join('\n')).toMatch(/identical line repeated/);
    expect(notes.join('\n')).toMatch(/1 "Resolution Adjustment" line ignored/);
  });

  it('maps gross earnings → price, service fee → commission, listing → unit', () => {
    const r = reservations[0];
    const row = toLegacyMirrorRow(r, assignRoom(r)!, quote);
    expect(row).toMatchObject({
      reservationNumber: 'LG-ABNB-HMAAA',
      channel: 'Airbnb',
      room: 'K.202',
      price: '1970',
      commissionAmount: '369.47',
      checkInDate: '2025-12-21',
      reservationDate: '2025-12-18',
      numberOfGuests: 0,
      firstName: 'Ann',
      lastName: 'Lee',
    });
    expect(assignRoom(reservations[1])).toEqual({ room: 'K.202 + K.203', linkedRooms: ['K.202', 'K.203'], unallocated: false });
  });
});

describe('assignRoom', () => {
  it('returns null for an unknown listing or room type rather than guessing', () => {
    expect(assignRoom({ channel: 'Airbnb', unitLabel: 'Some new listing', units: 1 })).toBeNull();
    expect(assignRoom({ channel: 'Booking.com', unitLabel: 'Penthouse', units: 1 })).toBeNull();
    expect(assignRoom({ channel: 'Booking.com', unitLabel: 'K.201', units: 1 })).toEqual({ room: 'K.201', linkedRooms: null, unallocated: false });
  });
});

describe('parseExclusions', () => {
  it('reads one ref per line with optional # reasons', () => {
    const m = parseExclusions('# header\n123  # friends\n\nHMX\n');
    expect([...m]).toEqual([['123', 'friends'], ['HMX', '']]);
  });
});
