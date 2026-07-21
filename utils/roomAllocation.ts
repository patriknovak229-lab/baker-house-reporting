/**
 * Room reallocation within an OTA "room type".
 *
 * We sell apartments as a *room type* on Booking.com / Airbnb (a virtual
 * room, VR). When Beds24 can't auto-fit every booking of a type into one
 * physical unit for the whole stay, a booking lands "unallocated" on the VR
 * and needs manual reshuffling between the interchangeable physical units.
 *
 * This module:
 *   1. defines the allocation groups (which physical units back each VR), and
 *   2. computes the FEWEST unit moves that give the unallocated booking a home
 *      without ever moving a guest who is already in-house.
 *
 * Shuffling is always WITHIN a group (same room type). Guests don't learn
 * their specific apartment until check-in info the day before arrival, so any
 * not-yet-arrived booking is freely movable; an in-house booking is pinned.
 *
 * IMPORTANT: the roomId ↔ name mapping here must stay in sync with
 * `UNIT_MAP` / `VR_ROOM_LABELS` in `app/api/bookings/route.ts`.
 */

export interface AllocationUnit {
  room: string; // physical room name, e.g. "K.102"
  roomId: number; // Beds24 physical roomId
}

export interface AllocationGroup {
  /** Matches the VR display label `mapRoom` produces for unallocated bookings. */
  typeLabel: string;
  vrRoomId: number;
  units: AllocationUnit[];
}

export const ALLOCATION_GROUPS: AllocationGroup[] = [
  {
    typeLabel: "1KK Urban Studios",
    vrRoomId: 679714,
    units: [
      { room: "K.102", roomId: 679703 },
      { room: "K.103", roomId: 679704 },
      { room: "K.106", roomId: 679705 },
    ],
  },
  {
    typeLabel: "1KK Deluxe Studios",
    vrRoomId: 648816,
    units: [
      { room: "K.202", roomId: 648596 },
      { room: "K.203", roomId: 648772 },
    ],
  },
];

const ROOM_TO_ROOMID = new Map<string, number>();
const ROOM_TO_GROUP = new Map<string, AllocationGroup>();
const LABEL_TO_GROUP = new Map<string, AllocationGroup>();
for (const g of ALLOCATION_GROUPS) {
  LABEL_TO_GROUP.set(g.typeLabel, g);
  for (const u of g.units) {
    ROOM_TO_ROOMID.set(u.room, u.roomId);
    ROOM_TO_GROUP.set(u.room, g);
  }
}

export function roomIdForName(room: string): number | null {
  return ROOM_TO_ROOMID.get(room) ?? null;
}

/**
 * Every bookable physical unit (the 5 shuffle-group units + the two
 * standalone single-unit types K.201 and O.308). Used by the manual
 * "move to another room" action, which — unlike the within-type resolver —
 * can target any room. Keep the two standalone ids in sync with `UNIT_MAP`
 * in `app/api/bookings/route.ts`.
 */
export const PHYSICAL_ROOMS: AllocationUnit[] = [
  ...ALLOCATION_GROUPS.flatMap((g) => g.units),
  { room: "K.201", roomId: 656437 },
  { room: "O.308", roomId: 674672 },
];

const PHYS_NAME_TO_ID = new Map(PHYSICAL_ROOMS.map((u) => [u.room, u.roomId]));
const PHYS_ID_TO_NAME = new Map(PHYSICAL_ROOMS.map((u) => [u.roomId, u.room]));

export function physicalRoomIdForName(room: string): number | null {
  return PHYS_NAME_TO_ID.get(room) ?? null;
}

export function physicalRoomName(roomId: number): string | null {
  return PHYS_ID_TO_NAME.get(roomId) ?? null;
}

/** Group an allocated unit belongs to (by physical room name), or null. */
export function groupForRoom(room: string): AllocationGroup | null {
  return ROOM_TO_GROUP.get(room) ?? null;
}

/** Group an unallocated booking belongs to (by its VR type label), or null. */
export function groupForTypeLabel(label: string): AllocationGroup | null {
  return LABEL_TO_GROUP.get(label) ?? null;
}

// ─── Solver ──────────────────────────────────────────────────────────────────

export interface ReallocInput {
  reservationNumber: string;
  checkIn: string; // YYYY-MM-DD (first night)
  checkOut: string; // YYYY-MM-DD (departure, exclusive)
  /** Current physical unit, or null when unallocated (sitting on the VR). */
  currentRoom: string | null;
  /** false = pinned (in-house guest, cannot be moved). */
  movable: boolean;
  /** Display name for the UI (guest name etc.). Optional. */
  label?: string;
}

