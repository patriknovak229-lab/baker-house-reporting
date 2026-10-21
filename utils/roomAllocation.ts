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

import type { RoomSegment, StayLink } from "@/types/reservation";
import { occupancySpans } from "@/utils/roomSegments";
import { guestKeyOf, sameStayKeys } from "@/utils/stayChains";

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

/** One Beds24 booking inside a multi-booking stay (see `ReallocInput.members`). */
export interface ReallocMember {
  reservationNumber: string;
  checkIn: string;
  checkOut: string;
}

export interface ReallocInput {
  reservationNumber: string;
  checkIn: string; // YYYY-MM-DD (first night that still matters)
  checkOut: string; // YYYY-MM-DD (departure, exclusive)
  /** Current physical unit, or null when unallocated (sitting on the VR). */
  currentRoom: string | null;
  /** false = pinned (in-house guest, cannot be moved). */
  movable: boolean;
  /**
   * true = the guest is inside the check-in-info window (arriving by tomorrow),
   * so their room/door code has likely already gone out. Callers pin these in a
   * first pass; if one is moved anyway, its moves carry `needsGuestNotice`.
   */
  messaged?: boolean;
  /** Display name for the UI (guest name etc.). Optional. */
  label?: string;
  /**
   * Set when this row is ONE guest's continuous stay made of several
   * back-to-back Beds24 bookings in the same unit — typically an extension
   * booked separately. The row moves as a whole or not at all: moving only one
   * of the bookings would make a staying guest change rooms mid-stay. Each
   * member becomes its own move in the plan.
   */
  members?: ReallocMember[];
  /**
   * "Same stay" identity (`sameStayKeys` in utils/stayChains): shared by the
   * back-to-back bookings of one stay — operator-linked, or the same guest
   * name unless marked "not the same guest". Links an unplaced booking to the
   * stay it continues, so the solver keeps them in one unit. Absent = the
   * booking continues nobody.
   */
  guestKey?: string;
  /**
   * 0..366, higher = arriving sooner. Only breaks ties between plans that move
   * the same number of guests: prefer moving the guest who arrives later.
   */
  urgency?: number;
}

export interface ReallocMove {
  reservationNumber: string;
  from: string; // current unit
  to: string; // new unit
  label?: string;
  /** The nights this booking covers — shown so the operator can verify the move. */
  checkIn?: string;
  checkOut?: string;
  /** Moving this guest requires informing them (they were already messaged). */
  needsGuestNotice?: boolean;
}

export interface ReallocPlacement {
  reservationNumber: string;
  room: string; // unit the unallocated booking goes to
  label?: string;
  checkIn?: string;
  checkOut?: string;
  /**
   * Set when the same guest has an adjoining stay that ends up in a DIFFERENT
   * unit (the unit named here) — i.e. the guest would have to change rooms.
   * Only happens when no plan can keep them together.
   */
  splitFrom?: string;
}

export interface ReallocPlan {
  feasible: boolean;
  /**
   * true = solvable only by moving a guest who's already been sent check-in
   * info (silent reshuffle was impossible). Such moves carry `needsGuestNotice`.
   */
  escalated?: boolean;
  /** Why it can't be solved within the type (only when !feasible). */
  reason?: string;
  /** Unallocated booking(s) → their assigned unit. */
  placements: ReallocPlacement[];
  /** Existing bookings that must change unit (the "movements"). */
  moves: ReallocMove[];
  /** Full unit assignment for every booking in the affected component. */
  assignment: Record<string, string>;
  /** How many placements split a guest's stay across two units (see `splitFrom`). */
  staySplits?: number;
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

  const pinned = component.filter((r) => !r.movable);
  const movable = component.filter((r) => r.movable);

  // Safety valve. The backtracking is O(units^movable) worst case (units ≤ 3),
  // but the fewest-move pruning makes feasible cases cheap in practice — a real
  // 15-movable peak-season component solves in ~36 search nodes, because every
  // far-future booking parks in its current unit on the first branch. So the
  // movable COUNT isn't the real cost, and we don't cap on it (an earlier
  // `> 12` cap needlessly punted solvable cases to manual). Instead the search
  // itself is bounded by a node budget (below); this guard only trips on
  // pathologically large inputs where even setting up is pointless.
  if (movable.length > 30) {
    return {
      ...empty,
      reason: "Too many movable bookings to auto-resolve — handle manually in Beds24.",
    };
  }

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

