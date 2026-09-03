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

/**
 * Who holds each unit on `date` — the "why can't we sell this night" report.
 * Scoped to the units actually on offer, so excluding a type doesn't produce a
 * report full of rooms the operator already ruled out.
 */
function holdersOn(all: ResRef[], date: string, today: string, units = ALL_UNIT_NAMES): BlockingHolder[] {
  return units.map((room) => {
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
  /**
   * Sellable roomIds the operator is willing to offer. Undefined = all of them;
   * an empty array means nothing is on the table and the request fails.
   * Used to answer "could we do this in the CHEAPER type instead?".
   */
  allowedRoomIds?: number[];
  /**
   * Spend as many nights as possible in this type, bridging the nights it can't
   * cover with the other allowed types. Without it the planner minimises
   * segments, which always favours whichever type spans the most nights — and
   * that is usually the expensive one. With it, a guest who wants the cheap
   * studio gets the cheap studio wherever inventory allows, at the cost of more
   * room changes. Undefined = minimise segments.
   */
  preferredRoomId?: number;
  /**
   * How many times the guest may change room. Maximising nights in the cheap
   * type and keeping the guest put are opposing goals — a preference alone can
   * produce seven reservations for six weeks, which is cheap and horrible. With
   * a budget, segments are merged back until the itinerary fits it, giving up
   * the fewest preferred nights per merge. Undefined = no cap.
   */
  maxRoomChanges?: number;
}

/**
 * Plan the itinerary covering [checkIn, checkOut).
 *
 * Three phases, because the objectives pull against each other:
 *
 *   1. SEGMENT — greedy longest-reach from the cursor, which minimises the
 *      number of times the guest packs a suitcase. With `preferredRoomId` the
 *      greed changes target: take the preferred type whenever it can host
 *      tonight, and bridge the nights it cannot with another allowed type.
 *   2. MERGE — if `maxRoomChanges` is set, repeatedly collapse the adjacent
 *      pair that costs the fewest preferred nights until the itinerary fits the
 *      budget. Maximising cheap nights and minimising moves are different
 *      goals; this is how the operator picks a point between them.
 *   3. PLACE — walk the segments in order and assign physical units, THREADING
 *      STATE: each segment's shuffle is planned against the arrangement the
 *      earlier segments' moves already produced. Planning every segment against
 *      the original occupancy is what makes a plan that moves one guest twice
 *      from the same starting unit — an itinerary nobody can actually execute.
 *
 * Phase 3 cannot change phase 1's feasibility, because whether a type can host
 * a span in one unit depends on the per-night unit counts and the pinned
 * (in-house/blackout) stays — not on where the movable guests currently sit,
 * since the solver is free to permute them again.
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
  const allowed = opts.allowedRoomIds
    ? SELLABLE_UNITS.filter((s) => opts.allowedRoomIds!.includes(s.roomId))
    : SELLABLE_UNITS;
  /** Only units of the offered types — a blocking report must not blame a room the operator excluded. */
  const scopedUnits = allowed.flatMap((s) => s.units);

  if (totalNights <= 0) return { feasible: false, blockedAt: checkIn, holders: [] };
  if (allowed.length === 0) return { feasible: false, blockedAt: checkIn, holders: [] };

  // Mutable through phase 3 — moves are applied as they are committed.
  const inputsByGroup = new Map<string, ReallocInput[]>(
    ALLOCATION_GROUPS.map((g) => [g.typeLabel, groupInputs(all, g, today)]),
  );
  const spansByUnit = new Map<string, { from: string; to: string }[]>(
    ALL_UNIT_NAMES.map((u) => [u, busySpans(all, u, today)]),
  );

  /** Can this type host [from,to) in one unit? Fit is computed against CURRENT state. */
  const fitFor = (sellable: SellableUnit, from: string, to: string): Fit | null => {
    if (sellable.group && allowShuffle) {
      return fitGroup(sellable.group, inputsByGroup.get(sellable.label)!, from, to);
    }
    for (const unit of sellable.units) {
      const spans = spansByUnit.get(unit)!;
      if (!spans.some((sp) => sp.from < to && sp.to > from)) {
        return { room: unit, moves: [], escalated: false };
      }
    }
    return null;
  };

  /** Longest run one type can hold from `from`, or null if it can't take that night. */
  const reachOf = (sellable: SellableUnit, from: string, cap: string): { end: string; fit: Fit } | null => {
    if (sellable.group && allowShuffle) {
      return maxReachGroup(sellable.group, inputsByGroup.get(sellable.label)!, from, cap);
    }
    // No shuffling: a unit is usable until the next stay starts.
    let candidate: { end: string; fit: Fit } | null = null;
    for (const unit of sellable.units) {
      const spans = spansByUnit.get(unit)!;
      if (spans.some((sp) => sp.from <= from && sp.to > from)) continue; // occupied tonight
      const nextStart = spans.map((sp) => sp.from).filter((f) => f > from).sort()[0];
      const end = nextStart && nextStart < cap ? nextStart : cap;
      if (end > from && (!candidate || end > candidate.end)) {
        candidate = { end, fit: { room: unit, moves: [], escalated: false } };
      }
    }
    return candidate;
  };

  const preferred = allowed.find((s) => s.roomId === opts.preferredRoomId) ?? null;

  /** First night after `from` that the preferred type can take. */
  const nextPreferredStart = (from: string): string => {
    for (let d = addDaysISO(from, 1); d < checkOut; d = addDaysISO(d, 1)) {
      if (reachOf(preferred!, d, checkOut)) return d;
    }
    return checkOut;
  };

  // ── Phase 1: segment ───────────────────────────────────────────────────────
  interface Span { sellable: SellableUnit; from: string; to: string }
  const spans: Span[] = [];
  let cursor = checkIn;

  while (cursor < checkOut && spans.length < MAX_SEGMENTS) {
    let best: { sellable: SellableUnit; end: string; moves: number } | null = null;

    const preferredNow = preferred ? reachOf(preferred, cursor, checkOut) : null;
    if (preferred && preferredNow) {
      best = { sellable: preferred, end: preferredNow.end, moves: preferredNow.fit.moves.length };
    } else {
      const bridgeCap = preferred ? nextPreferredStart(cursor) : checkOut;
      for (const sellable of allowed) {
        if (sellable === preferred) continue; // it already said no for tonight
        const candidate = reachOf(sellable, cursor, bridgeCap);
        if (!candidate) continue;
        const better =
          !best ||
          candidate.end > best.end ||
          (candidate.end === best.end &&
            // Prefer continuity (no suitcase), then the least disruption to others.
            (sellable.roomId === spans.at(-1)?.sellable.roomId || candidate.fit.moves.length < best.moves));
        if (better) best = { sellable, end: candidate.end, moves: candidate.fit.moves.length };
      }
    }

    if (!best) {
      return { feasible: false, blockedAt: cursor, holders: holdersOn(all, cursor, today, scopedUnits) };
    }
    spans.push({ sellable: best.sellable, from: cursor, to: best.end });
    cursor = best.end;
  }

  if (cursor < checkOut) {
    return { feasible: false, blockedAt: cursor, holders: holdersOn(all, cursor, today, scopedUnits) };
  }

  // ── Phase 2: merge down to the room-change budget ──────────────────────────
  const maxSegments = opts.maxRoomChanges === undefined ? Infinity : Math.max(1, opts.maxRoomChanges + 1);
  const preferredNights = (list: Span[]) =>
    list
      .filter((sp) => preferred && sp.sellable.roomId === preferred.roomId)
      .reduce((n, sp) => n + nightsBetween(sp.from, sp.to), 0);

  /**
   * Merge the best adjacent pair, or return false if none qualifies.
   * `lossFreeOnly` restricts it to merges that cost no preferred nights — those
   * are pure wins and are applied regardless of any budget, because two
   * consecutive segments one type can absorb is ONE reservation, not two.
   */
  const tryMerge = (lossFreeOnly: boolean): boolean => {
    let bestMerge: { index: number; sellable: SellableUnit; loss: number } | null = null;

    for (let i = 0; i + 1 < spans.length; i++) {
      const from = spans[i].from;
      const to = spans[i + 1].to;
      for (const sellable of allowed) {
        // Availability is invariant under shuffles, so testing against the
        // untouched state is safe here — phase 3 re-derives the actual moves.
        if (!fitFor(sellable, from, to)) continue;
        const before = preferredNights([spans[i], spans[i + 1]]);
        const after = preferred && sellable.roomId === preferred.roomId ? nightsBetween(from, to) : 0;
        const loss = before - after;
        if (lossFreeOnly && loss > 0) continue;
        const better =
          !bestMerge ||
          loss < bestMerge.loss ||
          // Same cost: prefer keeping the guest in the type they asked for.
          (loss === bestMerge.loss && !!preferred && sellable.roomId === preferred.roomId);
        if (better) bestMerge = { index: i, sellable, loss };
      }
    }

    if (!bestMerge) return false;
    spans.splice(bestMerge.index, 2, {
      sellable: bestMerge.sellable,
      from: spans[bestMerge.index].from,
      to: spans[bestMerge.index + 1].to,
    });
    return true;
  };

  while (tryMerge(true)) { /* collapse everything that costs nothing */ }
  // Then buy the remaining reduction with preferred nights, cheapest first, and
  // collapse again — a paid merge can leave two same-type segments adjacent.
  while (spans.length > maxSegments && tryMerge(false)) {
    while (tryMerge(true)) { /* keep it tidy */ }
  }

  // ── Phase 3: place, threading state through the moves ──────────────────────
  const segments: StaySegment[] = [];
  for (const span of spans) {
    const fit = fitFor(span.sellable, span.from, span.to);
    if (!fit) {
      // Phase 1 said this was hostable; if placement disagrees, report honestly
      // rather than emitting a segment with no room.
      return { feasible: false, blockedAt: span.from, holders: holdersOn(all, span.from, today, scopedUnits) };
    }

    // Commit the moves so the NEXT segment plans from the resulting arrangement.
    if (fit.moves.length > 0 && span.sellable.group) {
      const inputs = inputsByGroup.get(span.sellable.label)!;
      for (const move of fit.moves) {
        const target = inputs.find((i) => i.reservationNumber === move.reservationNumber);
        if (target) target.currentRoom = move.to;
      }
    }
    // The request itself now holds this unit for these nights, so a later
    // segment cannot be handed the same unit-nights.
    spansByUnit.get(fit.room)?.push({ from: span.from, to: span.to });
    if (span.sellable.group) {
      inputsByGroup.get(span.sellable.label)!.push({
        reservationNumber: `${REQUEST_ID}-${span.from}`,
        checkIn: span.from,
        checkOut: span.to,
        currentRoom: fit.room,
        movable: false,
        label: "REQUEST",
      });
    }

    segments.push({
      from: span.from,
      to: span.to,
      nights: nightsBetween(span.from, span.to),
      sellableRoomId: span.sellable.roomId,
      sellableLabel: span.sellable.label,
      room: fit.room,
      moves: fit.moves,
      escalated: fit.escalated,
    });
  }

  return { feasible: true, segments, totalNights };
}
