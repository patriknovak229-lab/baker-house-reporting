import { describe, expect, it } from "vitest";
import { isUnfinishedCheckout } from "./unfinishedCheckout";

const WINDOW = 30 * 60 * 1000;
// BH-95080626 as Beds24 returned it, 43 s after it was written.
const created = "2026-10-22T13:11:20Z";
const now = new Date("2026-10-22T13:12:03Z").getTime();

describe("isUnfinishedCheckout", () => {
  it("flags a just-written cancelled booking with no cancelTime (BH-95080626)", () => {
    expect(isUnfinishedCheckout({ status: "cancelled", cancelTime: null, bookingTime: created }, now, WINDOW)).toBe(true);
  });

  it("keeps a real cancellation (cancelTime set) as a cancellation", () => {
    expect(
      isUnfinishedCheckout({ status: "cancelled", cancelTime: "2026-10-22T13:12:00Z", bookingTime: created }, now, WINDOW),
    ).toBe(false);
  });

  it("ignores old bookings with a missing cancelTime", () => {
    expect(
      isUnfinishedCheckout({ status: "cancelled", cancelTime: null, bookingTime: "2026-08-19T07:01:40Z" }, now, WINDOW),
    ).toBe(false);
  });

  it("ignores live bookings", () => {
    expect(isUnfinishedCheckout({ status: "confirmed", bookingTime: created }, now, WINDOW)).toBe(false);
    expect(isUnfinishedCheckout({ status: "new", bookingTime: created }, now, WINDOW)).toBe(false);
  });
});