  // ── Stay continuity (soft, but ranked above the move count) ──
  // An unplaced booking that runs back-to-back with the same guest's other
  // booking — an extension that landed on the virtual room — should go into the
  // unit that guest is in, otherwise they pack up mid-stay. Each such link
  // costs SPLIT if the two ends land in different units. Links are attached to
  // whichever end is assigned LATER in the search, so each is counted once and
  // the running cost stays a valid lower bound for pruning.
  const movableIndex = new Map(movable.map((m, i) => [m.reservationNumber, i]));
  const links = movable.map(() => ({ fixed: [] as string[], earlier: [] as number[] }));
  const seenPair = new Set<string>();
  for (const [i, s] of movable.entries()) {
    if (s.currentRoom !== null || !s.guestKey) continue; // only unplaced bookings carry links
    for (const o of reservations) {
      if (o === s || o.guestKey !== s.guestKey) continue;
      if (o.checkOut !== s.checkIn && s.checkOut !== o.checkIn) continue;
      const j = movableIndex.get(o.reservationNumber);
      if (j === undefined) {
        // Pinned, or outside the component: its unit can't change.
        if (o.currentRoom) links[i].fixed.push(o.currentRoom);
        continue;
      }
      const pair = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seenPair.has(pair)) continue;
      seenPair.add(pair);
      links[Math.max(i, j)].earlier.push(Math.min(i, j));
    }
  }

  // ── Backtracking: assign each movable to a unit, cheapest plan wins ──
  // Cost, lexicographic via magnitudes:
  //   SPLIT per guest left changing rooms mid-stay        (worst)
  //   MOVE  per guest/stay relocated (+ urgency tie-break: moving a guest who
  //         arrives sooner costs a little more than one who arrives later)
  // Every step adds ≥ 0, so "cost so far ≥ best" is a sound prune.
  const SPLIT = 1_000_000_000;
  const MOVE = 1_000_000;

  // Try the unit that costs nothing first (current unit, or the unit an
  // unplaced booking's adjoining stay is in) so a cheap plan is found early and
  // prunes the rest of the search.
  const orderedUnitsFor = (m: ReallocInput, i: number): string[] => {
    const preferred = m.currentRoom ?? links[i].fixed[0] ?? null;
    return preferred && units.includes(preferred)
      ? [preferred, ...units.filter((u) => u !== preferred)]
      : units;
  };

  let bestCost = Infinity;
  let bestAssignment: Record<string, string> | null = null;
  const assignedUnit: (string | undefined)[] = new Array(movable.length);

  // Hard bound on the search so a pathological (usually infeasible, un-prunable)
  // input can never hang the operator's browser. Feasible cases finish in a
  // tiny fraction of this; 500k cheap nodes is sub-100ms if it's ever reached.
  let searchNodes = 0;
  let aborted = false;
  const NODE_BUDGET = 500_000;

  const assignment: Record<string, string> = {};
  for (const p of pinned) assignment[p.reservationNumber] = p.currentRoom!;

  const recurse = (i: number, costSoFar: number) => {
    if (aborted) return;
    if (++searchNodes > NODE_BUDGET) { aborted = true; return; }
    if (costSoFar >= bestCost) return; // prune
    if (i === movable.length) {
      bestCost = costSoFar;
      bestAssignment = { ...assignment };
      return;
    }
    const m = movable[i];
    for (const unit of orderedUnitsFor(m, i)) {
      if (unitIntervals[unit].some((x) => overlaps(x, m))) continue;
      let step = m.currentRoom && m.currentRoom !== unit ? MOVE + (m.urgency ?? 0) : 0;
      for (const f of links[i].fixed) if (f !== unit) step += SPLIT;
      for (const j of links[i].earlier) if (assignedUnit[j] !== unit) step += SPLIT;
      unitIntervals[unit].push(m);
      assignment[m.reservationNumber] = unit;
      assignedUnit[i] = unit;
      recurse(i + 1, costSoFar + step);
      unitIntervals[unit].pop();
      delete assignment[m.reservationNumber];
      assignedUnit[i] = undefined;
    }
  };
  recurse(0, 0);

  if (!bestAssignment) {
    return {
      ...empty,
      reason: aborted
        ? "Reshuffle search too large to auto-resolve — handle manually in Beds24."
        : "No conflict-free arrangement exists within this room type — likely oversold for these dates (a cross-type move or refusing the booking may be required).",
    };
  }

  // ── Build placements + moves from the winning assignment ──
  const finalAssignment: Record<string, string> = { ...(bestAssignment as Record<string, string>) };
  const finalUnitOf = (r: ReallocInput): string | null => finalAssignment[r.reservationNumber] ?? r.currentRoom;
  const placements: ReallocPlacement[] = [];
  const moves: ReallocMove[] = [];
  for (const r of component) {
    const to = finalAssignment[r.reservationNumber];
    if (r.currentRoom === null) {
      // Does the same guest's adjoining stay end up somewhere else?
      const apart = r.guestKey
        ? reservations.find(
            (o) =>
              o !== r &&
              o.guestKey === r.guestKey &&
              (o.checkOut === r.checkIn || r.checkOut === o.checkIn) &&
              finalUnitOf(o) !== to,
          )
        : undefined;
      placements.push({
        reservationNumber: r.reservationNumber,
        room: to,
        label: r.label,
        checkIn: r.checkIn,
        checkOut: r.checkOut,
        ...(apart ? { splitFrom: finalUnitOf(apart) ?? undefined } : {}),
      });
    } else if (r.currentRoom !== to) {
      // A multi-booking stay moves as one: every booking in it, same target.
      const parts = r.members ?? [{ reservationNumber: r.reservationNumber, checkIn: r.checkIn, checkOut: r.checkOut }];
      for (const part of parts) {
        moves.push({
          reservationNumber: part.reservationNumber,
          from: r.currentRoom,
          to,
          label: r.label,
          checkIn: part.checkIn,
          checkOut: part.checkOut,
          ...(r.messaged ? { needsGuestNotice: true } : {}),
        });
      }
    }
    for (const part of r.members ?? []) finalAssignment[part.reservationNumber] = to;
  }

  const staySplits = placements.filter((p) => p.splitFrom).length;
  return { feasible: true, placements, moves, assignment: finalAssignment, ...(staySplits ? { staySplits } : {}) };
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
  /** Cancelled bookings hold no room — they must not count as occupancy. */
  isCancelled?: boolean;
  linkedRooms?: string[];
  /** Mid-stay moves (utils/roomSegments) — where the guest physically was, per night. */
  roomSegments?: RoomSegment[];
  firstName?: string;
  lastName?: string;
  /** Operator-confirmed continuation of another booking (utils/stayChains). */
  stayLink?: StayLink | null;
  /** Bookings the operator marked "not the same guest". */
  stayLinkRejected?: string[];
}

