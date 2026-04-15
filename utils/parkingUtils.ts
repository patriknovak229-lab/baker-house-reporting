import type { Reservation } from "@/types/reservation";

// ─── Constants ───────────────────────────────────────────────────────────────

export const PARKING_SPACES = [
  { space: "153", permanentRoom: "K.201" as string | null },
  { space: "167", permanentRoom: "K.202" as string | null },
  { space: "160", permanentRoom: "K.203" as string | null },
  { space: "152", permanentRoom: null },  // hot space — no permanent room
] as const;

export type ParkingSpace = (typeof PARKING_SPACES)[number];

// ─── Types ───────────────────────────────────────────────────────────────────

export type ParkingAssignment = {
  space: string;
  type: "auto" | "manual";
  conflict?: string; // conflict description if auto-assign space was taken
};

/** space → date → occupant info (or null if free) */
export type ParkingGridCell = {
  reservationNumber: string;
  initials: string;
} | null;

export type ParkingResult = {
  /** reservationNumber → assignment (or null = no parking) */
  byReservation: Map<string, ParkingAssignment | null>;
  /** space → date → occupant */
  grid: Map<string, Map<string, ParkingGridCell>>;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Generate all dates in [checkIn, checkOut) as YYYY-MM-DD strings */
function dateRange(checkIn: string, checkOut: string): string[] {
  const dates: string[] = [];
  const start = new Date(checkIn + "T00:00:00");
  const end = new Date(checkOut + "T00:00:00");
  const cur = new Date(start);
  while (cur < end) {
    dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

function getInitials(r: Reservation): string {
  return [r.firstName?.[0], r.lastName?.[0]].filter(Boolean).join("").toUpperCase();
}

/** Check if room matches reservation (accounting for linkedRooms) */
function reservationUsesRoom(r: Reservation, room: string): boolean {
  return r.room === room || (r.linkedRooms?.includes(room) ?? false);
}

/** Find which permanent space(s) a reservation's room maps to */
function permanentSpacesForReservation(r: Reservation): string[] {
  const spaces: string[] = [];
  for (const ps of PARKING_SPACES) {
    if (ps.permanentRoom && reservationUsesRoom(r, ps.permanentRoom)) {
      spaces.push(ps.space);
    }
  }
  return spaces;
}

// ─── Main computation ────────────────────────────────────────────────────────

export function computeParking(reservations: Reservation[]): ParkingResult {
  const byReservation = new Map<string, ParkingAssignment | null>();
  const grid = new Map<string, Map<string, ParkingGridCell>>();

  // Initialise grid
  for (const ps of PARKING_SPACES) {
    grid.set(ps.space, new Map());
  }

  // Only consider non-refunded reservations
  const active = reservations.filter((r) => r.paymentStatus !== "Refunded");

  // ── Pass 1: Manual overrides ──────────────────────────────────────────────
  for (const r of active) {
    const override = r.parkingOverride;
    if (override === undefined || override === "none") continue;
    // Manual space assignment
    const dates = dateRange(r.checkInDate, r.checkOutDate);
    const spaceGrid = grid.get(override);
    if (!spaceGrid) continue; // invalid space — skip

    byReservation.set(r.reservationNumber, { space: override, type: "manual" });
    const initials = getInitials(r);
    for (const d of dates) {
      spaceGrid.set(d, { reservationNumber: r.reservationNumber, initials });
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
    if (permSpaces.length === 0) {
      console.log("[parking] no perm spaces for", r.reservationNumber, "room:", r.room, "linked:", r.linkedRooms);
      continue;
    }
    console.log("[parking] auto-assign", r.reservationNumber, "room:", r.room, "linked:", r.linkedRooms, "→ spaces:", permSpaces);

    const dates = dateRange(r.checkInDate, r.checkOutDate);
    const initials = getInitials(r);

    for (const space of permSpaces) {
      const spaceGrid = grid.get(space)!;
      // Check if free for all dates
      const conflict = dates.find((d) => spaceGrid.get(d) != null);
      if (conflict) {
        const occupant = spaceGrid.get(conflict)!;
        byReservation.set(r.reservationNumber, {
          space,
          type: "auto",
          conflict: `Space ${space} occupied by reservation ${occupant.reservationNumber} on ${conflict}`,
        });
      } else {
        // Auto-assign
        byReservation.set(r.reservationNumber, { space, type: "auto" });
        for (const d of dates) {
          spaceGrid.set(d, { reservationNumber: r.reservationNumber, initials });
        }
      }
    }
  }

  return { byReservation, grid };
}

// ─── Free spaces helper ──────────────────────────────────────────────────────

/** Returns spaces that are free for every date in [checkIn, checkOut) */
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
      return cell != null && cell.reservationNumber !== excludeReservation;
    });
    if (!occupied) free.push(ps.space);
  }

  return free;
}
