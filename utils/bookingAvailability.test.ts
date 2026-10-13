import { describe, it, expect } from 'vitest';
import { stayAvailability, effectiveFreeUnits } from './bookingAvailability';
import type { Reservation } from '@/types/reservation';

let seq = 0;
function res(over: Partial<Reservation>): Reservation {
  seq += 1;
  return {
    reservationNumber: `BH-${1000 + seq}`,
    firstName: 'Guest',
    lastName: String(seq),
    room: 'K.102',
    checkInDate: '2026-11-08',
    checkOutDate: '2026-11-10',
    ...over,
  } as Reservation;
}

const byId = (list: ReturnType<typeof stayAvailability>, roomId: number) =>
  list.find((t) => t.roomId === roomId)!;

describe('stayAvailability', () => {
  it('lists every sellable type with all its physical units', () => {
    const list = stayAvailability([], '2026-11-08', '2026-11-10');
    expect(list.map((t) => t.roomId).sort()).toEqual([648816, 656437, 674672, 679714].sort());
    const urban = byId(list, 679714);
    expect(urban.units.map((u) => [u.room, u.roomId])).toEqual([
      ['K.102', 679703],
      ['K.103', 679704],
      ['K.106', 679705],
    ]);
    expect(urban.freeUnits).toBe(3);
    expect(byId(list, 656437).units).toEqual([{ room: 'K.201', roomId: 656437, free: true, heldBy: null }]);
  });

  it('marks a unit held by an overlapping stay and names the guest', () => {
    const list = stayAvailability(
      [res({ room: 'K.103', firstName: 'Jan', lastName: 'Novák', checkInDate: '2026-11-09', checkOutDate: '2026-11-12' })],
      '2026-11-08',
      '2026-11-10',
    );
    const k103 = byId(list, 679714).units.find((u) => u.room === 'K.103')!;
    expect(k103.free).toBe(false);
    expect(k103.heldBy).toBe('Jan Novák');
    expect(byId(list, 679714).freeUnits).toBe(2);
  });

  it('treats checkout-day turnovers as free (half-open nights)', () => {
    const list = stayAvailability(
      [
        res({ room: 'K.201', checkInDate: '2026-11-05', checkOutDate: '2026-11-08' }),
        res({ room: 'K.201', checkInDate: '2026-11-10', checkOutDate: '2026-11-12' }),
      ],
      '2026-11-08',
      '2026-11-10',
    );
    expect(byId(list, 656437).freeUnits).toBe(1);
  });

  it('ignores cancellations but counts blackouts', () => {
    const list = stayAvailability(
      [
        res({ room: 'O.308', isCancelled: true }),
        res({ room: 'K.202', isBlackout: true, blackoutReason: 'Renovation', firstName: '', lastName: '' }),
      ],
      '2026-11-08',
      '2026-11-10',
    );
    expect(byId(list, 674672).freeUnits).toBe(1);
    const k202 = byId(list, 648816).units.find((u) => u.room === 'K.202')!;
    expect(k202.free).toBe(false);
    expect(k202.heldBy).toBe('Blocked — Renovation');
  });

  it('blocks every unit of a multi-apartment package', () => {
    const list = stayAvailability(
      [res({ room: 'K.202 + K.203', linkedRooms: ['K.202', 'K.203'] })],
      '2026-11-08',
      '2026-11-10',
    );
    expect(byId(list, 648816).freeUnits).toBe(0);
  });

  it('subtracts unallocated bookings of the same type from the usable free count', () => {
    const list = stayAvailability(
      [
        res({ room: 'K.102' }),
        res({ room: '1KK Urban Studios', isUnallocatedVR: true }),
      ],
      '2026-11-08',
      '2026-11-10',
    );
    const urban = byId(list, 679714);
    expect(urban.freeUnits).toBe(2);
    expect(urban.unallocated).toBe(1);
    expect(effectiveFreeUnits(urban)).toBe(1);
    // The other studio type is untouched by an Urban booking.
    expect(byId(list, 648816).unallocated).toBe(0);
  });
});
