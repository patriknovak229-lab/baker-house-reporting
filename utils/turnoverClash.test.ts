import { describe, it, expect } from "vitest";
import { computeTurnoverClashes } from "./turnoverClash";
import type { Reservation } from "@/types/reservation";

const TODAY = "2026-08-01";

function mk(over: Partial<Reservation>): Reservation {
  return {
    reservationNumber: "BH-x",
    room: "K.102",
    checkInDate: "2026-08-10",
    checkOutDate: "2026-08-12",
    rateType: "Flexi",
    reservationDate: "2026-08-01",
    firstName: "Guest",
    lastName: "X",
    ...over,
  } as unknown as Reservation;
}

// Back-to-back same room on 2026-08-10, both Flexi (early + late).
const out = mk({ reservationNumber: "BH-1", room: "K.102", checkInDate: "2026-08-08", checkOutDate: "2026-08-10", rateType: "Flexi" });
const inc = mk({ reservationNumber: "BH-2", room: "K.102", checkInDate: "2026-08-10", checkOutDate: "2026-08-12", rateType: "Flexi" });

describe("computeTurnoverClashes", () => {
  it("flags a same-day late-out + early-in clash in one room", () => {
    const clashes = computeTurnoverClashes([out, inc], TODAY);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]).toMatchObject({ date: "2026-08-10", room: "K.102" });
    expect(clashes[0].outgoing.reservationNumber).toBe("BH-1");
    expect(clashes[0].incoming.reservationNumber).toBe("BH-2");
  });

  it("suggests moving the incoming to a free like-for-like room", () => {
    const [c] = computeTurnoverClashes([out, inc], TODAY);
    expect(c.suggestion).toMatchObject({ who: "incoming", toRoom: "K.103" });
  });

  it("no clash when the turnover is not same-day (buffer exists)", () => {
    const later = mk({ ...inc, reservationNumber: "BH-2", checkInDate: "2026-08-11" });
    expect(computeTurnoverClashes([out, later], TODAY)).toHaveLength(0);
  });

  it("no clash when the rate grants no perks (Non-Refundable)", () => {
    const a = mk({ reservationNumber: "BH-1", checkInDate: "2026-08-08", checkOutDate: "2026-08-10", rateType: "Non-Refundable" });
    const b = mk({ reservationNumber: "BH-2", checkInDate: "2026-08-10", checkOutDate: "2026-08-12", rateType: "Non-Refundable" });
    expect(computeTurnoverClashes([a, b], TODAY)).toHaveLength(0);
  });

  it("respects the Standard perk date-gate on the outgoing stay", () => {
    // Standard booked BEFORE the change keeps late checkout → clashes with an early-in Flexi.
    const oldStd = mk({ reservationNumber: "BH-1", checkInDate: "2026-08-08", checkOutDate: "2026-08-10", rateType: "Standard", reservationDate: "2026-01-01" });
    expect(computeTurnoverClashes([oldStd, inc], TODAY)).toHaveLength(1);
    // Standard booked AFTER the change grants early check-in (no late checkout) → no clash as outgoing.
    const newStd = mk({ ...oldStd, reservationDate: "2026-07-30" });
    expect(computeTurnoverClashes([newStd, inc], TODAY)).toHaveLength(0);
  });

  it("respects an operator override that removes the incoming's early check-in", () => {
    const incNoEarly = mk({ ...inc, perkOverrides: { earlyCheckIn: false } });
    expect(computeTurnoverClashes([out, incNoEarly], TODAY)).toHaveLength(0);
  });

  it("gives no suggestion for a unique room type (K.201, no sibling)", () => {
    const a = mk({ reservationNumber: "BH-1", room: "K.201", checkInDate: "2026-08-08", checkOutDate: "2026-08-10" });
    const b = mk({ reservationNumber: "BH-2", room: "K.201", checkInDate: "2026-08-10", checkOutDate: "2026-08-12" });
    const [c] = computeTurnoverClashes([a, b], TODAY);
    expect(c.suggestion).toBeNull();
  });

  it("gives no suggestion when every like-for-like room is occupied", () => {
    // Both siblings (K.103, K.106) blocked across both stays' dates.
    const block103 = mk({ reservationNumber: "BH-9", room: "K.103", checkInDate: "2026-08-07", checkOutDate: "2026-08-13" });
    const block106 = mk({ reservationNumber: "BH-10", room: "K.106", checkInDate: "2026-08-07", checkOutDate: "2026-08-13" });
    const [c] = computeTurnoverClashes([out, inc, block103, block106], TODAY);
    expect(c.suggestion).toBeNull();
  });

  it("ignores past turnovers", () => {
    const pastOut = mk({ ...out, checkInDate: "2026-07-20", checkOutDate: "2026-07-22" });
    const pastInc = mk({ ...inc, checkInDate: "2026-07-22", checkOutDate: "2026-07-24" });
    expect(computeTurnoverClashes([pastOut, pastInc], TODAY)).toHaveLength(0);
  });
});
