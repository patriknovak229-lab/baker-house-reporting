import { describe, it, expect } from "vitest";
import { planReallocation, ALLOCATION_GROUPS, type ReallocInput } from "./roomAllocation";

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

describe("planReallocation", () => {
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

  it("resolves a large component when it is mostly PINNED (regression: cap is on movable, not component size)", () => {
    // 18 in-house/pinned bookings daisy-chained across K.102/K.103, plus the
    // arriving seed — a 19-booking overlap component (would trip the old >16
    // component cap). Only the seed is movable, so the search is trivial.
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

  it("bails to manual only when too many bookings could actually MOVE", () => {
    // 13 movable + the movable seed = 14 movable > 12 cap → declines to search.
    const inputs: ReallocInput[] = [];
    for (let i = 0; i < 13; i++) {
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
