import { describe, it, expect } from "vitest";
import {
  combineKinds,
  eachDay,
  overrideByDay,
  parseRestrictionId,
  planRestrictionClear,
  planRestrictionWrite,
  restrictionId,
  restrictionRuns,
  restrictionsForRoom,
  unitForRoomId,
  RESTRICTION_ROOM_IDS,
} from "./stayRestrictions";

describe("eachDay", () => {
  it("includes both ends, crossing a month boundary", () => {
    expect(eachDay("2026-12-30", "2027-01-02")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
      "2027-01-02",
    ]);
  });
  it("is a single day when from === to, and empty when reversed", () => {
    expect(eachDay("2027-01-13", "2027-01-13")).toEqual(["2027-01-13"]);
    expect(eachDay("2027-01-14", "2027-01-13")).toEqual([]);
  });
});

describe("overrideByDay", () => {
  it("expands ranged and per-day entries, treating a missing override as none", () => {
    const byDay = overrideByDay([
      { from: "2027-01-12", to: "2027-01-12", override: "none" },
      { from: "2027-01-13", to: "2027-01-14", override: "noCheckOut" },
      { from: "2027-01-15", override: null },
    ]);
    expect(byDay).toEqual({
      "2027-01-12": "none",
      "2027-01-13": "noCheckOut",
      "2027-01-14": "noCheckOut",
      "2027-01-15": "none",
    });
  });
});

describe("restrictionRuns", () => {
  it("coalesces consecutive same-kind days and splits on a change or a gap", () => {
    const runs = restrictionRuns({
      "2026-12-24": "noCheckOut",
      "2026-12-25": "noCheckOut",
      "2026-12-26": "noCheckInOrCheckOut",
      "2026-12-27": "none",
      "2026-12-28": "noCheckOut",
      "2026-12-29": "blackout",
    });
    expect(runs).toEqual([
      { kind: "noCheckOut", from: "2026-12-24", to: "2026-12-25" },
      { kind: "noCheckInOrCheckOut", from: "2026-12-26", to: "2026-12-26" },
      { kind: "noCheckOut", from: "2026-12-28", to: "2026-12-28" },
    ]);
  });
});

describe("restrictionsForRoom", () => {
  const byDay = { "2027-01-13": "noCheckOut" };

  it("draws a virtual-room restriction on every unit of the type, as effective", () => {
    const [r] = restrictionsForRoom(679714, byDay);
    expect(r.rooms).toEqual(["K.102", "K.103", "K.106"]);
    expect(r.unitKey).toBe("urban");
    expect(r.effective).toBe(true);
    expect(r.id).toBe("RS-679714-noCheckOut-2027-01-13-2027-01-13");
  });

  it("flags one set on a single physical unit of a virtual room as NOT effective", () => {
    // Beds24 quotes the virtual room, so K.202's own restriction stops no sale.
    const [r] = restrictionsForRoom(648596, byDay);
    expect(r.rooms).toEqual(["K.202"]);
    expect(r.unitKey).toBe("deluxe1kk");
    expect(r.effective).toBe(false);
  });

  it("treats the standalone apartments as their own sold room", () => {
    const [r] = restrictionsForRoom(656437, byDay);
    expect(r.rooms).toEqual(["K.201"]);
    expect(r.effective).toBe(true);
  });

  it("ignores rooms outside the property map", () => {
    expect(restrictionsForRoom(648620, byDay)).toEqual([]);
  });
});

describe("room map", () => {
  it("resolves both the sold room and its units to the same unit", () => {
    expect(unitForRoomId(648816)?.key).toBe("deluxe1kk");
    expect(unitForRoomId(648772)?.key).toBe("deluxe1kk");
    expect(unitForRoomId(123)).toBeNull();
  });
  it("reads the 4 sold rooms plus the 5 physical units behind the virtual ones", () => {
    expect([...RESTRICTION_ROOM_IDS].sort()).toEqual(
      [648596, 648772, 648816, 656437, 674672, 679703, 679704, 679705, 679714].sort(),
    );
  });
});

describe("restriction ids", () => {
  it("round-trips", () => {
    const id = restrictionId(648816, "noCheckInOrCheckOut", "2026-12-24", "2026-12-26");
    expect(parseRestrictionId(id)).toEqual({
      roomId: 648816,
      kind: "noCheckInOrCheckOut",
      from: "2026-12-24",
      to: "2026-12-26",
    });
  });
  it("rejects blackout ids, unknown kinds and reversed ranges", () => {
    expect(parseRestrictionId("OV-656437-2027-01-13-2027-01-13")).toBeNull();
    expect(parseRestrictionId("RS-656437-blackout-2027-01-13-2027-01-13")).toBeNull();
    expect(parseRestrictionId("RS-656437-noCheckOut-2027-01-14-2027-01-13")).toBeNull();
  });
});

describe("combineKinds", () => {
  it("never weakens an existing restriction", () => {
    expect(combineKinds(null, "noCheckOut")).toBe("noCheckOut");
    expect(combineKinds("noCheckOut", "noCheckOut")).toBe("noCheckOut");
    expect(combineKinds("noCheckIn", "noCheckOut")).toBe("noCheckInOrCheckOut");
    expect(combineKinds("noCheckInOrCheckOut", "noCheckIn")).toBe("noCheckInOrCheckOut");
  });
});

describe("planRestrictionWrite", () => {
  it("writes one range over free days", () => {
    const plan = planRestrictionWrite({}, "2026-12-24", "2026-12-26", "noCheckOut");
    expect(plan.writes).toEqual([{ from: "2026-12-24", to: "2026-12-26", override: "noCheckOut" }]);
    expect(plan.conflicts).toEqual([]);
  });

  it("refuses to write anything when a day is blacked out (it would re-open the room)", () => {
    const plan = planRestrictionWrite(
      { "2026-12-25": "blackout" },
      "2026-12-24",
      "2026-12-26",
      "noCheckOut",
    );
    expect(plan.writes).toEqual([]);
    expect(plan.conflicts).toEqual([{ date: "2026-12-25", override: "blackout" }]);
  });

  it("combines with a different existing restriction and skips days already covered", () => {
    const plan = planRestrictionWrite(
      {
        "2026-12-24": "noCheckIn",
        "2026-12-25": "noCheckOut",
        "2026-12-26": "noCheckInOrCheckOut",
        "2026-12-27": "none",
      },
      "2026-12-24",
      "2026-12-27",
      "noCheckOut",
    );
    expect(plan.writes).toEqual([
      { from: "2026-12-24", to: "2026-12-24", override: "noCheckInOrCheckOut" },
      { from: "2026-12-27", to: "2026-12-27", override: "noCheckOut" },
    ]);
    expect(plan.merged).toEqual(["2026-12-24"]);
    expect(plan.unchanged).toEqual(["2026-12-25", "2026-12-26"]);
  });
});

describe("planRestrictionClear", () => {
  it("clears only days still carrying exactly that restriction", () => {
    const ranges = planRestrictionClear(
      {
        "2026-12-24": "noCheckOut",
        "2026-12-25": "blackout", // set since the calendar was read: leave it
        "2026-12-26": "noCheckOut",
        "2026-12-27": "noCheckOut",
      },
      "2026-12-24",
      "2026-12-27",
      "noCheckOut",
    );
    expect(ranges).toEqual([
      { from: "2026-12-24", to: "2026-12-24" },
      { from: "2026-12-26", to: "2026-12-27" },
    ]);
  });
});
