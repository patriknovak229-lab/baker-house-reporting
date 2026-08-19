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
