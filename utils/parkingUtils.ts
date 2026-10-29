import type { Reservation } from "@/types/reservation";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Physical parking spaces in the underground garage at Bratislavská 82.
 *
 * `permanentRoom` — the room that auto-gets this space (one-to-one mapping).
 *   `null` means the space has no permanent room (hot space, manual-only).
 * `subLevel` — the floor of the garage (currently all on sub-level −1).
 *   Surfaced in the parking auto-reply so guests know which level to drive to.
 *
 * Change history:
 *   2026-05-21 — Urban apartments (K.102/K.103/K.106) gained dedicated spaces
 *                15/16/17 (previously had no parking). Space 152 converted
 *                from hot-space to permanent O.308.
 */
export const PARKING_SPACES = [
  // Deluxe apartments
  { space: "153", permanentRoom: "K.201" as string | null, subLevel: -1 },
  { space: "167", permanentRoom: "K.202" as string | null, subLevel: -1 },
  { space: "160", permanentRoom: "K.203" as string | null, subLevel: -1 },
  // 2-Bedroom apartment
  { space: "152", permanentRoom: "O.308" as string | null, subLevel: -1 },
  // Urban apartments (added 2026-05-21 — used to be no-parking units)
  { space: "15",  permanentRoom: "K.102" as string | null, subLevel: -1 },
  { space: "16",  permanentRoom: "K.103" as string | null, subLevel: -1 },
  { space: "17",  permanentRoom: "K.106" as string | null, subLevel: -1 },
] as const;

export type ParkingSpace = (typeof PARKING_SPACES)[number];

// ─── Types ───────────────────────────────────────────────────────────────────

export type ParkingAssignment = {
  space: string;
  type: "auto" | "manual";
  /** The apartment this space belongs to (auto) — names each space of a
   *  multi-apartment booking ("K.102 → 15, O.308 → 152"). */
  room?: string;
  conflict?: string; // conflict description if auto-assign space was taken
  /** Nobody parks here — the guest isn't coming by car, or (several
   *  apartments, fewer cars) this is one of `parkingUse.spareSpaces`. The
   *  space is theirs but empty, so it can be lent out. */
  spare?: boolean;
  /** Spare space currently lent to another reservation (no conflict raised). */
  lentTo?: string;
};

/** space → date → occupant info (or null if free) */
export type ParkingGridCell = {
  reservationNumber: string;
  initials: string;
  /** Held by a guest who isn't bringing a car — offerable to someone else. */
  spare?: boolean;
  /** The guest hasn't said yet whether they're coming by car (no parkingUse). */
  unanswered?: boolean;
  /** Licence plate of the car using it, when the guest gave one. */
  plate?: string;
} | null;

