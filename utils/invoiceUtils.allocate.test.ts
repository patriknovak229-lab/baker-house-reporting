import { describe, it, expect } from "vitest";
import { allocateCzk, roundHaler } from "./invoiceUtils";

/** Sum without letting binary float drift masquerade as a rounding bug. */
const sum = (xs: number[]) => roundHaler(xs.reduce((a, b) => a + b, 0));
/** Every amount must be statable on an invoice: whole haléře, no 0.3333. */
const allWholeHaler = (xs: number[]) => xs.every((x) => Math.abs(x * 100 - Math.round(x * 100)) < 1e-6);

describe("allocateCzk", () => {
  it("returns one amount per weight", () => {
    expect(allocateCzk(900, [2, 1])).toHaveLength(2);
    expect(allocateCzk(100, [])).toEqual([]);
  });

  it("divides in proportion to the weights", () => {
    expect(allocateCzk(900, [2, 1])).toEqual([600, 300]);
    expect(allocateCzk(1500, [1, 1, 1])).toEqual([500, 500, 500]);
  });

  it("sums to the total exactly when the division is not clean", () => {
    const parts = allocateCzk(100, [1, 1, 1]); // 33.333… each
    expect(sum(parts)).toBe(100);
    expect(allWholeHaler(parts)).toBe(true);
  });

  it("handles a price that already carries haléře", () => {
    const parts = allocateCzk(3687.67, [1, 1]);
    expect(sum(parts)).toBe(3687.67);
    expect(allWholeHaler(parts)).toBe(true);
  });

  it("keeps the line items summing to the invoice total across uneven nights", () => {
    const parts = allocateCzk(27521.6, [4, 11]); // a 15-night stay, split 4 + 11
    expect(sum(parts)).toBe(27521.6);
    expect(allWholeHaler(parts)).toBe(true);
  });

  it("spreads at most one haléř of correction per part", () => {
    const total = 100;
    const parts = allocateCzk(total, [1, 1, 1, 1, 1, 1, 1]);
    const fair = total / parts.length;
    expect(sum(parts)).toBe(total);
    for (const p of parts) expect(Math.abs(p - fair)).toBeLessThanOrEqual(0.01);
  });

  it("divides evenly when every weight is zero", () => {
    const parts = allocateCzk(90, [0, 0, 0]);
    expect(sum(parts)).toBe(90);
    expect(parts).toEqual([30, 30, 30]);
  });

  it("handles a zero total", () => {
    expect(allocateCzk(0, [1, 1])).toEqual([0, 0]);
  });
});

describe("roundHaler", () => {
  it("rounds to two decimals", () => {
    expect(roundHaler(13760.599999999999)).toBe(13760.6);
    expect(roundHaler(1834.7733)).toBe(1834.77);
  });
});