function nameOf(r: ResRef): string {
  const n = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  return n || r.reservationNumber;
}

/** Add `n` days to a 'YYYY-MM-DD' date (UTC math — inputs carry no time). */
function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000);
}

/**
 * Normalised guest identity — lives in utils/stayChains (the resolver's
 * "same stay" key is built from it there); re-exported for existing callers.
 */
export { guestKeyOf };

/**
 * Turn a reservation list into solver rows for one allocation group. Shared by
 * the unallocated resolver and the stay-request quote so both apply the SAME
 * rules:
 *   - departed and cancelled stays are ignored (they hold nothing);
 *   - occupancy comes from `occupancySpans` (packages hold every linked unit,
 *     a mid-stay move holds each unit only for its own nights) and is clipped
 *     to tonight — past nights are history and can neither conflict nor move;
 *   - a guest who is staying or arrives today is pinned, as are blackouts;
 *   - guests arriving tomorrow are `messaged` (callers prefer leaving them put);
 *   - ONE guest's back-to-back bookings in the same unit — an extension booked
 *     as a separate reservation — become ONE row that moves whole or not at
 *     all. Without this, the solver happily moved just the extension night,
 *     which would make the guest change rooms mid-stay (BH-93987993, the
 *     one-night extension of BH-93901799, Oct 2026). "One guest" =
 *     `sameStayKeys`: an operator stay link wins over names both ways (a
 *     link joins different names, "not the same guest" splits equal ones).
 * Unplaced bookings of the group's type become seeds (currentRoom = null).
 */
