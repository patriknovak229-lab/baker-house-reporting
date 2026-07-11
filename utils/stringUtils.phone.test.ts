import { describe, it, expect } from "vitest";
import { formatPhoneDisplay, phoneDigits } from "./stringUtils";

describe("formatPhoneDisplay", () => {
  it("groups a spaced-CC number and preserves the authored country code", () => {
    expect(formatPhoneDisplay("+49 1578 4996550")).toBe("+49 1578 4996 550");
    expect(formatPhoneDisplay("+420 602 655 625")).toBe("+420 602 655 625");
    expect(formatPhoneDisplay("+44 7731 449780")).toBe("+44 7731 449 780");
  });

  it("splits a country code even when the number has no separator", () => {
    expect(formatPhoneDisplay("+4915778939731")).toBe("+49 1577 8939 731");
    expect(formatPhoneDisplay("+36309931560")).toBe("+36 309 931 560");
    expect(formatPhoneDisplay("+420603379933")).toBe("+420 603 379 933");
    expect(formatPhoneDisplay("+593420777812757")).toBe("+593 420 777 812 757");
  });

  it("handles numbers without a leading +", () => {
    expect(formatPhoneDisplay("420792508714")).toBe("420 792 508 714");
  });

  it("leaves non-phone junk untouched", () => {
    expect(formatPhoneDisplay("Test")).toBe("Test");
    expect(formatPhoneDisplay("")).toBe("");
    expect(formatPhoneDisplay(null)).toBe("");
  });

  it("never leaves a lone trailing digit", () => {
    for (let len = 5; len <= 15; len++) {
      const digits = "1".repeat(len);
      const groups = formatPhoneDisplay(digits).split(" ");
      // Every group is 2–4 digits (2 only for the unavoidable n=5 → 3+2 case)
      for (const g of groups) {
        expect(g.length).toBeGreaterThanOrEqual(2);
        expect(g.length).toBeLessThanOrEqual(4);
      }
      expect(groups.join("")).toBe(digits);
    }
  });
});

describe("phoneDigits", () => {
  it("strips everything but digits", () => {
    expect(phoneDigits("+49 1577 8939731")).toBe("4915778939731");
    expect(phoneDigits("1577-89")).toBe("157789");
    expect(phoneDigits(null)).toBe("");
  });
});
