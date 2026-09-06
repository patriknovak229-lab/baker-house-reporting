import { describe, it, expect } from "vitest";
import { planShortening, describeShortening, nightsLabel } from "./stayShorten";

// The live case this was built for: BH-92628122, 2026-09-10 → 2026-09-13,
// guest asks to drop one night.
const STAY = { arrival: "2026-09-10", departure: "2026-09-13" };
const TODAY = "2026-09-06";

function plan(next: { arrival: string; departure: string }, today = TODAY) {
  return planShortening(STAY, next, { today });
}

describe("planShortening", () => {
  it("trims a night off the end", () => {
    const res = plan({ arrival: "2026-09-10", departure: "2026-09-12" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.nightsBefore).toBe(3);
    expect(res.plan.nightsAfter).toBe(2);
    expect(res.plan.nightsRemovedBack).toBe(1);
    expect(res.plan.nightsRemovedFront).toBe(0);
    expect(res.plan.nightsRemoved).toBe(1);
  });

  it("trims a night off the start", () => {
    const res = plan({ arrival: "2026-09-11", departure: "2026-09-13" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.nightsRemovedFront).toBe(1);
    expect(res.plan.nightsRemovedBack).toBe(0);
    expect(res.plan.nightsAfter).toBe(2);
  });

  it("trims both ends at once", () => {
    const res = planShortening(
      { arrival: "2026-09-10", departure: "2026-09-15" },
      { arrival: "2026-09-11", departure: "2026-09-14" },
      { today: TODAY },
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.plan.nightsRemoved).toBe(2);
    expect(res.plan.nightsAfter).toBe(3);
  });

  it("refuses to extend either end", () => {
    expect(plan({ arrival: "2026-09-09", departure: "2026-09-13" }).ok).toBe(false);
    expect(plan({ arrival: "2026-09-10", departure: "2026-09-14" }).ok).toBe(false);
  });

  it("refuses to leave zero nights", () => {
    const res = plan({ arrival: "2026-09-12", departure: "2026-09-12" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("non-arrival");
  });

  it("refuses a no-op", () => {
    const res = plan({ arrival: "2026-09-10", departure: "2026-09-13" });
    expect(res.ok).toBe(false);
  });

  it("rejects malformed dates", () => {
    expect(plan({ arrival: "10/09/2026", departure: "2026-09-12" }).ok).toBe(false);
    expect(plan({ arrival: "2026-09-10", departure: "2026-13-45" }).ok).toBe(false);
  });

  it("locks the check-in once the guest has arrived, but still lets them leave early", () => {
    const inHouseToday = "2026-09-11"; // arrival 09-10 is in the past
    const movedArrival = plan({ arrival: "2026-09-11", departure: "2026-09-13" }, inHouseToday);
    expect(movedArrival.ok).toBe(false);
    if (movedArrival.ok) return;
    expect(movedArrival.error).toContain("already started");

    const earlyDeparture = plan({ arrival: "2026-09-10", departure: "2026-09-12" }, inHouseToday);
    expect(earlyDeparture.ok).toBe(true);
  });

  it("treats an arrival on today as already started", () => {
    const res = plan({ arrival: "2026-09-11", departure: "2026-09-13" }, "2026-09-10");
    expect(res.ok).toBe(false);
  });
});

describe("describeShortening", () => {
  it("names which end was trimmed", () => {
    const res = plan({ arrival: "2026-09-10", departure: "2026-09-12" });
    if (!res.ok) throw new Error("expected a valid plan");
    expect(describeShortening(res.plan)).toBe("3 nights → 2 nights (1 night off the end)");
  });

  it("names both ends when both move", () => {
    const res = planShortening(
      { arrival: "2026-09-10", departure: "2026-09-15" },
      { arrival: "2026-09-11", departure: "2026-09-13" },
      { today: TODAY },
    );
    if (!res.ok) throw new Error("expected a valid plan");
    expect(describeShortening(res.plan)).toBe(
      "5 nights → 2 nights (1 night off the start, 2 nights off the end)",
    );
  });
});

describe("nightsLabel", () => {
  it("singularises one night", () => {
    expect(nightsLabel(1)).toBe("1 night");
    expect(nightsLabel(2)).toBe("2 nights");
  });
});