export interface ReallocMove {
  reservationNumber: string;
  from: string; // current unit
  to: string; // new unit
  label?: string;
}

export interface ReallocPlacement {
  reservationNumber: string;
  room: string; // unit the unallocated booking goes to
  label?: string;
}

export interface ReallocPlan {
  feasible: boolean;
  /** Why it can't be solved within the type (only when !feasible). */
  reason?: string;
  /** Unallocated booking(s) → their assigned unit. */
  placements: ReallocPlacement[];
  /** Existing bookings that must change unit (the "movements"). */
  moves: ReallocMove[];
  /** Full unit assignment for every booking in the affected component. */
  assignment: Record<string, string>;
}

/** Two half-open night intervals overlap when each starts before the other ends. */
function overlaps(a: ReallocInput, b: ReallocInput): boolean {
  return a.checkIn < b.checkOut && b.checkIn < a.checkOut;
}

/**
 * Plan the fewest moves to allocate the unallocated booking(s) within one
 * group. `reservations` must already be scoped to the group and to stays that
 * still matter (checkOut > today); include the unallocated target(s) with
 * currentRoom = null. Returns the minimal-move conflict-free assignment, or
 * `feasible: false` when it can't be done without moving an in-house guest.
 *
 * The search is tiny: we close over only the bookings that transitively
 * overlap the unallocated one(s) — bookings outside that component can't
 * collide with anything we move, so they keep their unit untouched.
 */
export function planReallocation(
  group: AllocationGroup,
  reservations: ReallocInput[],
): ReallocPlan {
  const units = group.units.map((u) => u.room);
  const seeds = reservations.filter((r) => r.currentRoom === null);

  const empty: ReallocPlan = {
    feasible: false,
    placements: [],
    moves: [],
    assignment: {},
  };

  if (seeds.length === 0) {
    return { ...empty, feasible: true }; // nothing to allocate
  }

  // ── Connected component: transitive overlap closure from the seed(s) ──
  const byId = new Map(reservations.map((r) => [r.reservationNumber, r]));
  const inComponent = new Set<string>(seeds.map((s) => s.reservationNumber));
  const queue = [...seeds];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const other of reservations) {
      if (inComponent.has(other.reservationNumber)) continue;
      if (overlaps(cur, other)) {
        inComponent.add(other.reservationNumber);
        queue.push(other);
      }
    }
  }
  const component = [...inComponent].map((id) => byId.get(id)!);

  // Safety valve — the component is normally a handful of bookings.
  if (component.length > 16) {
    return {
      ...empty,
      reason: "Too many overlapping bookings to auto-resolve — handle manually in Beds24.",
    };
  }

  const pinned = component.filter((r) => !r.movable);
  const movable = component.filter((r) => r.movable);

  // ── Seed unit→intervals with the pinned (in-house) bookings ──
  const unitIntervals: Record<string, ReallocInput[]> = {};
  for (const u of units) unitIntervals[u] = [];
  for (const p of pinned) {
    if (!p.currentRoom || !units.includes(p.currentRoom)) {
      return {
        ...empty,
        reason: `In-house booking ${p.reservationNumber} is not in this room type — cannot resolve automatically.`,
      };
    }
    if (unitIntervals[p.currentRoom].some((x) => overlaps(x, p))) {
      return {
        ...empty,
        reason: "Two in-house guests already overlap in the same unit — needs manual intervention.",
      };
    }
    unitIntervals[p.currentRoom].push(p);
  }

  // ── Backtracking: assign each movable to a unit, minimise moves ──
  // Try a movable's CURRENT unit first so the cheapest (fewest-move) plan is
  // found early and prunes the rest of the search.
  const orderedUnitsFor = (m: ReallocInput): string[] =>
    m.currentRoom && units.includes(m.currentRoom)
      ? [m.currentRoom, ...units.filter((u) => u !== m.currentRoom)]
      : units;

  let bestMoves = Infinity;
  let bestAssignment: Record<string, string> | null = null;

  const assignment: Record<string, string> = {};
  for (const p of pinned) assignment[p.reservationNumber] = p.currentRoom!;

  const recurse = (i: number, movesSoFar: number) => {
    if (movesSoFar >= bestMoves) return; // prune
    if (i === movable.length) {
      bestMoves = movesSoFar;
      bestAssignment = { ...assignment };
      return;
    }
    const m = movable[i];
    for (const unit of orderedUnitsFor(m)) {
      if (unitIntervals[unit].some((x) => overlaps(x, m))) continue;
      unitIntervals[unit].push(m);
      assignment[m.reservationNumber] = unit;
      const cost = m.currentRoom && m.currentRoom !== unit ? 1 : 0;
      recurse(i + 1, movesSoFar + cost);
      unitIntervals[unit].pop();
      delete assignment[m.reservationNumber];
    }
  };
  recurse(0, 0);

  if (!bestAssignment) {
    return {
      ...empty,
      reason:
        "No conflict-free arrangement exists within this room type — likely oversold for these dates (a cross-type move or refusing the booking may be required).",
    };
  }

  // ── Build placements + moves from the winning assignment ──
  const finalAssignment: Record<string, string> = bestAssignment;
  const placements: ReallocPlacement[] = [];
  const moves: ReallocMove[] = [];
  for (const r of component) {
    const to = finalAssignment[r.reservationNumber];
    if (r.currentRoom === null) {
      placements.push({ reservationNumber: r.reservationNumber, room: to, label: r.label });
    } else if (r.currentRoom !== to) {
      moves.push({ reservationNumber: r.reservationNumber, from: r.currentRoom, to, label: r.label });
    }
  }

  return { feasible: true, placements, moves, assignment: finalAssignment };
}