export function buildGroupInputs(all: ResRef[], group: AllocationGroup, today: string): ReallocInput[] {
  const tomorrow = addDaysISO(today, 1);
  const stayKeys = sameStayKeys(all);
  const unitNames = new Set(group.units.map((u) => u.room));

  interface Row {
    id: string;
    unit: string;
    arrival: string; // the booking's real check-in
    start: string; // first night in THIS unit (≠ arrival after a mid-stay move)
    from: string; // start clipped to tonight
    to: string;
    movable: boolean;
    guestKey?: string;
    label: string;
  }
  const seeds: ReallocInput[] = [];
  const rows: Row[] = [];

  for (const r of all) {
    if (r.checkOutDate <= today) continue; // departed — irrelevant
    // Cancelled bookings (incl. non-arrivals) free their nights — they occupy
    // no unit, even though they linger in the reservations array.
    if (r.isCancelled) continue;

    if (r.isUnallocatedVR) {
      if (groupForTypeLabel(r.room) === group) {
        seeds.push({
          reservationNumber: r.reservationNumber,
          checkIn: r.checkInDate,
          checkOut: r.checkOutDate,
          currentRoom: null,
          movable: true,
          label: nameOf(r),
          guestKey: stayKeys.get(r.reservationNumber),
        });
      }
      continue;
    }

    const spans = occupancySpans(r).filter((s) => unitNames.has(s.room) && s.to > today);
    if (spans.length === 0) continue; // not in this group (or only in its past)

    // One guest booking several apartments is ONE reservation holding several
    // units. Each unit becomes its own row "BH-123#K.106" and moves on its own —
    // swapping one apartment within the same type is invisible to that guest,
    // and often the only way to place an arriving booking (BH-93351977). The
    // legs share dates, so the no-overlap rule keeps them in different units.
    // The suffix is used for EVERY package, even if only one of its legs is in
    // this group: the move endpoint resolves "#unit" to the right Beds24
    // booking from live state, whereas a bare number would address the master,
    // which may be the leg in the OTHER group.
    const isPackage = (r.linkedRooms?.length ?? 0) > 1;
    // A non-package booking still spanning two units after clipping can only
    // be inconsistent segment data — keep it, but pinned and uniquely keyed.
    const inconsistent = !isPackage && spans.length > 1;
    const inHouse = r.checkInDate <= today;

    for (const s of spans) {
      rows.push({
        id: isPackage ? `${r.reservationNumber}#${s.room}` : inconsistent ? `${r.reservationNumber}@${s.room}` : r.reservationNumber,
        unit: s.room,
        arrival: r.checkInDate,
        start: s.from,
        from: s.from > today ? s.from : today,
        to: s.to,
        movable: !inHouse && !r.isBlackout && !inconsistent,
        guestKey: stayKeys.get(r.reservationNumber),
        label: nameOf(r),
      });
    }
  }

  // ── Chain one guest's back-to-back bookings in the same unit into a stay ──
  const toInput = (chain: Row[]): ReallocInput => {
    const first = chain[0];
    const last = chain[chain.length - 1];
    // If any part of the stay can't move (first booking already in-house), none can.
    const movable = chain.every((c) => c.movable);
    return {
      reservationNumber: chain.length === 1 ? first.id : `stay:${chain.map((c) => c.id).join("+")}`,
      checkIn: first.from,
      checkOut: last.to,
      currentRoom: first.unit,
      movable,
      messaged: movable && first.arrival <= tomorrow,
      label: first.label,
      guestKey: first.guestKey,
      urgency: movable ? Math.max(0, 366 - daysBetween(today, first.arrival)) : 0,
      ...(chain.length > 1
        ? { members: chain.map((c) => ({ reservationNumber: c.id, checkIn: c.start, checkOut: c.to })) }
        : {}),
    };
  };

  const byUnit = new Map<string, Row[]>();
  for (const row of rows) {
    const list = byUnit.get(row.unit);
    if (list) list.push(row);
    else byUnit.set(row.unit, [row]);
  }

  const inputs: ReallocInput[] = [];
  for (const list of byUnit.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start) || a.to.localeCompare(b.to));
    let chain: Row[] = [];
    for (const row of list) {
      const prev = chain[chain.length - 1];
      const continues = prev !== undefined && !!prev.guestKey && prev.guestKey === row.guestKey && prev.to === row.start;
      if (!continues && chain.length > 0) {
        inputs.push(toInput(chain));
        chain = [];
      }
      chain.push(row);
    }
    if (chain.length > 0) inputs.push(toInput(chain));
  }

  return [...seeds, ...inputs];
}

