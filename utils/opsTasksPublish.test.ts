import { describe, it, expect } from "vitest";
import { opsTasksFromIssues, buildOpsTasksMap } from "./opsTasksPublish";
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

  it("keeps only reservations with a publishable task", () => {
    const map = buildOpsTasksMap(overrides, () => true);
    expect(Object.keys(map)).toEqual(["BH-1", "BH-4"]);
  });

  it("skips reservations the caller rules out — cancelled, or out of the synced window", () => {
    const map = buildOpsTasksMap(overrides, (rn) => rn !== "BH-4");
    expect(Object.keys(map)).toEqual(["BH-1"]);
  });

  it("returns an empty map rather than undefined entries", () => {
    expect(buildOpsTasksMap({}, () => true)).toEqual({});
  });
});
