/**
 * Feasibility planner for a stay REQUEST that is not in the system yet.
 *
 * The room-reallocation resolver (`planForUnallocated`) answers "Beds24 sold a
 * stay it can't fit into one unit — how do we place it?". This answers the
 * question one step earlier: "a guest is ASKING for these dates — can we take
 * them at all, and in what shape?". Nothing here is booked; it is pure
 * what-if arithmetic over the reservations already on screen.
 *
 * Long requests (weeks or months, usually short notice) rarely fit one unit, so
 * the output is an ITINERARY: the fewest consecutive segments that cover the
 * span, each segment being one sellable room type for a run of nights, with the
 * physical unit and any within-type shuffle of other guests needed to free it.
 * Each segment becomes its own reservation — priced separately by Beds24, since
 * an offer only exists for a stay Beds24 can actually sell.
 *
 * Two layers, matching how Beds24 itself works:
 *   - SELLABLE (what a guest can book): a room type. Beds24 counts availability
 *     per night as a unit count on the virtual room, with no idea which physical
 *     unit a stay lands in — which is exactly why unallocated-VR bookings exist.
 *   - PHYSICAL (what the operator must arrange): a specific unit per segment,
 *     reached via `planReallocation`, possibly by shuffling movable guests.
 *
 * Reuses the live solver as its oracle rather than reimplementing availability:
 * "can this type host [from,to)?" is asked by injecting the request as an
 * unallocated booking. So this agrees with the resolver in production by
 * construction, including its cancelled-bookings and in-house rules.
 */
import {
  ALLOCATION_GROUPS,
  PHYSICAL_ROOMS,
  planReallocation,
  type AllocationGroup,
  type ReallocInput,
  type ReallocMove,
  type ResRef,
} from "./roomAllocation";

/** A thing a guest can book: one room type, selling into one or more units. */
export interface SellableUnit {
  /** Beds24 sellable roomId — what `/inventory/rooms/offers` prices. */
  roomId: number;
  /** Operator-facing label. */
  label: string;
  /** Physical units this sells into. */
  units: string[];
  /** Set when the type has several units, i.e. a shuffle is possible. */
  group: AllocationGroup | null;
}

/**
 * Everything bookable. The two standalone types have no shuffle group — one
 * unit each, so a stay either fits or it doesn't. Keep these roomIds in sync
 * with `PHYSICAL_ROOMS` (roomAllocation.ts) and `UNIT_MAP` in
 * app/api/bookings/route.ts.
 */
export const SELLABLE_UNITS: SellableUnit[] = [
  ...ALLOCATION_GROUPS.map((g) => ({
    roomId: g.vrRoomId,
    label: g.typeLabel,
    units: g.units.map((u) => u.room),
    group: g,
  })),
  { roomId: 656437, label: "K.201 — 2KK Deluxe", units: ["K.201"], group: null },
  { roomId: 674672, label: "O.308 — 2 Bedroom", units: ["O.308"], group: null },
];

/** One reservation-to-be: a run of nights in one sellable type. */
export interface StaySegment {
  from: string; // YYYY-MM-DD first night
  to: string; // YYYY-MM-DD departure (exclusive)
  nights: number;
  sellableRoomId: number;
  sellableLabel: string;
  /** Physical unit the guest occupies for this segment. */
  room: string;
  /** Other guests who must change unit so this segment can happen. */
  moves: ReallocMove[];
  /** true = a move hits a guest whose room/door code already went out. */
  escalated: boolean;
}

/** Who holds a unit on the night that killed the request. */
export interface BlockingHolder {
  room: string;
  /** Guest name, blackout marker, or null when the unit is actually free. */
  who: string | null;
  from?: string;
  to?: string;
  inHouse?: boolean;
}

export type StayRequestPlan =
  | { feasible: true; segments: StaySegment[]; totalNights: number }
  | { feasible: false; blockedAt: string; holders: BlockingHolder[] };

const ALL_UNIT_NAMES = PHYSICAL_ROOMS.map((u) => u.room);
/** Runaway guard: a sane itinerary is a handful of segments, never dozens. */
const MAX_SEGMENTS = 20;

function addDaysISO(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86_400_000,
  );
}

