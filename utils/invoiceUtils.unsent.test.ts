import { describe, it, expect } from "vitest";
import { unsentInvoices } from "./invoiceUtils";
import type { Reservation, Issue } from "@/types/reservation";
import type { InvoiceRequest } from "@/types/invoiceRequest";

const TODAY = "2026-09-19";

const task = (over: Partial<Issue> = {}): Issue => ({
  id: "t1",
  category: "invoice",
  text: "Send invoice",
  actionableDate: "2026-09-10",
  resolved: false,
  createdAt: "",
  ...over,
});

const request = (over: Partial<InvoiceRequest> = {}): InvoiceRequest => ({
  id: "ir1",
  reservationNumber: "BH-1",
  beds24MessageId: 1,
  rawMessage: "faktura prosím",
  companyName: "Acme s.r.o.",
  companyAddress: null,
  ico: "19876107",
  dic: "CZ19876107",
  email: "fakturace@acme.cz",
  detectedAt: "2026-09-05T00:00:00.000Z",
  status: "auto-completed",
  ...over,
});

const res = (over: Partial<Reservation> = {}): Reservation =>
  ({
    reservationNumber: "BH-1",
    firstName: "Jan",
    lastName: "Novák",
    checkOutDate: "2026-09-10",
    invoiceStatus: "Not Issued",
    isCancelled: false,
    issues: [task()],
    ...over,
  }) as Reservation;

describe("unsentInvoices", () => {
  it("surfaces a past stay with an open invoice task", () => {
    const rows = unsentInvoices([res()], TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].daysOverdue).toBe(9);
    expect(rows[0].awaitingGuest).toBe(false);
  });

  it("drops it once the invoice is sent", () => {
    expect(unsentInvoices([res({ invoiceStatus: "Sent" })], TODAY)).toEqual([]);
  });

  it("keeps an Issued-but-not-emailed invoice — generated is not sent", () => {
    expect(unsentInvoices([res({ invoiceStatus: "Issued" })], TODAY)).toHaveLength(1);
  });

  it("ignores stays that haven't ended yet", () => {
    expect(unsentInvoices([res({ checkOutDate: "2026-09-25" })], TODAY)).toEqual([]);
    // Checkout today: the cron's own run still has the day to do it.
    expect(unsentInvoices([res({ checkOutDate: TODAY })], TODAY)).toEqual([]);
  });

  it("ignores cancelled bookings and resolved tasks", () => {
    expect(unsentInvoices([res({ isCancelled: true })], TODAY)).toEqual([]);
    expect(unsentInvoices([res({ issues: [task({ resolved: true })] })], TODAY)).toEqual([]);
  });

  it("ignores a past stay nobody asked to be invoiced for", () => {
    expect(unsentInvoices([res({ issues: [] })], TODAY)).toEqual([]);
  });

  it("catches a request stuck at awaiting-info, where no task was ever created", () => {
    const rows = unsentInvoices(
      [res({ issues: [], invoiceRequests: [request({ status: "awaiting-info", email: null })] })],
      TODAY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].awaitingGuest).toBe(true);
    expect(rows[0].missing).toEqual(["email"]);
  });

  it("respects a rejected request — the operator already said no invoice", () => {
    expect(
      unsentInvoices([res({ issues: [], invoiceRequests: [request({ status: "rejected" })] })], TODAY),
    ).toEqual([]);
  });

  it("reports nothing missing when a send would have everything", () => {
    const rows = unsentInvoices(
      [
        res({
          invoiceData: {
            companyName: "Acme s.r.o.",
            companyAddress: "",
            ico: "19876107",
            vatNumber: "",
            billingEmail: "fakturace@acme.cz",
          },
        }),
      ],
      TODAY,
    );
    expect(rows[0].missing).toEqual([]);
  });

  it("prefers saved invoice details over the collected ones", () => {
    // Saved details have the email; the request never captured one. A send
    // would succeed, so nothing should be reported as missing.
    const rows = unsentInvoices(
      [
        res({
          invoiceRequests: [request({ email: null })],
          invoiceData: {
            companyName: "Acme s.r.o.",
            companyAddress: "",
            ico: "19876107",
            vatNumber: "",
            billingEmail: "saved@acme.cz",
          },
        }),
      ],
      TODAY,
    );
    expect(rows[0].missing).toEqual([]);
  });

  it("falls back to collected details when nothing was saved", () => {
    const rows = unsentInvoices(
      [res({ invoiceRequests: [request({ companyName: null, ico: null, dic: null })] })],
      TODAY,
    );
    expect(rows[0].missing).toEqual(["companyName", "companyId"]);
  });

  it("sorts oldest checkout first", () => {
    const rows = unsentInvoices(
      [
        res({ reservationNumber: "BH-new", checkOutDate: "2026-09-15" }),
        res({ reservationNumber: "BH-old", checkOutDate: "2026-07-01" }),
      ],
      TODAY,
    );
    expect(rows.map((r) => r.reservation.reservationNumber)).toEqual(["BH-old", "BH-new"]);
  });
});
