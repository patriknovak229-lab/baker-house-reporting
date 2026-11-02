import { describe, expect, it } from "vitest";
import {
  appendWebBookingWarningIssue,
  buildWebBookingWarningIssue,
  parseWebBookingId,
} from "./webBookingWarning";

const NOW = "2026-11-02T10:12:35.000Z";

describe("parseWebBookingId", () => {
  it("accepts Beds24 ids as number or digit string", () => {
    expect(parseWebBookingId(95579179)).toBe("95579179");
    expect(parseWebBookingId(" 95579179 ")).toBe("95579179");
  });

  it("rejects anything that is not a plain booking id", () => {
    for (const raw of [undefined, null, "", "BH-95579179", "12", "9557917a", 1.5, {}]) {
      expect(parseWebBookingId(raw)).toBeNull();
    }
  });
});

describe("buildWebBookingWarningIssue", () => {
  it("is an open problem task due today, quoting Beds24's warning (BH-95579179)", () => {
    expect(buildWebBookingWarningIssue("95579179", "status: invalid value", "2026-11-02", NOW)).toEqual({
      id: "web-warning-95579179",
      category: "problem",
      text: 'Web booking saved with a Beds24 warning: "status: invalid value". The guest has their confirmation; check the booking in Beds24.',
      actionableDate: "2026-11-02",
      resolved: false,
      createdAt: NOW,
    });
  });

  it("keeps the warning to one short line", () => {
    const issue = buildWebBookingWarningIssue("1234567", `a\n\n${"x".repeat(500)}`, "2026-11-02", NOW);
    expect(issue.text).not.toContain("\n");
    expect(issue.text.length).toBeLessThan(420);
  });
});

describe("appendWebBookingWarningIssue", () => {
  const issue = buildWebBookingWarningIssue("95579179", "status: invalid value", "2026-11-02", NOW);

  it("adds the task next to existing ones", () => {
    const other = { ...issue, id: "manual-1", text: "wine" };
    expect(appendWebBookingWarningIssue([other], issue)).toEqual([other, issue]);
  });

  it("adds nothing when the booking already has the task, even resolved", () => {
    expect(appendWebBookingWarningIssue([{ ...issue, resolved: true }], issue)).toBeNull();
  });
});
