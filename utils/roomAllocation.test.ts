import { describe, it, expect } from "vitest";
import {
  planReallocation,
  planForUnallocated,
  ALLOCATION_GROUPS,
  type ReallocInput,
  type ResRef,
} from "./roomAllocation";

const URBAN = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Urban Studios")!; // K.102/K.103/K.106
const DELUXE = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Deluxe Studios")!; // K.202/K.203

function res(over: Partial<ReallocInput> & { reservationNumber: string }): ReallocInput {
  return { checkIn: "2026-08-01", checkOut: "2026-08-03", currentRoom: null, movable: true, ...over };
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True when the full assignment double-books no unit. */
function conflictFree(assignment: Record<string, string>, inputs: ReallocInput[]): boolean {
  const byId = new Map(inputs.map((r) => [r.reservationNumber, r]));
  const perUnit = new Map<string, ReallocInput[]>();
  for (const [id, unit] of Object.entries(assignment)) {
    const r = byId.get(id.split("#")[0]) ?? byId.get(id);
    if (!r) continue;
    const list = perUnit.get(unit) ?? [];
    for (const other of list) {
      if (r.checkIn < other.checkOut && other.checkIn < r.checkOut) return false;
    }
    list.push(r);
    perUnit.set(unit, list);
  }
  return true;
}

describe("planReallocation (core solver)", () => {
  it("solves the canonical reshuffle (no single unit free all stay, one free each night) in one move", () => {
    // K.202 busy night 1 (A), K.203 busy night 2 (B): each night one unit is
    // free, but neither unit is free for the whole 2-night stay → 1 move.
    const inputs: ReallocInput[] = [
      res({ reservationNumber: "S", currentRoom: null }),
      res({ reservationNumber: "A", currentRoom: "K.202", checkIn: "2026-08-01", checkOut: "2026-08-02" }),
      res({ reservationNumber: "B", currentRoom: "K.203", checkIn: "2026-08-02", checkOut: "2026-08-03" }),
    ];
    const plan = planReallocation(DELUXE, inputs);

    expect(plan.feasible).toBe(true);
    expect(plan.placements).toHaveLength(1);
    expect(plan.moves).toHaveLength(1);
    expect(conflictFree(plan.assignment, inputs)).toBe(true);
  });

  it("resolves a large component when it is mostly PINNED (cost is movable count, not component size)", () => {
    // 18 in-house/pinned bookings daisy-chained across K.102/K.103, plus the
    // arriving seed — a 19-booking overlap component. Only the seed is movable,
    // so the search is trivial.
    const inputs: ReallocInput[] = [];
    for (let i = 0; i < 18; i++) {
      const start = addDays("2026-08-01", 2 * i);
      inputs.push({
        reservationNumber: `P-${i}`,
        checkIn: start,
        checkOut: addDays(start, 3),
        currentRoom: i % 2 === 0 ? "K.102" : "K.103",
        movable: false, // pinned in-house
      });
    }
    inputs.push(res({ reservationNumber: "S", currentRoom: null, checkIn: "2026-08-02", checkOut: "2026-08-04" }));

    const plan = planReallocation(URBAN, inputs);

    expect(plan.feasible).toBe(true);
    expect(plan.placements).toHaveLength(1);
    expect(plan.placements[0].room).toBe("K.106"); // the only free unit those nights
    expect(plan.moves).toHaveLength(0); // pinned guests never move
    expect(conflictFree(plan.assignment, inputs)).toBe(true);
  });

  it("bails to manual only on a pathologically large movable set (guard)", () => {
    // 31 movable chained bookings + the seed > 30 guard → declines to search.
    const inputs: ReallocInput[] = [];
    for (let i = 0; i < 31; i++) {
      const start = addDays("2026-08-01", 2 * i);
      inputs.push({
        reservationNumber: `M-${i}`,
        checkIn: start,
        checkOut: addDays(start, 3),
        currentRoom: i % 2 === 0 ? "K.102" : "K.103",
        movable: true,
      });
    }
    inputs.push(res({ reservationNumber: "S", currentRoom: null, checkIn: "2026-08-02", checkOut: "2026-08-04" }));

    const plan = planReallocation(URBAN, inputs);

    expect(plan.feasible).toBe(false);
    expect(plan.reason).toMatch(/too many movable/i);
  });
});

describe("planForUnallocated (two-tier, guest-messaging aware)", () => {
  // The real peak-season case behind this feature (today = Aug 3): 1KK Urban is
  // near-full, no single unit is free for Aug 3–4, and the whole back half of
  // the month is chained in via a long stay → 15 movable bookings.
  const TODAY = "2026-08-03";
  const MONTH: ResRef[] = [
    { reservationNumber: "BH-90890877", room: "1KK Urban Studios", checkInDate: "2026-08-03", checkOutDate: "2026-08-05", isUnallocatedVR: true, firstName: "Viktorie", lastName: "Holá" },
    { reservationNumber: "LP", room: "K.102", checkInDate: "2026-08-02", checkOutDate: "2026-08-05" }, // in-house
    { reservationNumber: "LH", room: "K.106", checkInDate: "2026-08-02", checkOutDate: "2026-08-04" }, // in-house
    { reservationNumber: "BH-88647722", room: "K.103", checkInDate: "2026-08-04", checkOutDate: "2026-08-10" }, // arrives tomorrow → messaged
    { reservationNumber: "RC", room: "K.102", checkInDate: "2026-08-06", checkOutDate: "2026-08-08" },
    { reservationNumber: "BH-88745983", room: "K.106", checkInDate: "2026-08-06", checkOutDate: "2026-08-09" },
    { reservationNumber: "FF", room: "K.102", checkInDate: "2026-08-08", checkOutDate: "2026-08-10" },
    { reservationNumber: "BH-89379665", room: "K.106", checkInDate: "2026-08-09", checkOutDate: "2026-08-11" },
    { reservationNumber: "BH-90407827", room: "K.103", checkInDate: "2026-08-10", checkOutDate: "2026-08-12" },
    { reservationNumber: "AH", room: "K.102", checkInDate: "2026-08-10", checkOutDate: "2026-08-13" },
    { reservationNumber: "KV", room: "K.106", checkInDate: "2026-08-12", checkOutDate: "2026-08-15" },
    { reservationNumber: "GA", room: "K.103", checkInDate: "2026-08-12", checkOutDate: "2026-08-23" }, // long stay, chains the back half
    { reservationNumber: "MM", room: "K.102", checkInDate: "2026-08-14", checkOutDate: "2026-08-17" },
    { reservationNumber: "JF", room: "K.106", checkInDate: "2026-08-15", checkOutDate: "2026-08-17" },
    { reservationNumber: "BB2", room: "K.106", checkInDate: "2026-08-17", checkOutDate: "2026-08-19" },
    { reservationNumber: "PP", room: "K.102", checkInDate: "2026-08-18", checkOutDate: "2026-08-20" },
    { reservationNumber: "IK", room: "K.102", checkInDate: "2026-08-20", checkOutDate: "2026-08-22" },
  ];

  it("escalates past the messaging window when no silent reshuffle exists, flagging only the soon-arriving mover", () => {
    const out = planForUnallocated(MONTH, "BH-90890877", TODAY);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    const { plan } = out;

    expect(plan.feasible).toBe(true);
    expect(plan.escalated).toBe(true); // silent pass was impossible
    expect(plan.placements).toEqual([
      expect.objectContaining({ reservationNumber: "BH-90890877", room: "K.103" }),
    ]);
    expect(plan.moves).toHaveLength(4);

    // Only the guest arriving tomorrow (BH-88647722) needs informing.
    const notify = plan.moves.filter((m) => m.needsGuestNotice).map((m) => m.reservationNumber);
    expect(notify).toEqual(["BH-88647722"]);
  });

  it("prefers a silent plan when one exists (no notices, not escalated)", () => {
    // Same month, but the arriving guest only needs Aug 5–6 — nights that a
    // later-arriving (non-messaged) shuffle can cover without touching tomorrow.
    const silentCase: ResRef[] = MONTH.map((r) =>
      r.isUnallocatedVR ? { ...r, checkInDate: "2026-08-05", checkOutDate: "2026-08-06" } : r,
    );
    const out = planForUnallocated(silentCase, "BH-90890877", TODAY);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    const { plan } = out;

    expect(plan.feasible).toBe(true);
    expect(plan.escalated).toBeFalsy();
    expect(plan.moves.every((m) => !m.needsGuestNotice)).toBe(true);
  });

  it("ignores cancelled bookings (they hold no room) — no false 'no arrangement'", () => {
    // A cancelled booking sitting on K.103 across Aug 1–6 would, if counted,
    // block the only free unit on Aug 3 and make the case look infeasible.
    // Cancellations are hidden on the calendar grid, so this is exactly the
    // false negative that hit the live Viktorie case.
    const withGhost: ResRef[] = [
      ...MONTH,
      { reservationNumber: "CANCELLED-X", room: "K.103", checkInDate: "2026-08-01", checkOutDate: "2026-08-06", isCancelled: true },
    ];
    const out = planForUnallocated(withGhost, "BH-90890877", TODAY);
    expect("error" in out).toBe(false);
    if ("error" in out) return;
    const { plan } = out;

    expect(plan.feasible).toBe(true); // cancelled ghost ignored → solvable
    expect(plan.placements).toEqual([
      expect.objectContaining({ reservationNumber: "BH-90890877", room: "K.103" }),
    ]);
    expect(plan.moves).toHaveLength(4);
    expect(plan.moves.some((m) => m.reservationNumber === "CANCELLED-X")).toBe(false);
  });
});
