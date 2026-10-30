import { describe, it, expect } from "vitest";
import { opsTasksFromIssues, opsTasksByBooking, buildOpsTasksMap } from "./opsTasksPublish";
import type { Issue, IssueCategory } from "../types/reservation";

function issue(over: Partial<Issue> & { category: IssueCategory }): Issue {
  return {
    id: over.id ?? "1",
    text: over.text ?? "restock the minibar",
    actionableDate: over.actionableDate ?? "2026-09-11",
    resolved: over.resolved ?? false,
    createdAt: "2026-09-07T10:00:00Z",
    ...over,
  };
}

describe("opsTasksFromIssues", () => {
  it("publishes an unresolved cleaner-facing room task", () => {
    expect(opsTasksFromIssues([issue({ category: "special", timing: "after" })])).toEqual([
      { id: "1", text: "restock the minibar", timing: "after", date: "2026-09-11" },
    ]);
  });

  it("treats a legacy task with no timing as prep — a welcome gift was the original use", () => {
    expect(opsTasksFromIssues([issue({ category: "special" })])[0].timing).toBe("prep");
  });

  it("drops a resolved task, which is how a cleaner's chip disappears", () => {
    expect(opsTasksFromIssues([issue({ category: "special", resolved: true })])).toEqual([]);
  });

  it("publishes NOTHING but `special` — facility and admin work never reach a cleaner", () => {
    const others: IssueCategory[] = [
      "facility",
      "problem",
      "repair",
      "invoice",
      "cleaning",
      "earlyCheckin",
      "lateCheckout",
    ];
    for (const category of others) {
      expect(opsTasksFromIssues([issue({ category })])).toEqual([]);
    }
  });

  it("drops an empty note — there would be nothing for the cleaner to read", () => {
    expect(opsTasksFromIssues([issue({ category: "special", text: "   " })])).toEqual([]);
  });

  it("trims the note", () => {
    expect(opsTasksFromIssues([issue({ category: "special", text: "  extra towels " })])[0].text).toBe(
      "extra towels",
    );
  });

  it("handles a reservation with no issues at all", () => {
    expect(opsTasksFromIssues(undefined)).toEqual([]);
    expect(opsTasksFromIssues([])).toEqual([]);
  });
});

describe("buildOpsTasksMap", () => {
  const overrides = {
    "BH-1": { issues: [issue({ id: "a", category: "special" })] },
    "BH-2": { issues: [issue({ id: "b", category: "problem" })] },
    "BH-3": { issues: [issue({ id: "c", category: "special", resolved: true })] },
    "BH-4": { issues: [issue({ id: "d", category: "special" })] },
  };
  const live = (...ns: string[]) => ns.map((reservationNumber) => ({ reservationNumber }));

  it("keeps only reservations with a publishable task", () => {
    const map = buildOpsTasksMap(overrides, live("BH-1", "BH-2", "BH-3", "BH-4"));
    expect(Object.keys(map)).toEqual(["BH-1", "BH-4"]);
  });

  it("skips reservations the caller leaves out — cancelled, or out of the synced window", () => {
    const map = buildOpsTasksMap(overrides, live("BH-1", "BH-2", "BH-3"));
    expect(Object.keys(map)).toEqual(["BH-1"]);
  });

  it("returns an empty map rather than undefined entries", () => {
    expect(buildOpsTasksMap({}, live("BH-1"))).toEqual({});
  });

  it("does not publish a reservation's tasks twice when it is listed twice", () => {
    const map = buildOpsTasksMap(overrides, live("BH-1", "BH-1"));
    expect(map["BH-1"]).toHaveLength(1);
  });
});

// BH-93698209: K.102 is the master's own apartment, O.308 is BH-93698210 and
// K.103 is BH-93698211. The cleaning app keys each cleaning by its own booking.
describe("multi-apartment reservations", () => {
  const trio = {
    reservationNumber: "BH-93698209",
    apartmentReservationNumbers: ["BH-93698209", "BH-93698210", "BH-93698211"],
  };

  it("sends a task with no apartment picked to every apartment", () => {
    const map = opsTasksByBooking(trio, [issue({ id: "a", category: "special" })]);
    expect(Object.keys(map)).toEqual(["BH-93698209", "BH-93698210", "BH-93698211"]);
  });

  it("sends a task for one apartment to that apartment only", () => {
    const map = opsTasksByBooking(trio, [
      issue({ id: "a", category: "special", apartment: "BH-93698210", text: "extra towels" }),
    ]);
    expect(map).toEqual({
      "BH-93698210": [{ id: "a", text: "extra towels", timing: "prep", date: "2026-09-11" }],
    });
  });

  it("keeps each apartment's own tasks apart in the whole map", () => {
    const map = buildOpsTasksMap(
      {
        "BH-93698209": {
          issues: [
            issue({ id: "a", category: "special", apartment: "BH-93698211" }),
            issue({ id: "b", category: "special" }),
          ],
        },
      },
      [trio],
    );
    expect(map["BH-93698209"].map((t) => t.id)).toEqual(["b"]);
    expect(map["BH-93698210"].map((t) => t.id)).toEqual(["b"]);
    expect(map["BH-93698211"].map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("a single-apartment reservation keeps its own number", () => {
    const map = opsTasksByBooking({ reservationNumber: "BH-1" }, [issue({ category: "special" })]);
    expect(Object.keys(map)).toEqual(["BH-1"]);
  });

  it("a wrapper booking's tasks go to the apartment Beds24 put it in, not the wrapper", () => {
    const map = opsTasksByBooking(
      { reservationNumber: "BH-500", apartmentReservationNumbers: ["BH-501"] },
      [issue({ category: "special" })],
    );
    expect(Object.keys(map)).toEqual(["BH-501"]);
  });
});
