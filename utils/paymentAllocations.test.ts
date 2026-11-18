import { describe, expect, it } from "vitest";
import type { AdditionalPayment } from "@/types/additionalPayment";
import {
  allocationsError,
  feeFor,
  netPaidFor,
  netPaidOnBooking,
  paymentsCovering,
  reservationsOf,
  shareFor,
} from "./paymentAllocations";

const base = (over: Partial<AdditionalPayment> = {}): AdditionalPayment => ({
  id: "cs_1",
  reservationNumber: "BH-1",
  description: "x",
  amountCzk: 12_000,
  status: "paid",
  createdAt: "2026-11-18T09:00:00Z",
  ...over,
});

const combined = (over: Partial<AdditionalPayment> = {}) =>
  base({
    allocations: [
      { reservationNumber: "BH-1", amountCzk: 8_000 },
      { reservationNumber: "BH-2", amountCzk: 4_000 },
    ],
    ...over,
  });

describe("single-booking payments behave as before", () => {
  it("belongs wholly to its booking", () => {
    const p = base({ stripeFeeCzk: 300 });
    expect(reservationsOf(p)).toEqual(["BH-1"]);
    expect(shareFor(p, "BH-1")).toBe(1);
    expect(shareFor(p, "BH-2")).toBe(0);
    expect(netPaidFor(p, "BH-1")).toBe(12_000);
    expect(feeFor(p, "BH-1")).toBe(300);
  });

  it("unpaid counts nothing", () => {
    expect(netPaidFor(base({ status: "unpaid" }), "BH-1")).toBe(0);
  });
});

describe("combined payments split per booking", () => {
  it("splits paid amount and fee by share", () => {
    const p = combined({ stripeFeeCzk: 300 });
    expect(netPaidFor(p, "BH-1")).toBe(8_000);
    expect(netPaidFor(p, "BH-2")).toBe(4_000);
    expect(feeFor(p, "BH-1")).toBe(200);
    expect(feeFor(p, "BH-2")).toBe(100);
  });

  it("spreads refunds pro rata", () => {
    const p = combined({
      status: "partially-refunded",
      refunds: [{ id: "re_1", amountCzk: 3_000, refundedAt: "2026-11-19T00:00:00Z", status: "succeeded" }],
    });
    expect(netPaidFor(p, "BH-1")).toBe(6_000);
    expect(netPaidFor(p, "BH-2")).toBe(3_000);
  });

  it("takes a refund tagged to one booking off that booking only", () => {
    const p = combined({
      status: "partially-refunded",
      refunds: [{ id: "re_1", amountCzk: 4_000, refundedAt: "2026-11-19T00:00:00Z", status: "succeeded", reservationNumber: "BH-2" }],
    });
    expect(netPaidFor(p, "BH-1")).toBe(8_000);
    expect(netPaidFor(p, "BH-2")).toBe(0);
  });

  it("is found on every booking it covers", () => {
    const all = [combined(), base({ id: "cs_2", reservationNumber: "BH-3", amountCzk: 500 })];
    expect(paymentsCovering(all, "BH-2").map((p) => p.id)).toEqual(["cs_1"]);
    expect(netPaidOnBooking(all, "BH-2")).toBe(4_000);
    expect(netPaidOnBooking(all, "BH-3")).toBe(500);
  });
});

describe("allocationsError", () => {
  it("accepts two distinct bookings", () => {
    expect(allocationsError([{ reservationNumber: "BH-1", amountCzk: 1 }, { reservationNumber: "BH-2", amountCzk: 2 }])).toBeNull();
  });
  it("rejects one booking, duplicates and zero amounts", () => {
    expect(allocationsError([{ reservationNumber: "BH-1", amountCzk: 1 }])).toMatch(/two/);
    expect(allocationsError([{ reservationNumber: "BH-1", amountCzk: 1 }, { reservationNumber: "BH-1", amountCzk: 1 }])).toMatch(/twice/);
    expect(allocationsError([{ reservationNumber: "BH-1", amountCzk: 1 }, { reservationNumber: "BH-2", amountCzk: 0 }])).toMatch(/at least/);
  });
});
