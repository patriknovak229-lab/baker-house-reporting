import { describe, expect, it } from "vitest";
import {
  TEAM_ALL,
  addresseeLabel,
  authorLabel,
  isAddressedTo,
  isYmd,
  nameFromEmail,
  newlyOverdueTasks,
  overdueTasksTelegram,
  taskVisibleTo,
  validateTeamText,
  type GeneralTask,
  type TeamUser,
} from "./teamItems";

const users: TeamUser[] = [
  { email: "anna@bh.cz", name: "Anna K" },
  { email: "petr@bh.cz", name: "Petr" },
];

function task(over: Partial<GeneralTask> = {}): GeneralTask {
  return {
    id: "GT-1",
    assignee: TEAM_ALL,
    text: "Check the fire alarm",
    dueDate: "2026-11-02",
    createdBy: "anna@bh.cz",
    createdByName: "Anna K",
    createdAt: "2026-11-01T08:00:00.000Z",
    overdueNotifiedAt: null,
    ...over,
  };
}

describe("isAddressedTo", () => {
  it("matches 'all' and the recipient, case-insensitively", () => {
    expect(isAddressedTo(TEAM_ALL, "x@y.cz")).toBe(true);
    expect(isAddressedTo("Petr@BH.cz", "petr@bh.cz")).toBe(true);
    expect(isAddressedTo("anna@bh.cz", "petr@bh.cz")).toBe(false);
  });
});

describe("taskVisibleTo", () => {
  it("shows a delegated task to its author as well as its assignee", () => {
    const t = task({ assignee: "petr@bh.cz", createdBy: "anna@bh.cz" });
    expect(taskVisibleTo(t, "petr@bh.cz")).toBe(true);
    expect(taskVisibleTo(t, "anna@bh.cz")).toBe(true);
    expect(taskVisibleTo(t, "eva@bh.cz")).toBe(false);
  });
});

describe("labels", () => {
  it("prefers a known name, falls back to the email", () => {
    expect(addresseeLabel(TEAM_ALL, users)).toBe("All users");
    expect(addresseeLabel("petr@bh.cz", users)).toBe("Petr");
    expect(addresseeLabel("petr@bh.cz", users, "petr@bh.cz")).toBe("You");
    expect(addresseeLabel("jan.novy@bh.cz", users)).toBe("Jan Novy");
    expect(nameFromEmail("truthseeker.sro@gmail.com")).toBe("Truthseeker Sro");
  });

  it("uses the stored author name before the user list", () => {
    expect(authorLabel({ createdBy: "anna@bh.cz", createdByName: "Anna Kovářová" }, users)).toBe("Anna Kovářová");
    expect(authorLabel({ createdBy: "anna@bh.cz", createdByName: null }, users)).toBe("Anna K");
    expect(authorLabel({ createdBy: "anna@bh.cz", createdByName: null }, users, "anna@bh.cz")).toBe("You");
  });
});

describe("validation", () => {
  it("trims and rejects empty or oversized text", () => {
    expect(validateTeamText("  hi ")).toEqual({ text: "hi" });
    expect(validateTeamText("   ")).toHaveProperty("error");
    expect(validateTeamText(42)).toHaveProperty("error");
    expect(validateTeamText("x".repeat(2001))).toHaveProperty("error");
  });

  it("accepts only real YYYY-MM-DD dates", () => {
    expect(isYmd("2026-11-03")).toBe(true);
    expect(isYmd("2026-13-03")).toBe(false);
    expect(isYmd("3.11.2026")).toBe(false);
  });
});

describe("newlyOverdueTasks", () => {
  it("picks past-due tasks that were never announced — not today's, not already-alerted ones", () => {
    const tasks = [
      task({ id: "a", dueDate: "2026-11-02" }),
      task({ id: "b", dueDate: "2026-11-03" }),
      task({ id: "c", dueDate: "2026-10-30", overdueNotifiedAt: "2026-10-31T07:00:00Z" }),
    ];
    expect(newlyOverdueTasks(tasks, "2026-11-03").map((t) => t.id)).toEqual(["a"]);
  });
});

describe("overdueTasksTelegram", () => {
  it("escapes user text and names the assignee and author", () => {
    const msg = overdueTasksTelegram(
      [task({ text: "Fix <door> & lock", assignee: "petr@bh.cz", dueDate: "2026-11-01" })],
      users,
      "2026-11-03",
      (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    expect(msg).toContain("<b>Overdue task</b>");
    expect(msg).toContain("Fix &lt;door&gt; &amp; lock");
    expect(msg).toContain("Due 2026-11-01 (2d overdue) · for Petr · from Anna K");
  });
});
