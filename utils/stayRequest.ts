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
  /**
   * Guests ONE unit of this type sleeps — the Beds24 `maxPeople`, matching the
   * public site's "7 apartments · 18 guests". Without it the planner quoted a
   * two-person studio to a family of four and Beds24 then refused to price it,
   * which reads as a pricing fault rather than the capacity fault it is.
   */
  sleeps: number;
}

/**
 * Guests each shuffle group's units sleep. Kept here rather than in
 * `ALLOCATION_GROUPS` because capacity is a SELLING fact (what a guest may
 * book), not an allocation one — the resolver never needs it. A new group
 * added without an entry here is treated as a two-person unit, which errs the
 * safe way: it under-sells rather than over-fills.
 */
const GROUP_SLEEPS: Record<string, number> = {
  "1KK Urban Studios": 2,
  "1KK Deluxe Studios": 2,
};

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
    sleeps: GROUP_SLEEPS[g.typeLabel] ?? 2,
  })),
  { roomId: 656437, label: "K.201 — 2KK Deluxe", units: ["K.201"], group: null, sleeps: 4 },
  { roomId: 674672, label: "O.308 — 2 Bedroom", units: ["O.308"], group: null, sleeps: 4 },
];

/** One reservation-to-be: a run of nights in one sellable type. */
export interface StaySegment {
  from: string; // YYYY-MM-DD first night
  to: string; // YYYY-MM-DD departure (exclusive)
  nights: number;
  /**
   * Which apartment of the party this belongs to (0-based). A party split
   * across two apartments produces two PARALLEL itineraries covering the same
   * nights — so segments are no longer one timeline, and anything walking them
   * (coverage, room changes, pricing) must group by this first.
   */
  apartment: number;
  /** Guests sleeping in this apartment — what Beds24 must price it for. */
  guests: number;
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
  | {
      feasible: true;
      segments: StaySegment[];
      /** Nights of the STAY — not room-nights, which two apartments double. */
      totalNights: number;
      /** How many apartments the party occupies at once. 1 = the usual case. */
      apartments: number;
      /** Guests per apartment, largest first. Indexed by `StaySegment.apartment`. */
      partySizes: number[];
    }
  | {
      feasible: false;
      blockedAt: string;
      holders: BlockingHolder[];
      /**
       * Set when the request fails for a reason the holders table cannot show
       * — nobody is in the way, the party simply does not fit what is on
       * offer. Without it a capacity failure renders as "blocked" over a list
       * of rooms that are all free.
       */
      reason?: string;
    };

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
    // A guest holding several apartments contributes one row per unit, each
    // movable on its own — swapping one apartment within the same room type is
    // invisible to that guest. The legs share dates, so the solver's
    // no-double-booking rule already keeps them in different units.
    const movable = !inHouse && !r.isBlackout;

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

/** The whole house at once — the ceiling on a party split, not a target. */
export const MAX_APARTMENTS = PHYSICAL_ROOMS.length;

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
   * the fewest preferred nights per merge. Undefined = no cap. Applied PER
   * APARTMENT: it caps how often a guest packs, and a guest only ever packs
   * within their own apartment's itinerary.
   */
  maxRoomChanges?: number;
  /**
   * Party size (adults + children). Undefined or 0 = unknown, and no capacity
   * rule applies at all — the pre-capacity behaviour, kept so callers that only
   * ask "are these dates free?" are unaffected. With a number, a type is
   * offered to an apartment only if it can actually sleep that apartment's
   * share of the party.
   */
  guests?: number;
  /**
   * How many apartments the party may occupy AT ONCE. 1 (the default) is the
   * single-apartment planner: one guest, one key, one itinerary. Above 1, a
   * party too large for any single apartment — four guests when both 4-sleepers
   * are taken, say — can still be housed, as several simultaneous reservations
   * of smaller units. Fewest apartments always wins, so raising this permits a
   * split, it never forces one.
   */
  maxApartments?: number;
}

/** Outcome of planning ONE arrangement (one fixed guests-per-apartment split). */
type PartyAttempt =
  | { ok: true; segments: StaySegment[] }
  | { ok: false; blockedAt: string; holders: BlockingHolder[]; reason?: string };

/**
 * Split `guests` across exactly `k` apartments, spending as few LARGE
 * apartments as possible. A party of four goes [2, 2] — two studios, of which
 * the house has five — rather than [3, 1], which would burn one of the only
 * two 4-sleepers and leave the next family of four with nowhere to go.
 *
 * `unitCaps` is every offered unit's capacity, ascending: the real inventory
 * ([2,2,2,2,2,4,4]), not an abstract small/large pair. Sizing against a pair
 * happily proposed three 4-sleepers for a party of nineteen — arithmetically
 * sound, but the house owns two, so the plan died later as a confusing
 * "blocked" over rooms that were free.
 *
 * Sizes come back largest-first: the biggest sub-party is the hardest to
 * place, so it should claim its unit before the others compete for one.
 *
 * Returns null when k apartments cannot seat the party — too few beds, fewer
 * units than apartments, or more apartments than guests (an apartment with
 * nobody in it is not a plan).
 *
 * `guests` of 0 means "unknown", which is not a size problem — the single
 * apartment asks for 0 beds and the capacity filter lets everything through.
 */
