import { describe, expect, it } from "vitest";
import type { ScheduledPaymentLink } from "@/types/scheduledPaymentLink";
import { blockReason, nextStep, type BookingFacts } from "./scheduledPaymentLinks";

const link = (over: Partial<ScheduledPaymentLink> = {}): ScheduledPaymentLink => ({
  id: "spl_1",
  reservationNumber: "BH-1",
  allocations: [
    { reservationNumber: "BH-1", amountCzk: 8_000 },
    { reservationNumber: "BH-2", amountCzk: 4_000 },
  ],
  amountCzk: 12_000,
  description: "Stay",
  isMainPayment: true,
  sendDate: "2026-11-20",
  guestEmail: "guest@example.com",
  status: "scheduled",
  createdAt: "2026-11-18T10:00:00Z",
  ...over,
});

const facts = (over: Partial<BookingFacts>[] = []): BookingFacts[] => [
  { reservationNumber: "BH-1", found: true, cancelled: false, price: 8_000, paidCzk: 0, ...over[0] },
  { reservationNumber: "BH-2", found: true, cancelled: false, price: 4_000, paidCzk: 0, ...over[1] },
];

describe("blockReason (send-day checks)", () => {
  it("lets a fully unpaid stay at the scheduled amounts through", () => {
    expect(blockReason(link(), facts())).toBeNull();
  });
  it("tolerates 1 Kč haléř drift", () => {
    expect(blockReason(link(), facts([{ price: 8_000.6 }]))).toBeNull();
  });
  it("blocks a part-paid booking", () => {
    expect(blockReason(link(), facts([{}, { paidCzk: 500 }]))).toMatch(/BH-2/);
  });
  it("blocks when the booking total changed", () => {
    expect(blockReason(link(), facts([{ price: 9_000 }]))).toMatch(/BH-1/);
  });
  it("blocks a cancelled or missing booking, or an unknown price", () => {
    expect(blockReason(link(), facts([{ cancelled: true }]))).toMatch(/BH-1/);
    expect(blockReason(link(), facts([{}, { found: false }]))).toMatch(/BH-2/);
    expect(blockReason(link(), facts([{ price: null }]))).toMatch(/BH-1/);
  });
  it("blocks without a usable guest email", () => {
    expect(blockReason(link({ guestEmail: "" }), facts())).not.toBeNull();
    expect(blockReason(link({ guestEmail: "123.abc@guest.booking.com" }), facts())).not.toBeNull();
  });
});

describe("nextStep", () => {
  it("waits before the send date and sends on it", () => {
    expect(nextStep(link(), facts(), false, "2026-11-19").kind).toBe("wait");
    expect(nextStep(link(), facts(), false, "2026-11-20").kind).toBe("send");
    expect(nextStep(link({ sendDate: "2026-11-18" }), facts(), false, "2026-11-20").kind).toBe("send");
  });

  it("blocks on the send day when checks fail", () => {
    const step = nextStep(link(), facts([{ paidCzk: 8_000 }]), false, "2026-11-20");
    expect(step.kind).toBe("block");
  });

  it("reminds the next Prague day, not the same day", () => {
    const sent = link({ status: "sent", sentAt: "2026-11-20T09:00:00Z" });
    expect(nextStep(sent, facts(), false, "2026-11-20").kind).toBe("wait");
    expect(nextStep(sent, facts(), false, "2026-11-21").kind).toBe("remind");
  });

  it("does not remind when the situation changed meanwhile", () => {
    const sent = link({ status: "sent", sentAt: "2026-11-20T09:00:00Z" });
    const step = nextStep(sent, facts([{ cancelled: true }]), false, "2026-11-21");
    expect(step.kind).toBe("block");
  });

  it("goes overdue the day after an unpaid reminder", () => {
    const reminded = link({ status: "reminded", sentAt: "2026-11-20T09:00:00Z", reminderSentAt: "2026-11-21T09:00:00Z" });
    expect(nextStep(reminded, facts(), false, "2026-11-21").kind).toBe("wait");
    expect(nextStep(reminded, facts(), false, "2026-11-22").kind).toBe("overdue");
  });

  it("marks paid whenever the link was paid", () => {
    expect(nextStep(link({ status: "sent", sentAt: "2026-11-20T09:00:00Z" }), facts(), true, "2026-11-20").kind).toBe("mark-paid");
    expect(nextStep(link({ status: "reminded", reminderSentAt: "2026-11-21T09:00:00Z" }), facts(), true, "2026-11-25").kind).toBe("mark-paid");
  });

  it("leaves finished links alone", () => {
    for (const status of ["paid", "blocked", "unpaid", "failed", "cancelled"] as const) {
      expect(nextStep(link({ status }), facts(), false, "2026-11-30").kind).toBe("wait");
    }
  });
});