/**
 * The resolver's guest-messaging policy, shared by every caller:
 *   Pass 1 (silent) leaves guests who've already had check-in info where they
 *   are. Pass 2 (escalation) may move them, flagged `needsGuestNotice`.
 * A plan that splits a guest's stay across two units only wins if escalating
 * can't avoid the split — re-messaging a guest who hasn't arrived beats asking
 * one to change rooms mid-stay.
 */
export function solveTwoTier(group: AllocationGroup, inputs: ReallocInput[]): ReallocPlan {
  const silent = planReallocation(group, inputs.map((i) => (i.messaged ? { ...i, movable: false } : i)));
  if (silent.feasible && !silent.staySplits) return silent;
  if (!inputs.some((i) => i.messaged && i.movable)) return silent; // escalating would search the same space

  const escalated = planReallocation(group, inputs);
  if (!escalated.feasible) return silent.feasible ? silent : escalated;
  if (silent.feasible && (silent.staySplits ?? 0) <= (escalated.staySplits ?? 0)) return silent;
  return { ...escalated, escalated: escalated.moves.some((m) => m.needsGuestNotice) };
}

/**
 * Independent safety net, run on every suggestion before the operator sees it.
 * Re-derives occupancy straight from the reservations — NOT from the solver's
 * rows — and checks the two hard rules:
 *   1. never move a guest who is already staying or arrives today, and never
 *      move part of a guest's continuous stay without the rest of it;
 *   2. never put a booking into a unit that's taken on any of its nights.
 * Returns a human-readable violation, or null when the plan is sound. The
 * solver should never trip it; if it does, the planner has a bug and the
 * operator gets "handle manually" instead of a wrong suggestion.
 */
