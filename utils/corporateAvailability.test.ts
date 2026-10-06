import { describe, it, expect } from 'vitest';
import { describeAlternatives, evaluateAvailability, findAlternatives } from './corporateAvailability';
import type { ResRef } from './roomAllocation';

const TODAY = '2026-10-06';
const URBAN = 679714;
const DELUXE = 648816;
const K201 = 656437;
const O308 = 674672;

let n = 0;
const booking = (room: string, checkInDate: string, checkOutDate: string): ResRef => ({
  reservationNumber: `BH-${++n}`,
  room,
  checkInDate,
  checkOutDate,
  firstName: 'Guest',
  lastName: room,
});

// Mon 12 Oct → Wed 14 Oct, the operator's example week.
const stay = { arrival: '2026-10-12', departure: '2026-10-14' };

describe('evaluateAvailability', () => {
  it('is free in the preferred type when nothing is booked', () => {
    const r = evaluateAvailability([], stay, [URBAN, DELUXE], URBAN, 1, TODAY);
    expect(r.roomId).toBe(URBAN);
    expect(r.availability.kind).toBe('free');
  });

  it('falls over to the other agreed type when the preferred one is only free after a shuffle', () => {
    // No Urban unit is free on both nights (K.103's guest could be moved to
    // K.106 to make room), while Deluxe is empty — the free type wins.
    const res = [booking('K.102', '2026-10-10', '2026-10-15'), booking('K.103', '2026-10-12', '2026-10-13'), booking('K.106', '2026-10-13', '2026-10-16')];
    const r = evaluateAvailability(res, stay, [URBAN, DELUXE], URBAN, 1, TODAY);
    expect(r.roomId).toBe(DELUXE);
    expect(r.availability.kind).toBe('free');
  });

  it('when every agreed type is full it says so AND names where there is vacancy', () => {
    // Urban: no unit free both nights and nowhere to move anyone; Deluxe: the
    // K.203 guest would have to move into K.202, which is itself taken.
    const res = [
      booking('K.102', '2026-10-10', '2026-10-15'),
      booking('K.103', '2026-10-12', '2026-10-14'),
      booking('K.106', '2026-10-13', '2026-10-16'),
      booking('K.202', '2026-10-11', '2026-10-14'),
      booking('K.203', '2026-10-13', '2026-10-15'),
    ];
    const r = evaluateAvailability(res, stay, [URBAN, DELUXE], URBAN, 1, TODAY);
    expect(r.roomId).toBe(URBAN); // fallback to the preferred type for the row
    expect(r.availability.kind).toBe('blocked');
    if (r.availability.kind !== 'blocked') return;
    expect(r.availability.alternatives.map((a) => a.roomId).sort()).toEqual([K201, O308].sort());
    expect(r.availability.alternatives.every((a) => a.moves === 0)).toBe(true);
    expect(describeAlternatives(r.availability.alternatives)).toBe('K.201 2KK (K.201) · O.308 2BR (O.308)');
  });

  it('a week that only works with a shuffle says so and lists types free without moves', () => {
    // Urban is hopeless; Deluxe works only if the K.202 guest (11→13) is
    // moved into K.203, which is free until the 13th.
    const res = [
      booking('K.102', '2026-10-10', '2026-10-15'),
      booking('K.103', '2026-10-12', '2026-10-14'),
      booking('K.106', '2026-10-13', '2026-10-16'),
      booking('K.202', '2026-10-11', '2026-10-13'),
      booking('K.203', '2026-10-13', '2026-10-14'),
    ];
    const r = evaluateAvailability(res, stay, [URBAN, DELUXE], URBAN, 1, TODAY);
    expect(r.roomId).toBe(DELUXE);
    expect(r.availability.kind).toBe('shuffle');
    if (r.availability.kind !== 'shuffle') return;
    expect(r.availability.unit).toBe('K.202'); // the K.202 guest is moved into K.203
    expect(r.availability.moves).toBe(1);
    expect(r.availability.alternatives.map((a) => a.roomId).sort()).toEqual([K201, O308].sort());
  });

  it('reports no vacancy anywhere when the whole house is full', () => {
    const res = ['K.102', 'K.103', 'K.106', 'K.202', 'K.203', 'K.201', 'O.308'].map((room) => booking(room, '2026-10-11', '2026-10-15'));
    const r = evaluateAvailability(res, stay, [URBAN, DELUXE], URBAN, 1, TODAY);
    expect(r.availability.kind).toBe('blocked');
    if (r.availability.kind === 'blocked') expect(r.availability.alternatives).toEqual([]);
  });

  it('a party too big for the studios is told the larger apartments have vacancy', () => {
    const r = evaluateAvailability([], stay, [URBAN, DELUXE], URBAN, 3, TODAY);
    expect(r.availability.kind).toBe('blocked');
    if (r.availability.kind === 'blocked') {
      expect(r.availability.note).toMatch(/./);
      expect(r.availability.alternatives.map((a) => a.roomId).sort()).toEqual([K201, O308].sort());
    }
  });

  it('past dates and missing data are reported, not judged', () => {
    expect(evaluateAvailability([], { arrival: '2026-10-01', departure: '2026-10-03' }, [URBAN], URBAN, 1, TODAY).availability).toEqual({ kind: 'past' });
    expect(evaluateAvailability(null, stay, [URBAN], URBAN, 1, TODAY).availability).toEqual({ kind: 'unknown' });
  });
});

describe('findAlternatives', () => {
  it('excludes the types already judged and orders free-as-is first', () => {
    const alts = findAlternatives([], stay, [URBAN], 1, TODAY);
    expect(alts.map((a) => a.roomId)).toEqual([DELUXE, K201, O308]);
    expect(alts.every((a) => a.moves === 0)).toBe(true);
  });
});