function guestSplit(guests: number, k: number, unitCaps: number[]): number[] | null {
  if (guests <= 0) return k === 1 ? [0] : null;
  if (k > guests || k > unitCaps.length) return null;

  // Start on the k smallest units, then trade the smallest one held for the
  // largest one free until the party fits. That lands on the cheapest set of
  // units that seats them, and says null exactly when no set does.
  const caps = unitCaps.slice(0, k);
  const spare = unitCaps.slice(k); // ascending, so the best swap is the last
  let total = caps.reduce((a, b) => a + b, 0);
  while (total < guests && spare.length > 0) {
    const bigger = spare.pop()!;
    if (bigger <= caps[0]) return null; // nothing left that would help
    total += bigger - caps[0];
    caps[0] = bigger;
    caps.sort((a, b) => a - b);
  }
  if (total < guests) return null;

  // One guest each, then fill the SMALL apartments before the large ones, so a
  // large apartment only ever holds the overflow that nothing else can take.
  const sizes = caps.map(() => 1);
  let left = guests - k;
  for (let i = 0; i < caps.length && left > 0; i++) {
    const add = Math.min(caps[i] - 1, left);
    sizes[i] += add;
    left -= add;
  }
  if (left > 0) return null;

  return sizes.sort((a, b) => b - a);
}

/**
 * Plan one arrangement: `sizes[i]` guests in apartment i, all over the same
 * dates.
 *
 * Apartments are planned in order against ONE threaded state, exactly as the
 * segments within an apartment already were — apartment 1 sees apartment 0's
 * unit-nights as taken, and cannot be handed them. Planning both against the
 * untouched world is how you get a plan that puts two halves of the same party
 * in the same studio.
 */
function planParty(
  all: ResRef[],
  checkIn: string,
  checkOut: string,
  today: string,
  opts: PlanStayOptions,
  sizes: number[],
): PartyAttempt {
  const allowShuffle = opts.allowShuffle !== false;
  const offered = opts.allowedRoomIds
    ? SELLABLE_UNITS.filter((s) => opts.allowedRoomIds!.includes(s.roomId))
    : SELLABLE_UNITS;
  /** Only units of the offered types — a blocking report must not blame a room the operator excluded. */
  const scopedUnits = offered.flatMap((s) => s.units);

  // Mutable throughout — every placement is committed before the next segment,
  // and before the next apartment, is planned.
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

  const segments: StaySegment[] = [];

  for (let apartment = 0; apartment < sizes.length; apartment++) {
    const seats = sizes[apartment];
    /** Types big enough for THIS apartment's share of the party. */
    const allowed = offered.filter((s) => s.sleeps >= seats);
    if (allowed.length === 0) {
      return {
        ok: false,
        blockedAt: checkIn,
        holders: [],
        reason: `No offered apartment sleeps ${seats} guest${seats === 1 ? "" : "s"}.`,
      };
    }

    const preferred = allowed.find((s) => s.roomId === opts.preferredRoomId) ?? null;

    /** First night after `from` that the preferred type can take. */
    const nextPreferredStart = (from: string): string => {
      for (let d = addDaysISO(from, 1); d < checkOut; d = addDaysISO(d, 1)) {
        if (reachOf(preferred!, d, checkOut)) return d;
      }
      return checkOut;
    };

    // ── Phase 1: segment ─────────────────────────────────────────────────────
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
        return { ok: false, blockedAt: cursor, holders: holdersOn(all, cursor, today, scopedUnits) };
      }
      spans.push({ sellable: best.sellable, from: cursor, to: best.end });
      cursor = best.end;
    }

    if (cursor < checkOut) {
      return { ok: false, blockedAt: cursor, holders: holdersOn(all, cursor, today, scopedUnits) };
    }

    // ── Phase 2: merge down to the room-change budget ────────────────────────
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
          // state as it stands is safe here — phase 3 re-derives the actual moves.
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

    // ── Phase 3: place, threading state through the moves ────────────────────
    for (const span of spans) {
      const fit = fitFor(span.sellable, span.from, span.to);
      if (!fit) {
        // Phase 1 said this was hostable; if placement disagrees, report honestly
        // rather than emitting a segment with no room.
        return { ok: false, blockedAt: span.from, holders: holdersOn(all, span.from, today, scopedUnits) };
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
      // segment — or a later APARTMENT of the same party — cannot be handed the
      // same unit-nights. The id carries the apartment because two apartments
      // routinely start a segment on the same date in the same group, and two
      // solver inputs sharing an id collapse into one.
      spansByUnit.get(fit.room)?.push({ from: span.from, to: span.to });
      if (span.sellable.group) {
        inputsByGroup.get(span.sellable.label)!.push({
          reservationNumber: `${REQUEST_ID}-${apartment}-${span.from}`,
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
        apartment,
        guests: seats,
        sellableRoomId: span.sellable.roomId,
        sellableLabel: span.sellable.label,
        room: fit.room,
        moves: fit.moves,
        escalated: fit.escalated,
      });
    }
  }

  return { ok: true, segments };
}

