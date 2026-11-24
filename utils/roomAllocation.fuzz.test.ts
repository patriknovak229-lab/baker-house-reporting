/**
 * Property tests for the room-reallocation solver, on seeded random data so a
 * failure is reproducible. Two guarantees:
 *
 *   1. OPTIMAL — `planReallocation` returns exactly the brute-force optimum
 *      (same feasibility, same cost) for every small random case. Guards the
 *      branch-and-bound pruning: it must never discard a better plan.
 *   2. SAFE — on random realistic months (extensions booked as separate
 *      reservations, in-house guests, blackouts, cancelled ghosts),
 *      `planForUnallocated` never produces a plan that moves a guest who is
 *      already staying or arriving today, splits one guest's back-to-back stay,
 *      or double-books a unit — and its own independent safety check never
 *      has to step in.
 */
import { describe, it, expect } from "vitest";
import {
  planReallocation,
  planForUnallocated,
  planForClash,
  verifyPlan,
  guestKeyOf,
  ALLOCATION_GROUPS,
  type ReallocInput,
  type ResRef,
} from "./roomAllocation";

function prng(seed: number) {
  let s = seed;
  const next = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return { next, int: (a: number, b: number) => a + Math.floor(next() * (b - a + 1)) };
}
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const overlaps = (a: { checkIn: string; checkOut: string }, b: { checkIn: string; checkOut: string }) =>
  a.checkIn < b.checkOut && b.checkIn < a.checkOut;

const GROUPS = ALLOCATION_GROUPS.filter((g) => g.typeLabel === "1KK Urban Studios" || g.typeLabel === "1KK Deluxe Studios");

// The objective, restated independently of the solver.
const SPLIT = 1_000_000_000;
const MOVE = 1_000_000;
function planCost(inputs: ReallocInput[], unitOf: (x: ReallocInput) => string | null): number {
  let cost = 0;
  for (const m of inputs) if (m.currentRoom && unitOf(m) !== m.currentRoom) cost += MOVE + (m.urgency ?? 0);
  for (const s of inputs) {
    if (s.currentRoom !== null || !s.guestKey) continue;
    for (const o of inputs) {
      if (o === s || o.guestKey !== s.guestKey) continue;
      if (o.checkOut !== s.checkIn && s.checkOut !== o.checkIn) continue;
      if (o.currentRoom === null && inputs.indexOf(o) < inputs.indexOf(s)) continue; // count seed–seed once
      if (unitOf(o) !== unitOf(s)) cost += SPLIT;
    }
  }
  return cost;
}

describe("planReallocation is optimal (vs brute force)", () => {
  it("matches the exhaustive optimum on 1500 random small cases", () => {
    const r = prng(12345);
    let checked = 0;
    for (let t = 0; t < 1500; t++) {
      const g = GROUPS[r.int(0, GROUPS.length - 1)];
      const units = g.units.map((u) => u.room);
      const keys = ["a", "b", "c"];
      const inputs: ReallocInput[] = [];
      for (const u of units) {
        let d = r.int(1, 3);
        while (d < 14) {
          const len = r.int(1, 4);
          if (r.next() < 0.7) {
            inputs.push({
              reservationNumber: `R${inputs.length}`, checkIn: day(d), checkOut: day(d + len), currentRoom: u,
              movable: r.next() < 0.75, guestKey: keys[r.int(0, 2)], urgency: r.int(0, 50),
            });
          }
          d += len + r.int(0, 2);
        }
      }
      for (let s = 0; s < r.int(1, 2); s++) {
        const a = r.int(1, 12);
        inputs.push({ reservationNumber: `S${s}`, checkIn: day(a), checkOut: day(a + r.int(1, 4)), currentRoom: null, movable: true, guestKey: keys[r.int(0, 2)] });
      }

      // Brute force over the solver's scope: the transitive overlap component.
      const seeds = inputs.filter((i) => i.currentRoom === null);
      const comp = new Set(seeds);
      const queue = [...seeds];
      while (queue.length) {
        const c = queue.shift()!;
        for (const o of inputs) if (!comp.has(o) && overlaps(c, o)) { comp.add(o); queue.push(o); }
      }
      const compArr = [...comp];
      const movable = compArr.filter((x) => x.movable);
      if (movable.length > 9) continue; // keep the brute force tractable
      const pinned = compArr.filter((x) => !x.movable);
      const pinClash = units.some((u) => {
        const p = pinned.filter((x) => x.currentRoom === u);
        return p.some((a, i) => p.slice(i + 1).some((b) => overlaps(a, b)));
      });

      let best = Infinity;
      const asg = new Map<ReallocInput, string>();
      const unitOf = (x: ReallocInput) => asg.get(x) ?? x.currentRoom;
      const rec = (i: number) => {
        if (i === movable.length) {
          for (const u of units) {
            const inU = compArr.filter((x) => unitOf(x) === u);
            if (inU.some((a, k) => inU.slice(k + 1).some((b) => overlaps(a, b)))) return;
          }
          best = Math.min(best, planCost(inputs, unitOf));
          return;
        }
        for (const u of units) { asg.set(movable[i], u); rec(i + 1); }
        asg.delete(movable[i]);
      };
      if (!pinClash) rec(0);

      const plan = planReallocation(g, inputs);
      expect(plan.feasible, `case ${t}`).toBe(best < Infinity);
      if (plan.feasible) {
        expect(planCost(inputs, (x) => plan.assignment[x.reservationNumber] ?? x.currentRoom), `case ${t}`).toBe(best);
      }
      checked++;
    }
    expect(checked).toBeGreaterThan(1000);
  });
});

