import { describe, it, expect } from "vitest";
import {
  planReallocation,
  planForUnallocated,
  findMoveCreatedConflict,
  buildGroupInputs,
  verifyPlan,
  guestKeyOf,
  ALLOCATION_GROUPS,
  type ReallocInput,
  type ReallocPlan,
  type ResRef,
  type MoveBooking,
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

describe("multi-apartment reservations (one guest, several units)", () => {
  /** A reservation holding two units, as `mapToReservation` emits it. */
  function pkg(over: Partial<ResRef> & { reservationNumber: string; linkedRooms: string[] }): ResRef {
    return {
      room: over.linkedRooms.join(" + "),
      checkInDate: "2026-09-25",
      checkOutDate: "2026-09-27",
      ...over,
    };
  }

  it("moves ONE apartment of a two-apartment booking instead of declaring the type oversold", () => {
    // The shape of the BH-93351977 case. K.102 is blacked out on the 24th, so
    // the arriving guest must start in K.103 or K.106 — and on the 25th the
    // pair needs two units, which only works if the leg sharing the arriving
    // guest's unit shifts to K.102. With the pair pinned as one lump there is
    // no arrangement at all, which is exactly what the operator hit.
    const all: ResRef[] = [
      { reservationNumber: "OV-1", room: "K.102", checkInDate: "2026-09-24", checkOutDate: "2026-09-25", isBlackout: true },
      { reservationNumber: "ARRIVING", room: "1KK Urban Studios", checkInDate: "2026-09-24", checkOutDate: "2026-09-26", isUnallocatedVR: true, firstName: "Krzysztof", lastName: "K" },
      pkg({ reservationNumber: "PAIR", linkedRooms: ["K.103", "K.106"], firstName: "Mihály", lastName: "V" }),
    ];
    const res = planForUnallocated(all, "ARRIVING", "2026-09-19");

    expect("error" in res).toBe(false);
    if ("error" in res) return;
    expect(res.plan.feasible).toBe(true);
    // Exactly one leg moves, into the unit the arriving guest cannot use.
    expect(res.plan.moves).toHaveLength(1);
    expect(res.plan.moves[0].reservationNumber).toMatch(/^PAIR#K\.(103|106)$/);
    expect(res.plan.moves[0].to).toBe("K.102");
    expect(res.plan.placements[0].room).toMatch(/^K\.(103|106)$/);
    // The guest who booked two apartments still has two, and the arriving
    // guest is not put in the blacked-out room.
    expect(res.plan.assignment["ARRIVING"]).not.toBe("K.102");
  });

  it("never collapses two apartments of one booking into the same unit", () => {
    // The legs share dates, so the no-double-booking rule must keep them apart
    // — otherwise a two-apartment guest would be handed a single room.
    const all: ResRef[] = [
      { reservationNumber: "OV-1", room: "K.102", checkInDate: "2026-09-24", checkOutDate: "2026-09-25", isBlackout: true },
      { reservationNumber: "ARRIVING", room: "1KK Urban Studios", checkInDate: "2026-09-24", checkOutDate: "2026-09-26", isUnallocatedVR: true },
      pkg({ reservationNumber: "PAIR", linkedRooms: ["K.103", "K.106"] }),
    ];
    const res = planForUnallocated(all, "ARRIVING", "2026-09-19");
    if ("error" in res) throw new Error(res.error);

    const units = Object.entries(res.plan.assignment)
      .filter(([id]) => id.startsWith("PAIR#"))
      .map(([, unit]) => unit);
    expect(units).toHaveLength(2);
    expect(new Set(units).size).toBe(2);
  });

  it("still refuses to move an apartment whose guest has already checked in", () => {
    // In-house pins the whole reservation, legs included.
    const all: ResRef[] = [
      { reservationNumber: "ARRIVING", room: "1KK Urban Studios", checkInDate: "2026-09-20", checkOutDate: "2026-09-22", isUnallocatedVR: true },
      pkg({ reservationNumber: "PAIR", linkedRooms: ["K.103", "K.106"], checkInDate: "2026-09-18", checkOutDate: "2026-09-23" }),
      { reservationNumber: "THIRD", room: "K.102", checkInDate: "2026-09-18", checkOutDate: "2026-09-23" },
    ];
    const res = planForUnallocated(all, "ARRIVING", "2026-09-19");
    if ("error" in res) throw new Error(res.error);

    expect(res.plan.feasible).toBe(false);
    expect(res.plan.moves).toHaveLength(0);
  });

  it("places only the apartment still on the virtual room, under its own booking (BH-95377263)", () => {
    // Real data, 28 Oct 2026: O.308 + an Urban studio in one Booking.com
    // reservation; the studio (BH-95377264) is still on the Urban VR and no
    // studio is free 16–18 Nov without a shuffle.
    const all: ResRef[] = [
      {
        reservationNumber: "BH-95377263", room: "O.308 + 1KK Urban Studios", linkedRooms: ["O.308", "1KK Urban Studios"],
        checkInDate: "2026-11-16", checkOutDate: "2026-11-18", isUnallocatedVR: true,
        unallocatedLegs: [{ reservationNumber: "BH-95377264", room: "1KK Urban Studios" }],
        firstName: "Guest", lastName: "A",
      },
      { reservationNumber: "BH-95082155", room: "K.102", checkInDate: "2026-11-10", checkOutDate: "2026-11-17" },
      { reservationNumber: "BH-95165294", room: "K.103", checkInDate: "2026-11-14", checkOutDate: "2026-11-21" },
      { reservationNumber: "BH-95167753", room: "K.106", checkInDate: "2026-11-13", checkOutDate: "2026-11-15" },
      { reservationNumber: "BH-95199521", room: "K.106", checkInDate: "2026-11-17", checkOutDate: "2026-11-21" },
      { reservationNumber: "BH-94864852", room: "K.102", checkInDate: "2026-11-20", checkOutDate: "2026-11-22" },
    ];
    expect(buildGroupInputs(all, URBAN, "2026-10-28").filter((i) => i.currentRoom === null).map((i) => i.reservationNumber))
      .toEqual(["BH-95377264"]);

    const res = planForUnallocated(all, "BH-95377263", "2026-10-28");
    if ("error" in res) throw new Error(res.error);
    expect(res.group.typeLabel).toBe("1KK Urban Studios");
    expect(res.plan.feasible).toBe(true);
    expect(res.plan.placements).toEqual([expect.objectContaining({ reservationNumber: "BH-95377264", room: "K.106" })]);
    expect(res.plan.moves.map((m) => [m.reservationNumber, m.from, m.to])).toEqual([
      ["BH-95199521", "K.106", "K.102"],
      ["BH-94864852", "K.102", "K.106"],
    ]);
    // O.308 is no studio — nothing in the plan touches it.
    expect(Object.keys(res.plan.assignment).some((id) => id.startsWith("BH-95377263"))).toBe(false);
  });

  it("keeps a waiting apartment out of the unit its own placed apartment holds", () => {
    const all: ResRef[] = [
      {
        reservationNumber: "BH-1", room: "K.102 + 1KK Urban Studios", linkedRooms: ["K.102", "1KK Urban Studios"],
        checkInDate: "2026-11-16", checkOutDate: "2026-11-18", isUnallocatedVR: true,
        unallocatedLegs: [{ reservationNumber: "BH-2", room: "1KK Urban Studios" }],
      },
      { reservationNumber: "BH-3", room: "K.103", checkInDate: "2026-11-15", checkOutDate: "2026-11-19" },
    ];
    const res = planForUnallocated(all, "BH-1", "2026-10-28");
    if ("error" in res) throw new Error(res.error);
    expect(res.plan.feasible).toBe(true);
    expect(res.plan.placements.map((p) => [p.reservationNumber, p.room])).toEqual([["BH-2", "K.106"]]);
    expect(res.plan.moves).toHaveLength(0);
  });

  it("leaves a blackout's units alone even when it spans several rooms", () => {
    const all: ResRef[] = [
      { reservationNumber: "ARRIVING", room: "1KK Urban Studios", checkInDate: "2026-09-25", checkOutDate: "2026-09-27", isUnallocatedVR: true },
      pkg({ reservationNumber: "OV-X", linkedRooms: ["K.102", "K.103", "K.106"], isBlackout: true }),
    ];
    const res = planForUnallocated(all, "ARRIVING", "2026-09-19");
    if ("error" in res) throw new Error(res.error);
    expect(res.plan.feasible).toBe(false);
  });
});

describe("findMoveCreatedConflict (execute-time double-book check)", () => {
  // The real BH-94705092 (Zoltan) case: post-move K.103 carries a pre-existing,
  // already-departed overbooking (Abhi #92586229 vs Justin #93371888, overlap
  // Sep 28–Oct 3) that neither leg of the shuffle touches. It must NOT veto it.
  const WITH_GHOST: Record<string, MoveBooking[]> = {
    "K.103": [
      { id: 92586229, arrival: "2026-09-27", departure: "2026-10-03" }, // Abhi — staying (departed)
      { id: 93371888, arrival: "2026-09-28", departure: "2026-10-18" }, // Justin — staying
      { id: 94705092, arrival: "2026-10-18", departure: "2026-10-21" }, // Zoltan — moved in
      { id: 93322418, arrival: "2026-10-22", departure: "2026-10-24" }, // Jana — moved in
      { id: 92991204, arrival: "2026-10-24", departure: "2026-10-28" }, // Jens — moved in
    ],
    "K.102": [
      { id: 94035909, arrival: "2026-10-13", departure: "2026-10-19" }, // Vasyl — staying
      { id: 94258097, arrival: "2026-10-19", departure: "2026-10-27" }, // Edoardo — moved in
    ],
  };
  const MOVED = new Set([94705092, 93322418, 92991204, 94258097]);

  it("ignores a pre-existing overbooking neither leg touches (regression)", () => {
    expect(findMoveCreatedConflict(WITH_GHOST, MOVED)).toBeNull();
  });

  it("flags a conflict a moved booking creates against a staying guest", () => {
    // Zoltan arrives a day early → overlaps Justin (who checks out Oct 18).
    const bad: Record<string, MoveBooking[]> = {
      "K.103": [
        { id: 93371888, arrival: "2026-09-28", departure: "2026-10-18" }, // staying
        { id: 94705092, arrival: "2026-10-17", departure: "2026-10-21" }, // moved in → clashes
      ],
    };
    const c = findMoveCreatedConflict(bad, new Set([94705092]));
    expect(c).not.toBeNull();
    expect(c!.unit).toBe("K.103");
    expect([c!.a, c!.b].sort((x, y) => x - y)).toEqual([93371888, 94705092]);
  });

  it("flags two moved bookings sent to the same unit overlapping", () => {
    const bad: Record<string, MoveBooking[]> = {
      "K.103": [
        { id: 111, arrival: "2026-10-20", departure: "2026-10-24" },
        { id: 222, arrival: "2026-10-22", departure: "2026-10-26" },
      ],
    };
    expect(findMoveCreatedConflict(bad, new Set([111, 222]))).not.toBeNull();
  });

  it("treats a same-day turnover (moved in as another checks out) as clean", () => {
    const ok: Record<string, MoveBooking[]> = {
      "K.103": [
        { id: 93371888, arrival: "2026-09-28", departure: "2026-10-18" }, // staying, out Oct 18
        { id: 94705092, arrival: "2026-10-18", departure: "2026-10-21" }, // moved in, in Oct 18
      ],
    };
    expect(findMoveCreatedConflict(ok, new Set([94705092]))).toBeNull();
  });
});

describe("guest continuity — one guest's back-to-back bookings are one stay", () => {
  const DELUXE_G = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Deluxe Studios")!; // K.202/K.203

  // The real BH-95015797 (Sandra Feser) case, Oct 2026, as cached — including a
  // cancelled ghost that spans the whole period. Piotr Marczewski stays Oct
  // 22→27 in K.202 as TWO bookings: the main stay + a one-night extension.
  const SANDRA: ResRef[] = [
    { reservationNumber: "BH-95015797", room: "1KK Deluxe Studios", checkInDate: "2026-10-26", checkOutDate: "2026-10-31", isUnallocatedVR: true, firstName: "Sandra", lastName: "Feser" },
    { reservationNumber: "BH-91818349", room: "K.202", checkInDate: "2026-09-08", checkOutDate: "2026-12-05", isCancelled: true, firstName: "suiyi", lastName: "zhou" },
    { reservationNumber: "BH-94812257", room: "K.202", checkInDate: "2026-10-19", checkOutDate: "2026-10-22", firstName: "Agata", lastName: "Nowakova" },
    { reservationNumber: "BH-93901799", room: "K.202", checkInDate: "2026-10-22", checkOutDate: "2026-10-26", firstName: "Piotr", lastName: "Marczewski" },
    { reservationNumber: "BH-93987993", room: "K.202", checkInDate: "2026-10-26", checkOutDate: "2026-10-27", firstName: "Piotr", lastName: "Marczewski" },
    { reservationNumber: "BH-94688106", room: "K.203", checkInDate: "2026-10-18", checkOutDate: "2026-10-23", firstName: "Mohamed", lastName: "Al Ali" },
    { reservationNumber: "BH-89671752", room: "K.203", checkInDate: "2026-10-23", checkOutDate: "2026-10-25", firstName: "Marcelo", lastName: "Montebello" },
    { reservationNumber: "BH-94998095", room: "K.203", checkInDate: "2026-10-29", checkOutDate: "2026-10-31", firstName: "gina", lastName: "cufi foradat" },
    { reservationNumber: "BH-94868986", room: "K.203", checkInDate: "2026-11-02", checkOutDate: "2026-11-04", firstName: "Alechnavičius", lastName: "Edgaras" },
  ];

  for (const today of ["2026-10-21", "2026-10-22"]) {
    it(`never moves an extension off its stay — Sandra case, today ${today}`, () => {
      const out = planForUnallocated(SANDRA, "BH-95015797", today);
      if ("error" in out) throw new Error(out.error);
      expect(out.plan.feasible).toBe(true);
      expect(out.plan.placements).toEqual([expect.objectContaining({ reservationNumber: "BH-95015797", room: "K.203" })]);
      // The one-move answer: gina shifts to K.202, Piotr's stay is untouched.
      expect(out.plan.moves).toEqual([
        expect.objectContaining({ reservationNumber: "BH-94998095", from: "K.203", to: "K.202", checkIn: "2026-10-29", checkOut: "2026-10-31" }),
      ]);
    });
  }

  it("chains the main stay + extension into one row that moves whole", () => {
    const inputs = buildGroupInputs(SANDRA, DELUXE_G, "2026-10-21");
    const piotr = inputs.filter((i) => i.label === "Piotr Marczewski");
    expect(piotr).toHaveLength(1);
    expect(piotr[0]).toMatchObject({ currentRoom: "K.202", checkIn: "2026-10-22", checkOut: "2026-10-27", messaged: true });
    expect(piotr[0].members?.map((m) => m.reservationNumber)).toEqual(["BH-93901799", "BH-93987993"]);
    // The cancelled ghost holds nothing.
    expect(inputs.some((i) => i.reservationNumber === "BH-91818349")).toBe(false);
  });

  // K.202: guest X stays Oct 5→14 as two bookings. K.203 is blacked out from
  // Oct 14. S needs Oct 12→16 — only K.202 can take it, so X must go to K.203.
  const WHOLE_STAY: ResRef[] = [
    { reservationNumber: "S", room: "1KK Deluxe Studios", checkInDate: "2026-10-12", checkOutDate: "2026-10-16", isUnallocatedVR: true, firstName: "New", lastName: "Guest" },
    { reservationNumber: "X1", room: "K.202", checkInDate: "2026-10-05", checkOutDate: "2026-10-09", firstName: "Xavier", lastName: "Long" },
    { reservationNumber: "X2", room: "K.202", checkInDate: "2026-10-09", checkOutDate: "2026-10-14", firstName: "XAVIER", lastName: "long" },
    { reservationNumber: "OV", room: "K.203", checkInDate: "2026-10-14", checkOutDate: "2026-10-20", isBlackout: true },
  ];

  it("moves BOTH bookings of a future stay together (never just the extension)", () => {
    const out = planForUnallocated(WHOLE_STAY, "S", "2026-10-01");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.feasible).toBe(true);
    expect(out.plan.placements[0].room).toBe("K.202");
    expect(out.plan.moves.map((m) => [m.reservationNumber, m.to])).toEqual([["X1", "K.203"], ["X2", "K.203"]]);
  });

  it("refuses rather than split a guest who is already staying", () => {
    // Same layout, but X arrived yesterday: their stay is pinned whole, so the
    // old answer (move only the X2 extension to K.203) is no longer allowed.
    const out = planForUnallocated(WHOLE_STAY, "S", "2026-10-06");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.feasible).toBe(false);
    expect(out.plan.moves).toHaveLength(0);
  });

  it("puts an unplaced extension into the staying guest's unit, even at the cost of a move", () => {
    // G is in K.202 until Oct 8; their extension E (Oct 8→10) landed on the VR.
    // K.202 has F for one night; K.203 is free. Cheapest by moves would put E in
    // K.203 — but that sends G across the corridor mid-stay. Move F instead.
    const all: ResRef[] = [
      { reservationNumber: "G", room: "K.202", checkInDate: "2026-10-03", checkOutDate: "2026-10-08", firstName: "Gabriela", lastName: "Nováková" },
      { reservationNumber: "E", room: "1KK Deluxe Studios", checkInDate: "2026-10-08", checkOutDate: "2026-10-10", isUnallocatedVR: true, firstName: "Gabriela", lastName: "Novakova" },
      { reservationNumber: "F", room: "K.202", checkInDate: "2026-10-08", checkOutDate: "2026-10-09", firstName: "Frank", lastName: "Other" },
    ];
    const out = planForUnallocated(all, "E", "2026-10-06");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.placements).toEqual([expect.objectContaining({ reservationNumber: "E", room: "K.202" })]);
    expect(out.plan.placements[0].splitFrom).toBeUndefined();
    expect(out.plan.moves).toEqual([expect.objectContaining({ reservationNumber: "F", to: "K.203" })]);
  });

  it("flags the room change when keeping an extension with its stay is impossible", () => {
    const all: ResRef[] = [
      { reservationNumber: "G", room: "K.202", checkInDate: "2026-10-03", checkOutDate: "2026-10-08", firstName: "Gabriela", lastName: "Nováková" },
      { reservationNumber: "E", room: "1KK Deluxe Studios", checkInDate: "2026-10-08", checkOutDate: "2026-10-10", isUnallocatedVR: true, firstName: "Gabriela", lastName: "Nováková" },
      { reservationNumber: "OV", room: "K.202", checkInDate: "2026-10-08", checkOutDate: "2026-10-09", isBlackout: true },
    ];
    const out = planForUnallocated(all, "E", "2026-10-06");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.feasible).toBe(true);
    expect(out.plan.placements[0]).toMatchObject({ room: "K.203", splitFrom: "K.202" });
    expect(out.plan.staySplits).toBe(1);
  });

  it("among equal-move plans, moves the guest who arrives later", () => {
    // Either A (arrives Oct 10) or B (arrives Oct 14) can make way. Prefer B.
    const base: ResRef[] = [
      { reservationNumber: "S", room: "1KK Deluxe Studios", checkInDate: "2026-10-10", checkOutDate: "2026-10-15", isUnallocatedVR: true },
      { reservationNumber: "A", room: "K.202", checkInDate: "2026-10-10", checkOutDate: "2026-10-11", firstName: "Anna", lastName: "Early" },
      { reservationNumber: "B", room: "K.203", checkInDate: "2026-10-14", checkOutDate: "2026-10-15", firstName: "Bob", lastName: "Late" },
    ];
    for (const order of [base, [...base].reverse()]) {
      const out = planForUnallocated(order, "S", "2026-10-01");
      if ("error" in out) throw new Error(out.error);
      expect(out.plan.moves.map((m) => m.reservationNumber)).toEqual(["B"]);
      expect(out.plan.placements[0].room).toBe("K.203");
    }
  });

  it("normalises guest identity (case, diacritics, word order, any script)", () => {
    expect(guestKeyOf({ firstName: "Piotr", lastName: "Marczewski" })).toBe(guestKeyOf({ firstName: "MARCZEWSKI", lastName: "piotr" }));
    expect(guestKeyOf({ firstName: "Gabriela", lastName: "Nováková" })).toBe(guestKeyOf({ firstName: "gabriela", lastName: "Novakova" }));
    expect(guestKeyOf({ firstName: "Женя", lastName: "Шевченко" })).toBeTruthy();
    expect(guestKeyOf({ firstName: "", lastName: "  " })).toBeUndefined();
  });

  it("addresses a package leg by unit even when only one leg is in this group", () => {
    const all: ResRef[] = [
      { reservationNumber: "BH-1", room: "K.102 + K.202", linkedRooms: ["K.102", "K.202"], checkInDate: "2026-10-10", checkOutDate: "2026-10-12" },
    ];
    expect(buildGroupInputs(all, DELUXE_G, "2026-10-01").map((i) => i.reservationNumber)).toEqual(["BH-1#K.202"]);
  });

  it("counts a mid-stay-moved guest only in the unit they're in now", () => {
    const all: ResRef[] = [
      {
        reservationNumber: "M", room: "K.203", checkInDate: "2026-10-01", checkOutDate: "2026-10-10",
        roomSegments: [
          { room: "K.202", from: "2026-10-01", to: "2026-10-04", nights: 3, share: 1 / 3 },
          { room: "K.203", from: "2026-10-04", to: "2026-10-10", nights: 6, share: 2 / 3 },
        ],
      },
    ];
    const inputs = buildGroupInputs(all, DELUXE_G, "2026-10-05");
    expect(inputs).toEqual([expect.objectContaining({ reservationNumber: "M", currentRoom: "K.203", checkIn: "2026-10-05", movable: false })]);
  });
});

