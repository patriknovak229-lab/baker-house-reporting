import { describe, it, expect } from "vitest";
import { invoiceAutoSendBlocker } from "./invoiceAutoSendRules";

// This predicate exists to tell the operator, on the pending-tasks row,
// whether an invoice is going out by itself. It is only useful if it agrees
// with the cron's skip ladder exactly — so the cases below are that ladder,
// in order.

const TODAY = "2026-10-25";

const ok = {
  invoiceStatus: "Not Issued",
  taskDate: TODAY,
  todayYmd: TODAY,
  ico: "",
  vatNumber: "HR5945198034",
  billingEmail: "jsarinic@ffzg.hr",
};

describe("invoiceAutoSendBlocker", () => {
  it("clears a complete, due, live invoice", () => {
    expect(invoiceAutoSendBlocker(ok)).toBeNull();
  });

  it("clears a foreign company with VAT but no IČO", () => {
    // The whole reason the Croatian and German invoices in the Oct 2026 queue
    // auto-send at all; a Czech-IČO-only rule used to strand them.
    expect(invoiceAutoSendBlocker({ ...ok, ico: "", vatNumber: "DE253326376" })).toBeNull();
    expect(invoiceAutoSendBlocker({ ...ok, ico: "19876107", vatNumber: "" })).toBeNull();
  });

  it("clears a task dated in the future — scheduled, not blocked", () => {
    expect(invoiceAutoSendBlocker({ ...ok, taskDate: "2026-10-31" })).toBeNull();
  });

  it("reports an invoice that already went out", () => {
    expect(invoiceAutoSendBlocker({ ...ok, invoiceStatus: "Sent" })).toBe("sent");
  });

  it("reports one the operator has generated", () => {
    expect(invoiceAutoSendBlocker({ ...ok, invoiceStatus: "Issued" })).toBe("issued");
  });

  it("reports a hold on the amount", () => {
    expect(invoiceAutoSendBlocker({ ...ok, held: true })).toBe("held");
  });

  it("reports a split booking", () => {
    expect(invoiceAutoSendBlocker({ ...ok, splitCount: 2 })).toBe("split");
  });

  it("reports a checkout past the ~6-month window", () => {
    expect(invoiceAutoSendBlocker({ ...ok, taskDate: "2026-01-01" })).toBe("too-old");
  });

  it("reports a cancelled or blacked-out booking", () => {
    expect(invoiceAutoSendBlocker({ ...ok, isCancelled: true })).toBe("not-live");
    expect(invoiceAutoSendBlocker({ ...ok, isBlackout: true })).toBe("not-live");
  });

  it("reports missing details", () => {
    expect(invoiceAutoSendBlocker({ ...ok, ico: "", vatNumber: "" })).toBe("incomplete");
    expect(invoiceAutoSendBlocker({ ...ok, billingEmail: "" })).toBe("incomplete");
    expect(invoiceAutoSendBlocker({ ...ok, billingEmail: "   " })).toBe("incomplete");
  });

  it("keeps the cron's precedence when several blockers apply", () => {
    // Sent wins over everything: the cron closes the task and never looks
    // further down the ladder.
    expect(
      invoiceAutoSendBlocker({ ...ok, invoiceStatus: "Sent", held: true, splitCount: 2, billingEmail: "" }),
    ).toBe("sent");
    // Held is checked before split and before completeness.
    expect(invoiceAutoSendBlocker({ ...ok, held: true, splitCount: 2, billingEmail: "" })).toBe("held");
    // Age is checked before liveness and completeness.
    expect(
      invoiceAutoSendBlocker({ ...ok, taskDate: "2026-01-01", isCancelled: true, billingEmail: "" }),
    ).toBe("too-old");
  });
});