describe("planForUnallocated never breaks the hard rules", () => {
  it("holds on 1500 random realistic months", () => {
    const r = prng(777);
    const NAMES = [["Piotr", "Marczewski"], ["Anna", "Nováková"], ["Jens", "Berndt"], ["Gina", "Cufi"], ["Женя", "Шевченко"], ["Marco", "Rossi"]];
    let feasible = 0;
    let extensionsMoved = 0;
    for (let t = 0; t < 1500; t++) {
      const g = GROUPS[r.int(0, GROUPS.length - 1)];
      const units = g.units.map((u) => u.room);
      const today = day(r.int(3, 8));
      const all: ResRef[] = [];
      let n = 0;
      for (const u of units) {
        let d = r.int(1, 3);
        while (d < 26) {
          const len = r.int(1, 5);
          const [fn, ln] = NAMES[r.int(0, NAMES.length - 1)];
          if (r.next() < 0.8) {
            all.push({ reservationNumber: `BH-${++n}`, room: u, checkInDate: day(d), checkOutDate: day(d + len), firstName: fn, lastName: ln, ...(r.next() < 0.05 ? { isBlackout: true } : {}) });
            if (r.next() < 0.25) {
              // The same guest extends with a separate back-to-back booking (name written differently).
              const ext = r.int(1, 3);
              all.push({ reservationNumber: `BH-${++n}`, room: u, checkInDate: day(d + len), checkOutDate: day(d + len + ext), firstName: ln.toUpperCase(), lastName: fn });
              d += ext;
            }
          }
          d += len + r.int(0, 2);
        }
      }
      for (let k = 0; k < r.int(0, 3); k++) {
        const a = r.int(1, 20);
        all.push({ reservationNumber: `BH-${++n}`, room: units[r.int(0, units.length - 1)], checkInDate: day(a), checkOutDate: day(a + r.int(2, 10)), isCancelled: true, firstName: "Ghost", lastName: "Booking" });
      }
      const a = r.int(Number(today.slice(8)), 22);
      const [fn, ln] = NAMES[r.int(0, NAMES.length - 1)];
      all.push({ reservationNumber: "BH-SEED", room: g.typeLabel, checkInDate: day(a), checkOutDate: day(a + r.int(1, 5)), isUnallocatedVR: true, firstName: fn, lastName: ln });

      const out = planForUnallocated(all, "BH-SEED", today);
      if ("error" in out) continue;
      expect(out.plan.reason ?? "", `case ${t}`).not.toMatch(/^Safety check/);
      if (!out.plan.feasible) continue;
      feasible++;
      expect(verifyPlan(all, g, out.plan, today), `case ${t}`).toBeNull();

      const byId = new Map(all.map((x) => [x.reservationNumber, x]));
      for (const m of out.plan.moves) {
        const moved = byId.get(m.reservationNumber)!;
        expect(moved.checkInDate > today, `case ${t}: moved a staying guest`).toBe(true);
        const key = guestKeyOf(moved);
        for (const o of all) {
          if (o === moved || o.isCancelled || o.isBlackout || o.room !== moved.room || guestKeyOf(o) !== key) continue;
          if (o.checkOutDate !== moved.checkInDate && moved.checkOutDate !== o.checkInDate) continue;
          extensionsMoved++;
          const along = out.plan.moves.find((x) => x.reservationNumber === o.reservationNumber);
          expect(along?.to, `case ${t}: split ${moved.reservationNumber} from ${o.reservationNumber}`).toBe(m.to);
        }
      }
    }
    expect(feasible).toBeGreaterThan(500);
    expect(extensionsMoved).toBeGreaterThan(50); // the extension path is genuinely exercised
  });
});

