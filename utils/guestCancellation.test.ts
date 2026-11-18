import { describe, expect, it } from "vitest";
import {
  allocateRefund,
  buildCancellationEmailHTML,
  czkText,
  emailRefundFor,
  isDirectChannel,
  planRefund,
  refundLines,
  refundTaskText,
  type PaymentPicture,
} from "./guestCancellation";

const stripe: PaymentPicture = { method: "stripe", refundableCzk: 14151 };
const invoice: PaymentPicture = { method: "invoice", paidCzk: 9000 };

describe("planRefund — Stripe", () => {
  it("full refunds everything still refundable, automatically", () => {
    expect(planRefund({ mode: "full", amountCzk: null, payment: stripe })).toEqual({ kind: "stripe", amountCzk: 14151 });
  });

  it("full respects refunds already made (only the rest is refundable)", () => {
    expect(planRefund({ mode: "full", amountCzk: null, payment: { method: "stripe", refundableCzk: 4151 } }))
      .toEqual({ kind: "stripe", amountCzk: 4151 });
  });

  it("partial refunds the typed amount", () => {
    expect(planRefund({ mode: "partial", amountCzk: 5000, payment: stripe })).toEqual({ kind: "stripe", amountCzk: 5000 });
  });

  it("partial can never exceed what Stripe can still refund", () => {
    expect(planRefund({ mode: "partial", amountCzk: 14152, payment: stripe })).toHaveProperty("error");
  });

  it("nothing left to refund → only policy is possible", () => {
    const empty: PaymentPicture = { method: "stripe", refundableCzk: 0 };
    expect(planRefund({ mode: "full", amountCzk: null, payment: empty })).toHaveProperty("error");
    expect(planRefund({ mode: "policy", amountCzk: null, payment: empty })).toEqual({ kind: "policyTask" });
  });

  it("policy never refunds automatically", () => {
    expect(planRefund({ mode: "policy", amountCzk: 5000, payment: stripe })).toEqual({ kind: "policyTask" });
  });
});

describe("planRefund — invoice (bank)", () => {
  it("full → bank task for everything paid", () => {
    expect(planRefund({ mode: "full", amountCzk: null, payment: invoice })).toEqual({ kind: "bankTask", amountCzk: 9000 });
  });

  it("partial → bank task carrying the amount", () => {
    expect(planRefund({ mode: "partial", amountCzk: 2500.5, payment: invoice })).toEqual({ kind: "bankTask", amountCzk: 2500.5 });
  });

  it("can't refund more than was paid, or anything on an unpaid booking", () => {
    expect(planRefund({ mode: "partial", amountCzk: 9001, payment: invoice })).toHaveProperty("error");
    expect(planRefund({ mode: "full", amountCzk: null, payment: { method: "invoice", paidCzk: 0 } })).toHaveProperty("error");
  });

  it("policy → policy task", () => {
    expect(planRefund({ mode: "policy", amountCzk: null, payment: invoice })).toEqual({ kind: "policyTask" });
  });
});

describe("planRefund — bad amounts", () => {
  it("refuses a missing, zero, negative or non-numeric partial amount", () => {
    for (const amountCzk of [null, 0, -5, Number.NaN]) {
      expect(planRefund({ mode: "partial", amountCzk, payment: stripe })).toHaveProperty("error");
    }
  });
});

describe("allocateRefund", () => {
  const sources = [
    { id: "web", refundableCzk: 10000 },
    { id: "link1", refundableCzk: 3000 },
  ];
  it("fills the website checkout first, then payment links", () => {
    expect(allocateRefund(12000, sources)).toEqual([
      { id: "web", amountCzk: 10000 },
      { id: "link1", amountCzk: 2000 },
    ]);
  });
  it("skips exhausted payments", () => {
    expect(allocateRefund(500, [{ id: "web", refundableCzk: 0 }, ...sources.slice(1)])).toEqual([{ id: "link1", amountCzk: 500 }]);
  });
  it("refuses more than all payments together", () => {
    expect(allocateRefund(13001, sources)).toHaveProperty("error");
  });
});

describe("guest email + task", () => {
  it("Stripe refund: processed; bank refund: being processed; policy: property rules", () => {
    expect(refundLines(emailRefundFor({ kind: "stripe", amountCzk: 14151 })).en)
      .toBe(`A refund of ${czkText(14151)} has been processed.`);
    expect(refundLines(emailRefundFor({ kind: "bankTask", amountCzk: 9000 })).en)
      .toBe(`A refund of ${czkText(9000)} is being processed.`);
    expect(refundLines(emailRefundFor({ kind: "policyTask" })).en).toMatch(/as per the property rules/);
  });

  it("task text names the amount for bank refunds and the policy otherwise", () => {
    const b = { reservationNumber: "BH-1", guest: "Peter Reguli", room: "K.201", checkInDate: "2026-11-26", checkOutDate: "2026-11-29", method: "invoice" as const };
    expect(refundTaskText({ kind: "bankTask", amountCzk: 9000 }, b)).toContain(czkText(9000));
    expect(refundTaskText({ kind: "policyTask" }, b)).toMatch(/^Refund as per property policy/);
  });

  it("escapes guest-supplied names", () => {
    const html = buildCancellationEmailHTML({
      firstName: "<script>",
      lastName: "x",
      reservationNumber: "BH-1",
      room: "K.202",
      checkInDate: "2026-11-26",
      checkOutDate: "2026-11-29",
      refund: { kind: "policy" },
    });
    expect(html).not.toContain("<script>");
  });
});

describe("isDirectChannel", () => {
  it("covers the three direct channels only", () => {
    expect(["Direct", "Direct-Phone", "Direct-Web"].every(isDirectChannel)).toBe(true);
    expect(isDirectChannel("Booking.com")).toBe(false);
    expect(isDirectChannel("Airbnb")).toBe(false);
  });
});