export type ParkingResult = {
  /** reservationNumber → its first space (or null = no parking). A booking of
   *  several apartments holds several — see `spacesByReservation`. */
  byReservation: Map<string, ParkingAssignment | null>;
  /** reservationNumber → EVERY space it holds, one per apartment, in the
   *  booking's apartment order. Empty/absent = no parking. */
  spacesByReservation: Map<string, ParkingAssignment[]>;
  /** space → date → occupant */
  grid: Map<string, Map<string, ParkingGridCell>>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate all dates in [checkIn, checkOut) as YYYY-MM-DD strings.
 *
 * All arithmetic stays in UTC. The previous version parsed local midnight
 * (`+ "T00:00:00"`) but emitted dates via `toISOString()` (UTC) — on any
 * UTC+ operator (Czech summer = UTC+2) that shifted every key back a day,
 * so the parking grid landed one day earlier than the room grid and a
 * space showed FREE on the last night of a stay. Parse + step + emit all
 * in UTC so they agree. (Same trap periodUtils.ts documents in its header.) */
function dateRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const cur = new Date(checkIn + "T00:00:00Z");
  const end = new Date(checkOut + "T00:00:00Z");
  while (cur < end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

function getInitials(r: Reservation): string {
  return [r.firstName?.[0], r.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

/** Is nobody parking in this space of the reservation's? */
function isSpare(r: Reservation, space: string): boolean {
  if (r.parkingUse?.status === "no-car") return true;
  return r.parkingUse?.status === "car" && (r.parkingUse.spareSpaces?.includes(space) ?? false);
}

function occupantCell(r: Reservation, space: string): NonNullable<ParkingGridCell> {
  return {
    reservationNumber: r.reservationNumber,
    initials: getInitials(r),
    ...(isSpare(r, space) ? { spare: true } : {}),
    ...(!r.parkingUse ? { unanswered: true } : {}),
    ...(r.parkingUse?.status === "car" && r.parkingUse.plate ? { plate: r.parkingUse.plate } : {}),
  };
}

/** Check if room matches reservation (accounting for linkedRooms) */
function reservationUsesRoom(r: Reservation, room: string): boolean {
  return r.room === room || (r.linkedRooms?.includes(room) ?? false);
}

/**
 * The permanent space of each of the reservation's apartments, in the
 * booking's own apartment order (K.102 + O.308 + K.103 → 15, 152, 16).
 */
function permanentSpacesForReservation(r: Reservation): { space: string; room: string }[] {
  const rooms = r.linkedRooms && r.linkedRooms.length > 0 ? [r.room, ...r.linkedRooms] : [r.room];
  const spaces: { space: string; room: string }[] = [];
  for (const room of rooms) {
    const ps = PARKING_SPACES.find((p) => p.permanentRoom === room);
    if (ps && !spaces.some((s) => s.space === ps.space)) spaces.push({ space: ps.space, room });
  }
  // A combined label ("K.102 + K.103") as `room` matches no space above.
  for (const ps of PARKING_SPACES) {
    if (ps.permanentRoom && reservationUsesRoom(r, ps.permanentRoom) && !spaces.some((s) => s.space === ps.space)) {
      spaces.push({ space: ps.space, room: ps.permanentRoom });
    }
  }
  return spaces;
}

// ─── Main computation ────────────────────────────────────────────────────────

export function computeParking(reservations: Reservation[]): ParkingResult {
  const byReservation = new Map<string, ParkingAssignment | null>();
  const spacesByReservation = new Map<string, ParkingAssignment[]>();
  const grid = new Map<string, Map<string, ParkingGridCell>>();
  const hold = (r: Reservation, a: ParkingAssignment) => {
    const list = spacesByReservation.get(r.reservationNumber);
    if (list) list.push(a);
    else spacesByReservation.set(r.reservationNumber, [a]);
    if (!byReservation.get(r.reservationNumber)) byReservation.set(r.reservationNumber, a);
  };

  // Initialise grid
  for (const ps of PARKING_SPACES) {
    grid.set(ps.space, new Map());
  }

  // Only bookings whose guest is actually coming hold a space: no refunds and
  // no cancellations. That includes non-arrivals (cancelled in Beds24 on
  // purpose, still revenue) and unpaid checkouts Beds24 saves already cancelled.
  const active = reservations.filter(
    (r) => r.paymentStatus !== "Refunded" && !r.isCancelled,
  );

  // ── Pass 1: Manual overrides ──────────────────────────────────────────────
  for (const r of active) {
    const override = r.parkingOverride;
    if (override === undefined || override === "none") continue;
    // Manual space assignment
    const dates = dateRange(r.checkInDate, r.checkOutDate);
    const spaceGrid = grid.get(override);
    if (!spaceGrid) continue; // invalid space — skip

    hold(r, {
      space: override,
      type: "manual",
      ...(isSpare(r, override) ? { spare: true } : {}),
    });
    const cell = occupantCell(r, override);
    for (const d of dates) {
      spaceGrid.set(d, cell);
    }
  }

  // ── Pass 2: Auto-assign permanents ────────────────────────────────────────
  for (const r of active) {
    if (byReservation.has(r.reservationNumber)) continue; // already handled
    if (r.parkingOverride === "none") {
      byReservation.set(r.reservationNumber, null);
      continue;
    }

    const permSpaces = permanentSpacesForReservation(r);
    if (permSpaces.length === 0) continue; // no permanent space — skip (hot space needs manual)

    const dates = dateRange(r.checkInDate, r.checkOutDate);

    // One space per apartment — a guest with three apartments has three.
    for (const { space, room } of permSpaces) {
      const spaceGrid = grid.get(space)!;
      const cell = occupantCell(r, space);
      const spare = isSpare(r, space);
      // Check if free for all dates
      const conflict = dates.find((d) => spaceGrid.get(d) != null);
      if (conflict) {
        const occupant = spaceGrid.get(conflict)!;
        if (spare) {
          // Nobody parks here → the space was lent out on purpose (pass 1 put
          // someone there). The nights it isn't lent still show as spare.
          hold(r, {
            space,
            type: "auto",
            room,
            spare: true,
            lentTo: occupant.reservationNumber,
          });
          for (const d of dates) {
            if (spaceGrid.get(d) == null) spaceGrid.set(d, cell);
          }
          continue;
        }
        hold(r, {
          space,
          type: "auto",
          room,
          conflict: `Space ${space} occupied by reservation ${occupant.reservationNumber} on ${conflict}`,
        });
      } else {
        // Auto-assign
        hold(r, { space, type: "auto", room, ...(spare ? { spare: true } : {}) });
        for (const d of dates) {
          spaceGrid.set(d, cell);
        }
      }
    }
  }

  return { byReservation, spacesByReservation, grid };
}

// ─── Free spaces helper ──────────────────────────────────────────────────────

/** Returns spaces that are free for every date in [checkIn, checkOut).
 *  A space held by a guest who isn't bringing a car counts as free here; use
 *  getSpareSpaces to tell those apart in the UI. */
export function getFreeSpaces(
  parkingResult: ParkingResult,
  checkIn: string,
  checkOut: string,
  excludeReservation?: string,
): string[] {
  const dates = dateRange(checkIn, checkOut);
  const free: string[] = [];

  for (const ps of PARKING_SPACES) {
    const spaceGrid = parkingResult.grid.get(ps.space)!;
    const occupied = dates.some((d) => {
      const cell = spaceGrid.get(d);
      return cell != null && cell.reservationNumber !== excludeReservation && !cell.spare;
    });
    if (!occupied) free.push(ps.space);
  }

  return free;
}

/** The free spaces (as getFreeSpaces) that are only free because no car of their guest parks there. */
export function getSpareSpaces(
  parkingResult: ParkingResult,
  checkIn: string,
  checkOut: string,
  excludeReservation?: string,
): string[] {
  const dates = dateRange(checkIn, checkOut);
  return getFreeSpaces(parkingResult, checkIn, checkOut, excludeReservation).filter((space) => {
    const spaceGrid = parkingResult.grid.get(space)!;
    return dates.some((d) => {
      const cell = spaceGrid.get(d);
      return cell != null && cell.reservationNumber !== excludeReservation && cell.spare;
    });
  });
}