/**
 * Plan the arrangement covering [checkIn, checkOut) for the whole party.
 *
 * Tries one apartment first and only widens the split if that fails, so a
 * raised `maxApartments` permits two keys, it never prefers them: one
 * reservation the guest doesn't have to coordinate beats two cheaper ones.
 *
 * Each candidate split is planned by `planParty`, which handles the itinerary
 * within (and across) apartments. When every split fails, the failure worth
 * showing is the one that got FURTHEST into the stay — the arrangement that
 * nearly worked tells the operator which night to go and fix.
 */
export function planStayRequest(
  all: ResRef[],
  checkIn: string,
  checkOut: string,
  today: string,
  opts: PlanStayOptions = {},
): StayRequestPlan {
  const totalNights = nightsBetween(checkIn, checkOut);
  if (totalNights <= 0) return { feasible: false, blockedAt: checkIn, holders: [] };

  const offered = opts.allowedRoomIds
    ? SELLABLE_UNITS.filter((s) => opts.allowedRoomIds!.includes(s.roomId))
    : SELLABLE_UNITS;
  if (offered.length === 0) return { feasible: false, blockedAt: checkIn, holders: [] };

  const guests = Math.max(0, Math.floor(opts.guests ?? 0));
  /** Every offered unit's capacity, ascending — one entry per physical unit. */
  const unitCaps = offered
    .flatMap((s) => s.units.map(() => s.sleeps))
    .sort((a, b) => a - b);
  const maxApartments = Math.min(Math.max(1, Math.floor(opts.maxApartments ?? 1)), MAX_APARTMENTS);

  let failure: { blockedAt: string; holders: BlockingHolder[]; reason?: string } | null = null;

  for (let k = 1; k <= maxApartments; k++) {
    const sizes = guestSplit(guests, k, unitCaps);
    if (!sizes) continue; // k apartments can't seat this party — try more

    const attempt = planParty(all, checkIn, checkOut, today, opts, sizes);
    if (attempt.ok) {
      return { feasible: true, segments: attempt.segments, totalNights, apartments: k, partySizes: sizes };
    }

    // Keep whichever split reached the latest night; a capacity refusal at the
    // first night never displaces a real occupancy clash three weeks in.
    const better =
      !failure ||
      attempt.blockedAt > failure.blockedAt ||
      (attempt.blockedAt === failure.blockedAt && attempt.holders.length > failure.holders.length);
    if (better) {
      failure = { blockedAt: attempt.blockedAt, holders: attempt.holders, reason: attempt.reason };
    }
  }

  if (failure) return { feasible: false, ...failure };

  // Every split was rejected before planning even started: there are not enough
  // beds in the offered types, whatever the calendar says.
  const beds = unitCaps.reduce((a, b) => a + b, 0);
  return {
    feasible: false,
    blockedAt: checkIn,
    holders: [],
    reason:
      maxApartments === 1
        ? `No single apartment on offer sleeps ${guests} guests — allow splitting the party across apartments.`
        : `${guests} guests need more beds than the offered types hold (${beds} in total).`,
  };
}


/**
 * Deal the party's adults and children into the apartments a plan produced.
 *
 * Needed because Beds24 prices per booking: ask it for four people in a
 * two-person studio and it returns no offer at all, so a split party quoted at
 * its full size comes back entirely unpriced. `sizes` is the plan's
 * `partySizes`, and the result is indexed by `StaySegment.apartment`.
 *
 * One adult lands in each apartment first — a room of children with no adult
 * is not an arrangement anyone would sell — then adults fill up, then children
 * take the beds left. With fewer adults than apartments that is impossible; one
 * of that apartment's children is then priced as an adult, which is the safe
 * direction to be wrong in (child rates are never the dearer ones, so the quote
 * cannot come out under what the stay really costs).
 */
export function splitPartyForPricing(
  adults: number,
  children: number,
  sizes: number[],
): { adults: number; children: number }[] {
  const per = sizes.map(() => ({ adults: 0, children: 0 }));
  const seatsLeft = (i: number) => sizes[i] - per[i].adults - per[i].children;
  let a = adults;
  let c = children;

  for (let i = 0; i < sizes.length && a > 0; i++) {
    if (sizes[i] > 0) {
      per[i].adults = 1;
      a--;
    }
  }
  for (let i = 0; i < sizes.length && a > 0; i++) {
    const take = Math.min(seatsLeft(i), a);
    per[i].adults += take;
    a -= take;
  }
  for (let i = 0; i < sizes.length && c > 0; i++) {
    const take = Math.min(seatsLeft(i), c);
    per[i].children += take;
    c -= take;
  }

  for (const p of per) {
    if (p.adults === 0 && p.children > 0) {
      p.adults = 1;
      p.children--;
    }
  }
  return per;
}