describe("planForClash fixes OTA date-change double-bookings without breaking a rule", () => {
  it("holds on 1500 random months with a guest's date change", () => {
    const r = prng(4242);
    const NAMES = [["Piotr", "Marczewski"], ["Anna", "Nováková"], ["Jens", "Berndt"], ["Gina", "Cufi"], ["Silvia", "Ekres"], ["Marco", "Rossi"], ["Lea", "Moreau"], ["Tom", "Hardy"]];
    let changes = 0;
    let fixed = 0;
    for (let t = 0; t < 1500; t++) {
      const g = GROUPS[r.int(0, GROUPS.length - 1)];
      const units = g.units.map((u) => u.room);
      const today = day(r.int(3, 8));
      const all: ResRef[] = [];
      let n = 0;
      for (const u of units) {
        let d = r.int(1, 3);
        while (d < 26) {
          const len = r.int(1, 5);
          const [fn, ln] = NAMES[r.int(0, NAMES.length - 1)];
          if (r.next() < 0.75) {
            all.push({ reservationNumber: `BH-${++n}`, room: u, checkInDate: day(d), checkOutDate: day(d + len), firstName: fn, lastName: ln, ...(r.next() < 0.05 ? { isBlackout: true } : {}) });
          }
          d += len + r.int(0, 2);
        }
      }
      // A guest arriving after today changes dates. Their unit keeps them; the
      // OTA only allowed it because the ROOM TYPE has a free unit every night.
      const candidates = all.filter((b) => !b.isBlackout && b.checkInDate > today);
      if (candidates.length === 0) continue;
      const mover = candidates[r.int(0, candidates.length - 1)];
      const nights = r.int(1, 4);
      const start = r.int(Number(today.slice(8)) + 1, 24);
      const moved: ResRef = { ...mover, checkInDate: day(start), checkOutDate: day(start + nights) };
      const others = all.filter((b) => b !== mover);
      const typeHasSpace = Array.from({ length: nights }, (_, k) => day(start + k)).every(
        (night) => others.filter((b) => b.checkInDate <= night && night < b.checkOutDate).length < units.length,
      );
      if (!typeHasSpace) continue;
      const clashesInUnit = others.some((b) => b.room === moved.room && b.checkInDate < moved.checkOutDate && moved.checkInDate < b.checkOutDate);
      if (!clashesInUnit) continue;
      const month = [...others, moved];
      changes++;

      const out = planForClash(month, moved.reservationNumber, today);
      if ("error" in out) continue; // e.g. clashed only with a blackout / the same guest
      expect(out.plan.reason ?? "", `case ${t}`).not.toMatch(/^Safety check/);
      if (!out.plan.feasible) continue;
      fixed++;
      const involved = [moved.reservationNumber, ...out.clashWith];
      expect(verifyPlan(month, g, out.plan, today, involved), `case ${t}`).toBeNull();

      const byId = new Map(month.map((x) => [x.reservationNumber, x]));
      for (const m of out.plan.moves) {
        expect(byId.get(m.reservationNumber)!.checkInDate > today, `case ${t}: moved a staying guest`).toBe(true);
      }
      // Re-derive the end state independently: the date-changed guest and their
      // clash partners each end up alone in their unit on every live night.
      const unitAfter = (b: ResRef) => out.plan.moves.find((m) => m.reservationNumber === b.reservationNumber)?.to ?? b.room;
      for (const id of involved) {
        const a = byId.get(id)!;
        for (const b of month) {
          if (b === a || b.isCancelled || unitAfter(b) !== unitAfter(a) || guestKeyOf(b) === guestKeyOf(a)) continue;
          const from = (x: ResRef) => (x.checkInDate > today ? x.checkInDate : today);
          expect(from(a) < b.checkOutDate && from(b) < a.checkOutDate, `case ${t}: ${id} still shares ${unitAfter(a)} with ${b.reservationNumber}`).toBe(false);
        }
      }
    }
    expect(changes).toBeGreaterThan(300);
    expect(fixed).toBeGreaterThan(200); // the fix path is genuinely exercised
  });
});
