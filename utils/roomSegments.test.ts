import { describe, expect, it } from "vitest";
import type { Reservation } from "@/types/reservation";
import {
  attachRoomSegments,
  buildRoomSegments,
  isFinalSegmentPiece,
  isRepeatSegmentPiece,
  moveCleaningsFor,
  occupancySpans,
  splitBySegments,
  type RoomMoveRecord,
} from "./roomSegments";
import { expandLinkedReservations } from "./expandReservations";
import { occupiersByRoom } from "./moveTargets";

function mk(over: Partial<Reservation> = {}): Reservation {
  return {
    reservationNumber: "BH-1",
    room: "K.103",
    checkInDate: "2026-10-01",
    checkOutDate: "2026-10-05",
    numberOfNights: 4,
    price: 10_000,
    commissionAmount: 2_000,
    paymentChargeAmount: 0,
    amountPaid: 10_000,
    firstName: "Justin",
    lastName: "Landrum",
    ...over,
  } as Reservation;
}

const mid = (over: Partial<RoomMoveRecord> = {}): RoomMoveRecord => ({
  reservationNumber: "BH-1",
  fromRoom: "K.106",
  toRoom: "K.103",
  effectiveFrom: "2026-10-03",
  movedAt: "2026-10-03T09:00:00.000Z",
  ...over,
});

describe("buildRoomSegments", () => {
  it("splits at the move date", () => {
    expect(buildRoomSegments(mk(), [mid()])).toEqual([
      { room: "K.106", from: "2026-10-01", to: "2026-10-03", nights: 2, share: 0.5 },
      { room: "K.103", from: "2026-10-03", to: "2026-10-05", nights: 2, share: 0.5 },
    ]);
  });

  it("ignores history that no longer ends in the Beds24 room", () => {
    expect(buildRoomSegments(mk({ room: "K.102" }), [mid()])).toBeNull();
  });

  it("a later whole-stay move supersedes the split", () => {
    const whole = mid({ effectiveFrom: null, fromRoom: "K.103", toRoom: "K.103", movedAt: "2026-10-04T00:00:00.000Z" });
    expect(buildRoomSegments(mk(), [mid(), whole])).toBeNull();
  });

  it("ignores a move date outside the stay (e.g. stay shortened later)", () => {
    expect(buildRoomSegments(mk(), [mid({ effectiveFrom: "2026-10-05" })])).toBeNull();
    expect(buildRoomSegments(mk(), [mid({ effectiveFrom: "2026-10-01" })])).toBeNull();
  });

  it("chains two mid-stay moves", () => {
    const second = mid({ fromRoom: "K.103", toRoom: "K.102", effectiveFrom: "2026-10-04", movedAt: "2026-10-04T09:00:00.000Z" });
    const segs = buildRoomSegments(mk({ room: "K.102" }), [mid(), second])!;
    expect(segs.map((s) => [s.room, s.nights])).toEqual([
      ["K.106", 2],
      ["K.103", 1],
      ["K.102", 1],
    ]);
  });
});

describe("splitBySegments — money pro-rata by nights", () => {
  it("4 nights, 10 000 gross, 2 000 commission, 2+2 → 5 000 / 1 000 each", () => {
    const r = mk({ roomSegments: buildRoomSegments(mk(), [mid()])! });
    const [a, b] = splitBySegments(r);
    expect([a.room, a.price, a.commissionAmount, a.numberOfNights]).toEqual(["K.106", 5_000, 1_000, 2]);
    expect([b.room, b.price, b.commissionAmount, b.numberOfNights]).toEqual(["K.103", 5_000, 1_000, 2]);
  });

  it("uneven shares still add back to the booking exactly", () => {
    const r = mk({ checkOutDate: "2026-10-04", numberOfNights: 3, price: 1_000, commissionAmount: 100 });
    const pieces = splitBySegments({ ...r, roomSegments: buildRoomSegments(r, [mid({ effectiveFrom: "2026-10-02" })])! });
    expect(pieces.map((p) => p.price)).toEqual([333, 667]);
    expect(pieces.reduce((s, p) => s + p.commissionAmount, 0)).toBe(100);
  });

  it("goes through expandLinkedReservations, so every per-apartment view gets it", () => {
    const [r] = attachRoomSegments([mk()], [mid()]);
    expect(expandLinkedReservations([r]).map((p) => p.room)).toEqual(["K.106", "K.103"]);
  });

  it("counts the booking once and puts per-reservation costs on the checkout piece", () => {
    const [r] = attachRoomSegments([mk()], [mid()]);
    const pieces = splitBySegments(r);
    const seen = new Set<string>();
    expect(pieces.filter((p) => !isRepeatSegmentPiece(p, seen))).toHaveLength(1);
    expect(pieces.map(isFinalSegmentPiece)).toEqual([false, true]);
  });
});

describe("occupancy", () => {
  it("the old unit's nights no longer occupy the new unit", () => {
    const [moved] = attachRoomSegments([mk({ checkInDate: "2026-09-28", checkOutDate: "2026-10-18", numberOfNights: 20 })], [
      mid({ effectiveFrom: "2026-10-04" }),
    ]);
    expect(occupancySpans(moved)).toEqual([
      { room: "K.106", from: "2026-09-28", to: "2026-10-04" },
      { room: "K.103", from: "2026-10-04", to: "2026-10-18" },
    ]);
    // Someone looking to move into K.103 for 27 Sep–3 Oct sees it free.
    const probe = { reservationNumber: "BH-2", checkInDate: "2026-09-27", checkOutDate: "2026-10-03" };
    expect(occupiersByRoom(probe, [moved]).has("K.103")).toBe(false);
    expect(occupiersByRoom(probe, [moved]).get("K.106")).toHaveLength(1);
  });

  it("a cleaning of the vacated unit on the move date", () => {
    const [r] = attachRoomSegments([mk()], [mid()]);
    expect(moveCleaningsFor(r)).toEqual([{ date: "2026-10-03", room: "K.106", toRoom: "K.103", stayFrom: "2026-10-01" }]);
  });
});