function nameOf(r: ResRef): string {
  const n = `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim();
  return n || r.reservationNumber;
}

/** Physical units a reservation holds — [] when it's an unplaced VR booking. */
function unitsOf(r: ResRef): string[] {
  const linked = r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : [r.room];
  return linked.filter((u) => ALL_UNIT_NAMES.includes(u));
}

/** Stays that still matter and actually hold a room. Cancelled hold nothing. */
function isLiveOccupancy(r: ResRef, today: string): boolean {
  return !r.isCancelled && r.checkOutDate > today;
}

/**
 * Group bookings as solver inputs, scoped and pinned exactly like
 * `planForUnallocated` does: departed stays dropped, cancellations ignored,
 * in-house/blackout/package pinned, guests arriving by tomorrow marked
 * `messaged` so the caller can prefer leaving them alone.
 */
function groupInputs(all: ResRef[], group: AllocationGroup, today: string): ReallocInput[] {
  const tomorrow = addDaysISO(today, 1);
  const unitNames = group.units.map((u) => u.room);
  const inputs: ReallocInput[] = [];

  for (const r of all) {
    if (!isLiveOccupancy(r, today)) continue;

    // Another unplaced booking of this type must be given a home too.
    if (r.isUnallocatedVR) {
      if (r.room === group.typeLabel) {
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

    const occupied = unitsOf(r).filter((u) => unitNames.includes(u));
    if (occupied.length === 0) continue;

    const inHouse = r.checkInDate <= today;
    const isPackage = occupied.length > 1 || (r.linkedRooms?.length ?? 0) > 1;
    const movable = !inHouse && !r.isBlackout && !isPackage;

    for (const unit of occupied) {
      inputs.push({
        reservationNumber: occupied.length > 1 ? `${r.reservationNumber}#${unit}` : r.reservationNumber,
        checkIn: r.checkInDate,
        checkOut: r.checkOutDate,
        currentRoom: unit,
        movable,
        messaged: movable && r.checkInDate <= tomorrow,
        label: nameOf(r),
      });
    }
  }
  return inputs;
}

interface Fit {
  room: string;
  moves: ReallocMove[];
  escalated: boolean;
}

/** The synthetic id the hypothetical stay carries through the solver. */
const REQUEST_ID = "__REQUEST__";

/**
 * Can this type host [from,to) in one unit? Silent pass first (leave
 * already-messaged guests put), escalating only if that fails — the policy the
 * resolver already uses, so a quote never promises a silent shuffle it can't do.
 */
function fitGroup(group: AllocationGroup, inputs: ReallocInput[], from: string, to: string): Fit | null {
  const request: ReallocInput = {
    reservationNumber: REQUEST_ID,
    checkIn: from,
    checkOut: to,
    currentRoom: null,
    movable: true,
    label: "REQUEST",
  };

  const silent = planReallocation(group, [...inputs.map((i) => (i.messaged ? { ...i, movable: false } : i)), request]);
  if (silent.feasible) {
    return {
      room: silent.placements.find((p) => p.reservationNumber === REQUEST_ID)?.room ?? "?",
      moves: silent.moves,
      escalated: false,
    };
  }

  const escalated = planReallocation(group, [...inputs, request]);
  if (!escalated.feasible) return null;

  const messagedIds = new Set(inputs.filter((i) => i.messaged).map((i) => i.reservationNumber));
  return {
    room: escalated.placements.find((p) => p.reservationNumber === REQUEST_ID)?.room ?? "?",
    moves: escalated.moves.map((m) =>
      messagedIds.has(m.reservationNumber) ? { ...m, needsGuestNotice: true } : m,
    ),
    escalated: escalated.moves.length > 0,
  };
}

/**
 * Longest stay this type can absorb starting at `from`, capped at `cap`.
 * Binary search is valid because feasibility is monotonic: if a type can host
 * a long stay it can host any shorter one from the same date.
 */
