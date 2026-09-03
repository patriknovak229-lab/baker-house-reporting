import { describe, it, expect } from "vitest";
import { planStayRequest, nightsBetween, SELLABLE_UNITS } from "./stayRequest";
import type { ResRef } from "./roomAllocation";

const TODAY = "2026-08-19";

function stay(over: Partial<ResRef> & { reservationNumber: string; room: string }): ResRef {
  return { checkInDate: "2026-09-01", checkOutDate: "2026-09-05", ...over };
}

/** Every night of the request is covered exactly once, in order, no gaps. */
function coversSpan(segments: { from: string; to: string }[], from: string, to: string): boolean {
  if (segments.length === 0) return false;
  if (segments[0].from !== from || segments.at(-1)!.to !== to) return false;
  return segments.every((s, i) => i === 0 || s.from === segments[i - 1].to);
}

describe("planStayRequest", () => {
  it("sells a whole month in one unit when the house is empty — no segments, no moves", () => {
    const plan = planStayRequest([], "2026-09-01", "2026-10-01", TODAY);

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].moves).toHaveLength(0);
    expect(plan.totalNights).toBe(30);
    expect(coversSpan(plan.segments, "2026-09-01", "2026-10-01")).toBe(true);
  });

  it("reports the blocking night with every holder when one night is fully sold", () => {
    // Every unit taken on the night of 2026-09-03 → no itinerary can span it.
    const all: ResRef[] = [
      stay({ reservationNumber: "A", room: "K.102", checkInDate: "2026-09-03", checkOutDate: "2026-09-04", firstName: "Ann", lastName: "A" }),
      stay({ reservationNumber: "B", room: "K.103", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "C", room: "K.106", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "D", room: "K.202", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "E", room: "K.203", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "F", room: "K.201", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "G", room: "O.308", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
    ];
    const plan = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY);

    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    expect(plan.blockedAt).toBe("2026-09-03");
    expect(plan.holders).toHaveLength(7);
    expect(plan.holders.every((h) => h.who !== null)).toBe(true);
    expect(plan.holders.find((h) => h.room === "K.102")?.who).toBe("Ann A");
  });

  it("keeps the guest in one room by shuffling other guests, instead of splitting the stay", () => {
    // K.202 holds a stay mid-request and K.203 is free throughout: moving that
    // one booking one unit over buys a single uninterrupted reservation.
    const all: ResRef[] = [
      stay({ reservationNumber: "MID", room: "K.202", checkInDate: "2026-09-10", checkOutDate: "2026-09-13", firstName: "Mid", lastName: "Guest" }),
    ];
    const plan = planStayRequest(all, "2026-09-01", "2026-09-20", TODAY);

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    // One Deluxe unit is free all along, so no shuffle is even needed here.
    expect(plan.segments).toHaveLength(1);
  });

  it("splits into the fewest segments when no single type spans the request", () => {
    // Deluxe blocked in the second half, Urban blocked in the first half:
    // exactly two segments, and the whole span is still covered.
    const all: ResRef[] = [
      stay({ reservationNumber: "U1", room: "K.102", checkInDate: "2026-09-01", checkOutDate: "2026-09-06" }),
      stay({ reservationNumber: "U2", room: "K.103", checkInDate: "2026-09-01", checkOutDate: "2026-09-06" }),
      stay({ reservationNumber: "U3", room: "K.106", checkInDate: "2026-09-01", checkOutDate: "2026-09-06" }),
      stay({ reservationNumber: "D1", room: "K.202", checkInDate: "2026-09-06", checkOutDate: "2026-09-11" }),
      stay({ reservationNumber: "D2", room: "K.203", checkInDate: "2026-09-06", checkOutDate: "2026-09-11" }),
      stay({ reservationNumber: "S1", room: "K.201", checkInDate: "2026-09-01", checkOutDate: "2026-09-11" }),
      stay({ reservationNumber: "S2", room: "O.308", checkInDate: "2026-09-01", checkOutDate: "2026-09-11" }),
    ];
    const plan = planStayRequest(all, "2026-09-01", "2026-09-11", TODAY);

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.segments).toHaveLength(2);
    expect(plan.segments[0].sellableLabel).toBe("1KK Deluxe Studios");
    expect(plan.segments[1].sellableLabel).toBe("1KK Urban Studios");
    expect(coversSpan(plan.segments, "2026-09-01", "2026-09-11")).toBe(true);
  });

  it("ignores cancelled bookings — a cancelled ghost must not block a request", () => {
    // The Aug-3 trap: cancellations linger in the reservations array and the
    // calendar hides them, so counting them invents occupancy that isn't there.
    const cancelledEverywhere: ResRef[] = ["K.102", "K.103", "K.106", "K.202", "K.203", "K.201", "O.308"].map(
      (room, i) =>
        stay({
          reservationNumber: `X${i}`,
          room,
          checkInDate: "2026-09-01",
          checkOutDate: "2026-09-30",
          isCancelled: true,
        }),
    );
    const plan = planStayRequest(cancelledEverywhere, "2026-09-01", "2026-09-15", TODAY);

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.segments).toHaveLength(1);
  });

  it("never moves an in-house guest, and says so by blocking instead", () => {
    // All 7 units held by guests who have ALREADY ARRIVED. No shuffle can free
    // a night, so the request must fail rather than promise the impossible.
    const all: ResRef[] = ["K.102", "K.103", "K.106", "K.202", "K.203", "K.201", "O.308"].map((room, i) =>
      stay({ reservationNumber: `IH${i}`, room, checkInDate: "2026-08-15", checkOutDate: "2026-08-25" }),
    );
    const plan = planStayRequest(all, "2026-08-20", "2026-08-24", TODAY);

    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    expect(plan.blockedAt).toBe("2026-08-20");
    expect(plan.holders.every((h) => h.inHouse)).toBe(true);
  });

  it("blackouts hold their unit — they are never shuffled aside for a request", () => {
    const all: ResRef[] = ["K.102", "K.103", "K.106", "K.202", "K.203", "K.201", "O.308"].map((room, i) =>
      stay({
        reservationNumber: `OV-${i}`,
        room,
        checkInDate: "2026-09-01",
        checkOutDate: "2026-09-05",
        isBlackout: true,
      }),
    );
    const plan = planStayRequest(all, "2026-09-01", "2026-09-05", TODAY);

    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    expect(plan.holders.every((h) => h.who === "BLACKOUT")).toBe(true);
  });

  it("shuffling buys ONE reservation where refusing to shuffle costs the guest a move", () => {
    // Deluxe: K.203 busy 01–05, K.202 busy 05–07. Every night has a free unit,
    // but neither unit is free throughout — the canonical reshuffle shape. All
    // other types are fully booked, so Deluxe is the only candidate.
    const all: ResRef[] = [
      stay({ reservationNumber: "M1", room: "K.203", checkInDate: "2026-09-01", checkOutDate: "2026-09-05" }),
      stay({ reservationNumber: "M2", room: "K.202", checkInDate: "2026-09-05", checkOutDate: "2026-09-07" }),
      stay({ reservationNumber: "M3", room: "K.102", checkInDate: "2026-09-01", checkOutDate: "2026-09-20" }),
      stay({ reservationNumber: "M4", room: "K.103", checkInDate: "2026-09-01", checkOutDate: "2026-09-20" }),
      stay({ reservationNumber: "M5", room: "K.106", checkInDate: "2026-09-01", checkOutDate: "2026-09-20" }),
      stay({ reservationNumber: "M6", room: "K.201", checkInDate: "2026-09-01", checkOutDate: "2026-09-20" }),
      stay({ reservationNumber: "M7", room: "O.308", checkInDate: "2026-09-01", checkOutDate: "2026-09-20" }),
    ];

    const shuffled = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY);
    expect(shuffled.feasible).toBe(true);
    if (!shuffled.feasible) return;
    expect(shuffled.segments).toHaveLength(1); // one reservation, one room
    expect(shuffled.segments[0].moves).toHaveLength(1); // someone else moves once

    const noShuffle = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY, { allowShuffle: false });
    expect(noShuffle.feasible).toBe(true);
    if (!noShuffle.feasible) return;
    expect(noShuffle.segments).toHaveLength(2); // guest packs a suitcase instead
    expect(noShuffle.segments.every((s) => s.moves.length === 0)).toBe(true);
    expect(coversSpan(noShuffle.segments, "2026-09-01", "2026-09-10")).toBe(true);
  });

  it("places the request into the free unit of a partly-booked type", () => {
    const all: ResRef[] = [
      stay({ reservationNumber: "P1", room: "K.202", checkInDate: "2026-09-01", checkOutDate: "2026-09-10" }),
    ];
    const plan = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY);

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.segments).toHaveLength(1);
    expect(plan.segments[0].room).not.toBe("K.202");
  });

  it("restricts the offer to the selected types, and blames only their units", () => {
    // Urban's three studios are all taken on 2026-09-03 by different guests —
    // the real Sept case. Deluxe is wide open, so unrestricted this is trivially
    // possible; restricted to Urban it must fail, because a shuffle rearranges
    // which unit a guest holds and cannot conjure a fourth studio.
    const all: ResRef[] = [
      stay({ reservationNumber: "U1", room: "K.102", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "U2", room: "K.103", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "U3", room: "K.106", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;

    const anyType = planStayRequest(all, "2026-09-01", "2026-09-06", TODAY);
    expect(anyType.feasible).toBe(true);

    const urbanOnly = planStayRequest(all, "2026-09-01", "2026-09-06", TODAY, { allowedRoomIds: [URBAN] });
    expect(urbanOnly.feasible).toBe(false);
    if (urbanOnly.feasible) return;
    expect(urbanOnly.blockedAt).toBe("2026-09-03");
    // Only Urban units are named — Deluxe was never on offer.
    expect(urbanOnly.holders.map((h) => h.room).sort()).toEqual(["K.102", "K.103", "K.106"]);
  });

  it("nothing selected means nothing to offer", () => {
    expect(planStayRequest([], "2026-09-01", "2026-09-10", TODAY, { allowedRoomIds: [] }).feasible).toBe(false);
  });

  it("preferred type wins the nights it can take, and bridges the ones it can't", () => {
    // Urban full on 2026-09-03 only. Preferring Urban should buy Urban for
    // 01–03 and 04–08, with a single bridging night in another type — instead of
    // the fewest-segments answer, which would put the whole stay in Deluxe.
    const all: ResRef[] = [
      stay({ reservationNumber: "U1", room: "K.102", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "U2", room: "K.103", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "U3", room: "K.106", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;

    const fewest = planStayRequest(all, "2026-09-01", "2026-09-08", TODAY);
    expect(fewest.feasible).toBe(true);
    if (!fewest.feasible) return;
    expect(fewest.segments).toHaveLength(1); // one type spans it → no Urban at all
    expect(fewest.segments[0].sellableRoomId).not.toBe(URBAN);

    const preferUrban = planStayRequest(all, "2026-09-01", "2026-09-08", TODAY, { preferredRoomId: URBAN });
    expect(preferUrban.feasible).toBe(true);
    if (!preferUrban.feasible) return;
    expect(preferUrban.segments).toHaveLength(3);
    expect(coversSpan(preferUrban.segments, "2026-09-01", "2026-09-08")).toBe(true);
    // The bridge is exactly the one night Urban could not take.
    const bridge = preferUrban.segments.filter((s) => s.sellableRoomId !== URBAN);
    expect(bridge).toHaveLength(1);
    expect(bridge[0].from).toBe("2026-09-03");
    expect(bridge[0].nights).toBe(1);
    // Everything else is the preferred type: 6 of 7 nights.
    const urbanNights = preferUrban.segments
      .filter((s) => s.sellableRoomId === URBAN)
      .reduce((n, s) => n + s.nights, 0);
    expect(urbanNights).toBe(6);
  });

  it("preference cannot rescue a night no allowed type can cover", () => {
    // Urban full on the 3rd and Deluxe full for the whole span, standalones too.
    const all: ResRef[] = [
      ...["K.102", "K.103", "K.106"].map((room, i) =>
        stay({ reservationNumber: `U${i}`, room, checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      ),
      ...["K.202", "K.203", "K.201", "O.308"].map((room, i) =>
        stay({ reservationNumber: `D${i}`, room, checkInDate: "2026-09-01", checkOutDate: "2026-09-08" }),
      ),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;
    const plan = planStayRequest(all, "2026-09-01", "2026-09-08", TODAY, { preferredRoomId: URBAN });

    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    expect(plan.blockedAt).toBe("2026-09-03");
  });

  it("maxRoomChanges merges segments back, trading preferred nights for fewer moves", () => {
    // Urban full on the 3rd and the 6th, Deluxe wide open. Preferring Urban
    // wants Urban-bridge-Urban-bridge-Urban (5 segments); a 1-change budget must
    // collapse that to 2, and every night must still be covered exactly once.
    const all: ResRef[] = [
      ...["K.102", "K.103", "K.106"].flatMap((room, i) => [
        stay({ reservationNumber: `A${i}`, room, checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
        stay({ reservationNumber: `B${i}`, room, checkInDate: "2026-09-06", checkOutDate: "2026-09-07" }),
      ]),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;

    const greedy = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY, { preferredRoomId: URBAN });
    expect(greedy.feasible).toBe(true);
    if (!greedy.feasible) return;
    expect(greedy.segments.length).toBeGreaterThan(2);

    const capped = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY, {
      preferredRoomId: URBAN,
      maxRoomChanges: 1,
    });
    expect(capped.feasible).toBe(true);
    if (!capped.feasible) return;
    expect(capped.segments).toHaveLength(2);
    expect(coversSpan(capped.segments, "2026-09-01", "2026-09-10")).toBe(true);

    // The budget costs preferred nights — that is the trade, and it must be real.
    const nightsIn = (p: typeof capped) =>
      p.feasible ? p.segments.filter((s) => s.sellableRoomId === URBAN).reduce((n, s) => n + s.nights, 0) : 0;
    expect(nightsIn(capped)).toBeLessThan(nightsIn(greedy));

    // A zero-change budget means one reservation or nothing.
    const single = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY, {
      preferredRoomId: URBAN,
      maxRoomChanges: 0,
    });
    expect(single.feasible).toBe(true);
    if (!single.feasible) return;
    expect(single.segments).toHaveLength(1);
    expect(single.segments[0].sellableRoomId).not.toBe(URBAN); // Urban can't span it
  });

  it("never emits two consecutive segments one type could hold as one reservation", () => {
    // A split that costs nothing is not a split: consecutive nights in the same
    // type are one booking, so the itinerary must never show them separately.
    const all: ResRef[] = [
      ...["K.102", "K.103", "K.106"].flatMap((room, i) => [
        stay({ reservationNumber: `A${i}`, room, checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
        stay({ reservationNumber: `B${i}`, room, checkInDate: "2026-09-06", checkOutDate: "2026-09-07" }),
      ]),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;

    for (const maxRoomChanges of [0, 1, 2, 3, undefined]) {
      const plan = planStayRequest(all, "2026-09-01", "2026-09-10", TODAY, { preferredRoomId: URBAN, maxRoomChanges });
      expect(plan.feasible).toBe(true);
      if (!plan.feasible) return;
      const adjacentSameType = plan.segments.some(
        (s, i) => i > 0 && plan.segments[i - 1].sellableRoomId === s.sellableRoomId,
      );
      expect(adjacentSameType).toBe(false);
    }
  });

  it("never moves the same guest twice from the same unit (segments thread state)", () => {
    // Two Urban-blocking nights force Urban→bridge→Urban→bridge→Urban, and the
    // long-staying movable guests get shuffled in more than one segment. Each
    // move must start from where the PREVIOUS segment left the guest, or the
    // itinerary is not executable.
    const all: ResRef[] = [
      // Long movable Urban stays that overlap several segments.
      stay({ reservationNumber: "LONG1", room: "K.102", checkInDate: "2026-09-02", checkOutDate: "2026-09-09", firstName: "Long", lastName: "One" }),
      stay({ reservationNumber: "LONG2", room: "K.103", checkInDate: "2026-09-02", checkOutDate: "2026-09-09", firstName: "Long", lastName: "Two" }),
      // The nights that push the guest out of Urban entirely.
      stay({ reservationNumber: "FULL1", room: "K.106", checkInDate: "2026-09-03", checkOutDate: "2026-09-04" }),
      stay({ reservationNumber: "FULL2", room: "K.106", checkInDate: "2026-09-06", checkOutDate: "2026-09-07" }),
    ];
    const URBAN = SELLABLE_UNITS.find((s) => s.label === "1KK Urban Studios")!.roomId;
    const plan = planStayRequest(all, "2026-09-01", "2026-09-09", TODAY, { preferredRoomId: URBAN });

    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;

    // Replay every move in order: each one must depart from the guest's current
    // unit, which is what makes the list executable top to bottom.
    const whereIs = new Map<string, string>([
      ["LONG1", "K.102"],
      ["LONG2", "K.103"],
    ]);
    for (const seg of plan.segments) {
      for (const move of seg.moves) {
        const known = whereIs.get(move.reservationNumber);
        if (known !== undefined) expect(move.from).toBe(known);
        whereIs.set(move.reservationNumber, move.to);
      }
    }

    // And no segment may be handed a unit the guest already occupies elsewhere
    // in the itinerary at the same time (segments are disjoint, so this is about
    // the request's own footprint being respected).
    const perRoom = new Map<string, { from: string; to: string }[]>();
    for (const seg of plan.segments) {
      const list = perRoom.get(seg.room) ?? [];
      for (const other of list) expect(seg.from < other.to && other.from < seg.to).toBe(false);
      list.push({ from: seg.from, to: seg.to });
      perRoom.set(seg.room, list);
    }
  });

  it("rejects a zero-night or inverted request", () => {
    expect(planStayRequest([], "2026-09-05", "2026-09-05", TODAY).feasible).toBe(false);
    expect(planStayRequest([], "2026-09-05", "2026-09-01", TODAY).feasible).toBe(false);
  });
});

describe("sellable inventory", () => {
  it("covers all 7 physical units across 4 bookable types", () => {
    expect(SELLABLE_UNITS).toHaveLength(4);
    expect(SELLABLE_UNITS.flatMap((s) => s.units).sort()).toEqual(
      ["K.102", "K.103", "K.106", "K.201", "K.202", "K.203", "O.308"].sort(),
    );
    // Only the multi-unit types can absorb a shuffle.
    expect(SELLABLE_UNITS.filter((s) => s.group).map((s) => s.label)).toEqual([
      "1KK Urban Studios",
      "1KK Deluxe Studios",
    ]);
  });
});

describe("nightsBetween", () => {
  it("counts nights, not days, and survives a DST boundary", () => {
    expect(nightsBetween("2026-09-01", "2026-09-02")).toBe(1);
    expect(nightsBetween("2026-10-24", "2026-10-27")).toBe(3); // CEST → CET
    expect(nightsBetween("2026-09-05", "2026-09-05")).toBe(0);
  });
});