describe("verifyPlan — independent safety net", () => {
  const DELUXE_G = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Deluxe Studios")!;
  const SANDRA: ResRef[] = [
    { reservationNumber: "BH-95015797", room: "1KK Deluxe Studios", checkInDate: "2026-10-26", checkOutDate: "2026-10-31", isUnallocatedVR: true, firstName: "Sandra", lastName: "Feser" },
    { reservationNumber: "BH-93901799", room: "K.202", checkInDate: "2026-10-22", checkOutDate: "2026-10-26", firstName: "Piotr", lastName: "Marczewski" },
    { reservationNumber: "BH-93987993", room: "K.202", checkInDate: "2026-10-26", checkOutDate: "2026-10-27", firstName: "Piotr", lastName: "Marczewski" },
    { reservationNumber: "BH-89671752", room: "K.203", checkInDate: "2026-10-23", checkOutDate: "2026-10-25", firstName: "Marcelo", lastName: "Montebello" },
    { reservationNumber: "BH-94998095", room: "K.203", checkInDate: "2026-10-29", checkOutDate: "2026-10-31", firstName: "gina", lastName: "cufi foradat" },
  ];
  const plan = (p: Partial<ReallocPlan>): ReallocPlan => ({ feasible: true, placements: [], moves: [], assignment: {}, ...p });

  it("passes the correct plan", () => {
    const good = plan({
      placements: [{ reservationNumber: "BH-95015797", room: "K.203" }],
      moves: [{ reservationNumber: "BH-94998095", from: "K.203", to: "K.202" }],
    });
    expect(verifyPlan(SANDRA, DELUXE_G, good, "2026-10-21")).toBeNull();
  });

  it("rejects the old suggestion — moving only Piotr's extension splits his stay", () => {
    const old = plan({
      placements: [{ reservationNumber: "BH-95015797", room: "K.202" }],
      moves: [{ reservationNumber: "BH-93987993", from: "K.202", to: "K.203" }],
    });
    expect(verifyPlan(SANDRA, DELUXE_G, old, "2026-10-21")).toMatch(/splits Piotr Marczewski's stay/);
  });

  it("rejects a double-booking", () => {
    const bad = plan({ placements: [{ reservationNumber: "BH-95015797", room: "K.203" }] });
    expect(verifyPlan(SANDRA, DELUXE_G, bad, "2026-10-21")).toMatch(/double-booked with gina/);
  });

  it("rejects moving a guest who is already staying", () => {
    const all: ResRef[] = [
      { reservationNumber: "H", room: "K.202", checkInDate: "2026-10-19", checkOutDate: "2026-10-25", firstName: "Hana", lastName: "Here" },
    ];
    const bad = plan({ moves: [{ reservationNumber: "H", from: "K.202", to: "K.203" }] });
    expect(verifyPlan(all, DELUXE_G, bad, "2026-10-21")).toMatch(/already staying/);
  });
});

describe("operator stay links override names (utils/stayChains)", () => {
  const DELUXE_G = ALLOCATION_GROUPS.find((g) => g.typeLabel === "1KK Deluxe Studios")!;
  const LINK = { source: "manual" as const, linkedAt: "2026-10-21T10:00:00Z", linkedBy: "op@example.com" };
  // K.202: the company pays for the extension, so it's under another name.
  // K.203 is blacked out from Oct 14; S needs Oct 12→16 and only fits K.202.
  const COMPANY: ResRef[] = [
    { reservationNumber: "S", room: "1KK Deluxe Studios", checkInDate: "2026-10-12", checkOutDate: "2026-10-16", isUnallocatedVR: true, firstName: "New", lastName: "Guest" },
    { reservationNumber: "X1", room: "K.202", checkInDate: "2026-10-05", checkOutDate: "2026-10-09", firstName: "Xavier", lastName: "Long" },
    { reservationNumber: "X2", room: "K.202", checkInDate: "2026-10-09", checkOutDate: "2026-10-14", firstName: "Acme", lastName: "s.r.o.", stayLink: { prev: "X1", ...LINK } },
    { reservationNumber: "OV", room: "K.203", checkInDate: "2026-10-14", checkOutDate: "2026-10-20", isBlackout: true },
  ];

  it("a linked extension under another name moves together with the main stay", () => {
    const out = planForUnallocated(COMPANY, "S", "2026-10-01");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.moves.map((m) => [m.reservationNumber, m.to])).toEqual([["X1", "K.203"], ["X2", "K.203"]]);
    expect(verifyPlan(COMPANY, DELUXE_G, out.plan, "2026-10-01")).toBeNull();
  });

  it("verifyPlan refuses to split a linked stay even when the names differ", () => {
    const split: ReallocPlan = {
      feasible: true,
      placements: [{ reservationNumber: "S", room: "K.202" }],
      moves: [{ reservationNumber: "X2", from: "K.202", to: "K.203" }],
      assignment: {},
    };
    expect(verifyPlan(COMPANY, DELUXE_G, split, "2026-10-01")).toMatch(/splits Acme s\.r\.o\.'s stay/);
  });

  it("'not the same guest' lets the resolver treat two same-name bookings apart", () => {
    // Two different people called Jan Novák, back-to-back in K.202; the first
    // is staying. S (Oct 9→12) fits only K.202 (K.203 is blacked out on the
    // 11th), so the second Jan must make way to K.203. Chained by name, the
    // pair would be pinned whole and S couldn't be placed.
    const base: ResRef[] = [
      { reservationNumber: "S", room: "1KK Deluxe Studios", checkInDate: "2026-10-09", checkOutDate: "2026-10-12", isUnallocatedVR: true, firstName: "New", lastName: "Guest" },
      { reservationNumber: "J1", room: "K.202", checkInDate: "2026-10-05", checkOutDate: "2026-10-09", firstName: "Jan", lastName: "Novák" },
      { reservationNumber: "J2", room: "K.202", checkInDate: "2026-10-09", checkOutDate: "2026-10-11", firstName: "Jan", lastName: "Novák" },
      { reservationNumber: "B", room: "K.203", checkInDate: "2026-10-11", checkOutDate: "2026-10-12", isBlackout: true },
    ];
    const chained = planForUnallocated(base, "S", "2026-10-06");
    if ("error" in chained) throw new Error(chained.error);
    expect(chained.plan.feasible).toBe(false);

    const apart = base.map((r) => (r.reservationNumber === "J2" ? { ...r, stayLinkRejected: ["J1"] } : r));
    expect(buildGroupInputs(apart, DELUXE_G, "2026-10-06").find((i) => i.reservationNumber === "J2")?.members).toBeUndefined();
    const out = planForUnallocated(apart, "S", "2026-10-06");
    if ("error" in out) throw new Error(out.error);
    expect(out.plan.feasible).toBe(true);
    expect(out.plan.moves.map((m) => [m.reservationNumber, m.to])).toEqual([["J2", "K.203"]]);
    expect(out.plan.placements[0].room).toBe("K.202");
    expect(verifyPlan(apart, DELUXE_G, out.plan, "2026-10-06")).toBeNull();
  });
});