// ─── Convenience: plan from raw reservations ───────────────────────────────────

/** Minimal reservation shape the planner needs (a subset of `Reservation`). */
export interface ResRef {
  reservationNumber: string;
  room: string; // physical unit, VR type label, or "A + B" for packages
  checkInDate: string;
  checkOutDate: string;
  isUnallocatedVR?: boolean;
  isBlackout?: boolean;
  linkedRooms?: string[];
  firstName?: string;
  lastName?: string;
}

function nameOf(r: ResRef): string {
  const n = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  return n || r.reservationNumber;
}

/**
 * Find the allocation group for an unallocated booking and compute the
 * fewest-move plan to give it a home — scoping/pinning the rest of the group
 * automatically:
 *   - departed stays (checkOut ≤ today) are ignored,
 *   - in-house stays (arrived, not departed) are pinned,
 *   - blackouts and multi-unit packages are pinned (we never move those here),
 *   - other unallocated bookings of the same type are solved together.
 */
export function planForUnallocated(
  all: ResRef[],
  targetReservationNumber: string,
  today: string,
): { group: AllocationGroup; plan: ReallocPlan } | { error: string } {
  const target = all.find((r) => r.reservationNumber === targetReservationNumber);
  if (!target) return { error: "Reservation not found" };
  if (!target.isUnallocatedVR) return { error: "Reservation is already allocated" };

  const group = groupForTypeLabel(target.room);
  if (!group) return { error: `No shuffleable units for room type "${target.room}"` };

  const unitNames = group.units.map((u) => u.room);
  const inputs: ReallocInput[] = [];

  for (const r of all) {
    if (r.checkOutDate <= today) continue; // departed — irrelevant

    // Unallocated booking of THIS type → a seed to place.
    if (r.isUnallocatedVR) {
      if (groupForTypeLabel(r.room) === group) {
        inputs.push({
          reservationNumber: r.reservationNumber,
          checkIn: r.checkInDate,
          checkOut: r.checkOutDate,
          currentRoom: null,
          movable: true,
          label: nameOf(r),
        });
      }
      continue;
    }

    // Allocated booking — which of this group's units does it occupy?
    const occupiedUnits = (r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : [r.room]).filter(
      (u) => unitNames.includes(u),
    );
    if (occupiedUnits.length === 0) continue; // not in this group

    const inHouse = r.checkInDate <= today && r.checkOutDate > today;
    const isPackage = (r.linkedRooms?.length ?? 0) > 1;
    const movable = !inHouse && !r.isBlackout && !isPackage;

    for (const unit of occupiedUnits) {
      inputs.push({
        // Synthetic id when a single booking blocks several units (package);
        // such rows are always pinned, so they never appear in moves/placements.
        reservationNumber: occupiedUnits.length > 1 ? `${r.reservationNumber}#${unit}` : r.reservationNumber,
        checkIn: r.checkInDate,
        checkOut: r.checkOutDate,
        currentRoom: unit,
        movable,
        label: nameOf(r),
      });
    }
  }

  return { group, plan: planReallocation(group, inputs) };
}
