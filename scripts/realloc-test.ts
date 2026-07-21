/* Quick sanity tests for the reallocation solver. Run: npx tsx scripts/realloc-test.ts */
import {
  ALLOCATION_GROUPS,
  planReallocation,
  planForUnallocated,
  type ReallocInput,
  type ResRef,
} from "../utils/roomAllocation";

const TODAY = "2026-06-22";

const DELUXE = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Deluxe Studios")!; // K.202, K.203
const URBAN = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Urban Studios")!; // K.102/103/106

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`✓ ${name}`);
  } else {
    fail++;
    console.log(`✗ ${name}`, extra ?? "");
  }
}

// 1. Empty unit → place, zero moves
{
  const res: ReallocInput[] = [
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("1 empty-units place, 0 moves", p.feasible && p.moves.length === 0 && p.placements.length === 1, p);
}

// 2. One unit occupied (non-overlapping future), other free → 0 moves
{
  const res: ReallocInput[] = [
    { reservationNumber: "A", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: "K.202", movable: true },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("2 free-other-unit, 0 moves", p.feasible && p.moves.length === 0 && p.placements[0].room === "K.203", p);
}

// 3. Both units busy in window but a single move frees one → exactly 1 move
{
  const res: ReallocInput[] = [
    { reservationNumber: "A", checkIn: "2026-06-24", checkOut: "2026-06-26", currentRoom: "K.202", movable: true },
    { reservationNumber: "B", checkIn: "2026-06-26", checkOut: "2026-06-28", currentRoom: "K.203", movable: true },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-27", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("3 one-move reshuffle", p.feasible && p.moves.length === 1 && p.placements.length === 1, p);
}

// 4. In-house pinned in one unit, other free → place in free, 0 moves
{
  const res: ReallocInput[] = [
    { reservationNumber: "P", checkIn: "2026-06-20", checkOut: "2026-06-26", currentRoom: "K.202", movable: false },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("4 pinned + free unit", p.feasible && p.moves.length === 0 && p.placements[0].room === "K.203", p);
}

// 5. Two in-house pinned overlap the unallocated in BOTH units → infeasible
{
  const res: ReallocInput[] = [
    { reservationNumber: "P1", checkIn: "2026-06-20", checkOut: "2026-06-27", currentRoom: "K.202", movable: false },
    { reservationNumber: "P2", checkIn: "2026-06-21", checkOut: "2026-06-28", currentRoom: "K.203", movable: false },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-26", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("5 in-house oversell infeasible", !p.feasible && !!p.reason, p);
}

// 6. Urban (3 units): two future bookings + unallocated all overlap → place in 3rd unit, 0 moves
{
  const res: ReallocInput[] = [
    { reservationNumber: "A", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: "K.102", movable: true },
    { reservationNumber: "B", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: "K.103", movable: true },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: null, movable: true },
  ];
  const p = planReallocation(URBAN, res);
  check("6 urban third unit free, 0 moves", p.feasible && p.moves.length === 0 && p.placements[0].room === "K.106", p);
}

// 7. Non-overlapping bookings outside the window are left untouched (not in moves)
{
  const res: ReallocInput[] = [
    { reservationNumber: "FAR", checkIn: "2026-07-10", checkOut: "2026-07-12", currentRoom: "K.202", movable: true },
    { reservationNumber: "U", checkIn: "2026-06-25", checkOut: "2026-06-28", currentRoom: null, movable: true },
  ];
  const p = planReallocation(DELUXE, res);
  check("7 far booking untouched", p.feasible && p.moves.length === 0, p);
}

// 8. planForUnallocated end-to-end: one unit busy, place in the free one
{
  const all: ResRef[] = [
    { reservationNumber: "BH-1", room: "K.202", checkInDate: "2026-06-24", checkOutDate: "2026-06-27", firstName: "A" },
    { reservationNumber: "BH-2", room: "1KK Deluxe Studios", checkInDate: "2026-06-25", checkOutDate: "2026-06-27", isUnallocatedVR: true, firstName: "U" },
  ];
  const r = planForUnallocated(all, "BH-2", TODAY);
  const ok = "plan" in r && r.plan.feasible && r.plan.moves.length === 0 && r.plan.placements[0]?.room === "K.203";
  check("8 planForUnallocated free unit", ok, r);
}

// 9. In-house guest is pinned; place unallocated in the other unit
{
  const all: ResRef[] = [
    { reservationNumber: "BH-1", room: "K.202", checkInDate: "2026-06-20", checkOutDate: "2026-06-26", firstName: "P" }, // in-house
    { reservationNumber: "BH-2", room: "1KK Deluxe Studios", checkInDate: "2026-06-25", checkOutDate: "2026-06-28", isUnallocatedVR: true },
  ];
  const r = planForUnallocated(all, "BH-2", TODAY);
  const ok = "plan" in r && r.plan.feasible && r.plan.moves.length === 0 && r.plan.placements[0]?.room === "K.203";
  check("9 in-house pinned, place other", ok, r);
}

// 10. A package occupying BOTH units blocks the type → infeasible
{
  const all: ResRef[] = [
    { reservationNumber: "BH-9", room: "K.202 + K.203", linkedRooms: ["K.202", "K.203"], checkInDate: "2026-06-24", checkOutDate: "2026-06-28", firstName: "PKG" },
    { reservationNumber: "BH-2", room: "1KK Deluxe Studios", checkInDate: "2026-06-25", checkOutDate: "2026-06-27", isUnallocatedVR: true },
  ];
  const r = planForUnallocated(all, "BH-2", TODAY);
  const ok = "plan" in r && !r.plan.feasible && !!r.plan.reason;
  check("10 package blocks both units", ok, r);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
