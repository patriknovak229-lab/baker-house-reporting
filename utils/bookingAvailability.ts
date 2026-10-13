/**
 * Which apartments are free for a stay — the occupancy half of the New Booking
 * modal's "Check availability & prices" list (prices come from Beds24 and are
 * layered on by the modal).
 *
 * Read from the reservations already on screen, with the same reading the move
 * picker uses (`occupiersByRoom`): cancelled bookings don't hold a unit,
 * blackouts do, a guest moved mid-stay holds each unit only for their own
 * nights there. Per PHYSICAL unit, because the modal can force a specific one —
 * and a manual booking skips Beds24's availability check, so this is what
 * stands between the operator and a double booking.
 *
 * Pure: no network, safe in a client component.
 */
import type { Reservation } from '@/types/reservation';
import { SELLABLE_UNITS } from './stayRequest';
import { physicalRoomIdForName } from './roomAllocation';
import { occupiersByRoom, unallocatedOverlapping } from './moveTargets';

export interface UnitAvailability {
  /** Physical unit, e.g. "K.102". */
  room: string;
  /** Its Beds24 physical roomId — what a "force" booking is created on. */
  roomId: number;
  free: boolean;
  /** Who holds it when it isn't free (guest names / "Blocked"), else null. */
  heldBy: string | null;
}

export interface TypeAvailability {
  /** Sellable roomId — what Beds24 offers price and a normal booking targets. */
  roomId: number;
  label: string;
  /** Guests one unit sleeps. */
  sleeps: number;
  units: UnitAvailability[];
  /** Units nobody holds on any night of the stay. */
  freeUnits: number;
  /**
   * Overlapping bookings Beds24 has not put in a unit yet. Each will take one
   * of the free units, so a free count of 1 with 1 unallocated is really 0.
   */
  unallocated: number;
}

function holderName(r: Reservation): string {
  if (r.isBlackout) return r.blackoutReason ? `Blocked — ${r.blackoutReason}` : 'Blocked';
  return `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || r.reservationNumber;
}

/** Every sellable type with its units' state for [arrival, departure). */
export function stayAvailability(
  reservations: Reservation[],
  arrival: string,
  departure: string,
): TypeAvailability[] {
  const target = { reservationNumber: '__new-booking__', checkInDate: arrival, checkOutDate: departure };
  const held = occupiersByRoom(target, reservations);
  const unallocated = unallocatedOverlapping(target, reservations);

  return SELLABLE_UNITS.map((type) => {
    const units: UnitAvailability[] = type.units.map((room) => {
      const holders = held.get(room) ?? [];
      return {
        room,
        roomId: physicalRoomIdForName(room) ?? type.roomId,
        free: holders.length === 0,
        heldBy: holders.length > 0 ? [...new Set(holders.map(holderName))].join(', ') : null,
      };
    });
    return {
      roomId: type.roomId,
      label: type.label,
      sleeps: type.sleeps,
      units,
      freeUnits: units.filter((u) => u.free).length,
      unallocated: type.group
        ? unallocated.filter((r) => r.room === type.group!.typeLabel).length
        : 0,
    };
  });
}

/** Free units once the unallocated bookings have taken theirs. */
export function effectiveFreeUnits(t: TypeAvailability): number {
  return Math.max(0, t.freeUnits - t.unallocated);
}