function maxReachGroup(
  group: AllocationGroup,
  inputs: ReallocInput[],
  from: string,
  cap: string,
): { end: string; fit: Fit } | null {
  const one = fitGroup(group, inputs, from, addDaysISO(from, 1));
  if (!one) return null;

  let lo = 2;
  let hi = nightsBetween(from, cap);
  let bestN = 1;
  let bestFit = one;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const fit = fitGroup(group, inputs, from, addDaysISO(from, mid));
    if (fit) {
      bestN = mid;
      bestFit = fit;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return { end: addDaysISO(from, bestN), fit: bestFit };
}

/** Busy night-intervals of a single standalone unit. */
function busySpans(all: ResRef[], unit: string, today: string): { from: string; to: string }[] {
  return all
    .filter((r) => isLiveOccupancy(r, today) && unitsOf(r).includes(unit))
    .map((r) => ({ from: r.checkInDate, to: r.checkOutDate }));
}

/** Who holds each unit on `date` — the "why can't we sell this night" report. */
function holdersOn(all: ResRef[], date: string, today: string): BlockingHolder[] {
  return ALL_UNIT_NAMES.map((room) => {
    const r = all.find(
      (x) => !x.isCancelled && unitsOf(x).includes(room) && x.checkInDate <= date && x.checkOutDate > date,
    );
    if (!r) return { room, who: null };
    return {
      room,
      who: r.isBlackout ? "BLACKOUT" : nameOf(r),
      from: r.checkInDate,
      to: r.checkOutDate,
      inHouse: r.checkInDate <= today,
    };
  });
}

export interface PlanStayOptions {
  /** false = quote only what's already free, never move another guest. */
  allowShuffle?: boolean;
}

/**
 * Plan the fewest-segment itinerary covering [checkIn, checkOut).
 *
 * Greedy longest-reach: from the current position take the type that can hold
 * the guest longest, then continue from there. That minimises the number of
 * segments — i.e. the number of times the guest packs a suitcase, which is the
 * cost the guest actually feels. Ties break towards staying in the type we are
 * already in, then towards moving fewer other guests.
 */
export function planStayRequest(
  all: ResRef[],
  checkIn: string,
  checkOut: string,
  today: string,
  opts: PlanStayOptions = {},
): StayRequestPlan {
  const allowShuffle = opts.allowShuffle !== false;
  const totalNights = nightsBetween(checkIn, checkOut);
  if (totalNights <= 0) return { feasible: false, blockedAt: checkIn, holders: [] };

  const inputsByGroup = new Map<string, ReallocInput[]>(
    ALLOCATION_GROUPS.map((g) => [g.typeLabel, groupInputs(all, g, today)]),
  );
  const spansByUnit = new Map<string, { from: string; to: string }[]>(
    ALL_UNIT_NAMES.map((u) => [u, busySpans(all, u, today)]),
  );

  const segments: StaySegment[] = [];
  let cursor = checkIn;

  while (cursor < checkOut && segments.length < MAX_SEGMENTS) {
    let best: { sellable: SellableUnit; end: string; fit: Fit } | null = null;

    for (const sellable of SELLABLE_UNITS) {
      let candidate: { end: string; fit: Fit } | null = null;

      if (sellable.group && allowShuffle) {
        candidate = maxReachGroup(sellable.group, inputsByGroup.get(sellable.label)!, cursor, checkOut);
      } else {
        // No shuffling: a unit is usable until the next stay starts.
        for (const unit of sellable.units) {
          const spans = spansByUnit.get(unit)!;
          if (spans.some((s) => s.from <= cursor && s.to > cursor)) continue; // occupied tonight
          const nextStart = spans.map((s) => s.from).filter((f) => f > cursor).sort()[0];
          const end = nextStart && nextStart < checkOut ? nextStart : checkOut;
          if (end > cursor && (!candidate || end > candidate.end)) {
            candidate = { end, fit: { room: unit, moves: [], escalated: false } };
          }
        }
      }
      if (!candidate) continue;

      const better =
        !best ||
        candidate.end > best.end ||
        (candidate.end === best.end &&
          // Prefer continuity (no suitcase), then the least disruption to others.
          (sellable.roomId === segments.at(-1)?.sellableRoomId ||
            candidate.fit.moves.length < best.fit.moves.length));
      if (better) best = { sellable, end: candidate.end, fit: candidate.fit };
    }

    if (!best) return { feasible: false, blockedAt: cursor, holders: holdersOn(all, cursor, today) };

    segments.push({
      from: cursor,
      to: best.end,
      nights: nightsBetween(cursor, best.end),
      sellableRoomId: best.sellable.roomId,
      sellableLabel: best.sellable.label,
      room: best.fit.room,
      moves: best.fit.moves,
      escalated: best.fit.escalated,
    });
    cursor = best.end;
  }

  if (cursor < checkOut) {
    return { feasible: false, blockedAt: cursor, holders: holdersOn(all, cursor, today) };
  }
  return { feasible: true, segments, totalNights };
}