export function verifyPlan(all: ResRef[], group: AllocationGroup, plan: ReallocPlan, today: string): string | null {
  const units = new Set(group.units.map((u) => u.room));
  const stayKeys = sameStayKeys(all);
  const destination = new Map<string, string>();
  for (const m of plan.moves) destination.set(m.reservationNumber, m.to);
  for (const p of plan.placements) destination.set(p.reservationNumber, p.room);

  interface Occ {
    id: string;
    name: string;
    unit: string; // where it is AFTER the plan
    origUnit: string | null;
    arrival: string;
    start: string;
    from: string;
    to: string;
    key?: string;
  }
  const occ: Occ[] = [];
  for (const r of all) {
    if (r.isCancelled || r.checkOutDate <= today) continue;
    if (r.isUnallocatedVR) {
      const unit = destination.get(r.reservationNumber);
      if (unit) {
        occ.push({
          id: r.reservationNumber, name: nameOf(r), unit, origUnit: null, arrival: r.checkInDate,
          start: r.checkInDate, from: r.checkInDate > today ? r.checkInDate : today, to: r.checkOutDate,
          key: stayKeys.get(r.reservationNumber),
        });
      }
      continue;
    }
    const isPackage = (r.linkedRooms?.length ?? 0) > 1;
    for (const s of occupancySpans(r)) {
      if (s.to <= today) continue;
      const id = isPackage ? `${r.reservationNumber}#${s.room}` : r.reservationNumber;
      const unit = destination.get(id) ?? s.room;
      if (!units.has(unit)) continue;
      occ.push({
        id, name: nameOf(r), unit, origUnit: s.room, arrival: r.checkInDate,
        start: s.from, from: s.from > today ? s.from : today, to: s.to,
        key: stayKeys.get(r.reservationNumber),
      });
    }
  }

  for (const id of destination.keys()) {
    const mine = occ.filter((o) => o.id === id);
    if (mine.length === 0) return `it relocates ${id}, which isn't a live booking of ${group.typeLabel}.`;
    // Rule 2 — nothing may share the destination unit on the same nights.
    for (const a of mine) {
      for (const b of occ) {
        if (b.id === a.id || b.unit !== a.unit) continue;
        if (a.from < b.to && b.from < a.to) {
          return `${a.name} would be double-booked with ${b.name} in ${a.unit}.`;
        }
      }
    }
  }

  for (const m of plan.moves) {
    const mine = occ.find((o) => o.id === m.reservationNumber)!;
    // Rule 1a — a guest who is staying or arriving today is never moved.
    if (mine.arrival <= today) return `it moves ${mine.name}, who is already staying or arrives today.`;
    // Rule 1b — the same guest's adjoining booking in the same unit must move along.
    for (const o of occ) {
      if (o.id === mine.id || !mine.key || o.key !== mine.key || o.origUnit !== mine.origUnit) continue;
      const adjoining = o.to === mine.start || mine.to === o.start;
      if (adjoining && o.unit !== mine.unit) {
        return `it splits ${mine.name}'s stay — one booking would go to ${mine.unit}, the adjoining one stays in ${o.unit}.`;
      }
    }
  }
  return null;
}

/**
 * Find the allocation group for an unallocated booking and compute the
 * fewest-move plan to give it a home. Inputs come from `buildGroupInputs`
 * (departed/cancelled ignored, in-house + blackouts pinned, one guest's
 * back-to-back bookings kept together), the guest-messaging policy from
 * `solveTwoTier`, and every feasible plan must pass `verifyPlan` before it is
 * shown.
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

  const plan = solveTwoTier(group, buildGroupInputs(all, group, today));
  if (!plan.feasible) return { group, plan };

  const violation = verifyPlan(all, group, plan, today);
  if (violation) {
    console.error("[roomAllocation] safety check rejected a plan", { targetReservationNumber, violation, plan });
    return {
      group,
      plan: {
        feasible: false,
        placements: [],
        moves: [],
        assignment: {},
        reason: `Safety check stopped this suggestion: ${violation} Handle it manually in Beds24 — and please report it, it means the planner has a bug.`,
      },
    };
  }
  return { group, plan };
}

// ─── Execute-time validation ───────────────────────────────────────────────────

/** Minimal booking shape for the post-move double-book check. */
export interface MoveBooking {
  id: number;
  arrival: string; // YYYY-MM-DD
  departure: string; // YYYY-MM-DD (exclusive)
}

/**
 * Given the post-move allocation (unit → the bookings that would sit in it) and
 * the ids of the bookings actually being moved, return the first double-book the
 * move would CREATE — or null if there is none.
 *
 * A conflict between two bookings that are BOTH staying put is pre-existing: their
 * roomId didn't change, so they overlapped before this move too. Blocking on it
 * would let a stale/past overbooking elsewhere in the unit veto an unrelated
 * reshuffle (the 60-day validation fetch can drag such rows in). So we only flag
 * a pair when at least one side is being moved.
 */
export function findMoveCreatedConflict(
  perUnit: Record<string, MoveBooking[]>,
  movedIds: Set<number>,
): { unit: string; a: number; b: number } | null {
  for (const [unit, list] of Object.entries(perUnit)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (!movedIds.has(list[i].id) && !movedIds.has(list[j].id)) continue;
        // Half-open overlap: each starts before the other ends.
        if (list[i].arrival < list[j].departure && list[j].arrival < list[i].departure) {
          return { unit, a: list[i].id, b: list[j].id };
        }
      }
    }
  }
  return null;
}
