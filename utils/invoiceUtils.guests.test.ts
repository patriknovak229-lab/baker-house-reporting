import { describe, it, expect } from "vitest";
import { buildInvoiceHTML, invoiceGuestNames } from "./invoiceUtils";
import type { Reservation, InvoiceData, InvoiceModification } from "@/types/reservation";

const res = {
  price: 6110,
  amountPaid: 0,
  room: "K.103",
  firstName: "Tomáš",
  lastName: "Dvořák",
  numberOfNights: 2,
  numberOfGuests: 2,
  checkInDate: "2026-11-08",
  checkOutDate: "2026-11-10",
  reservationNumber: "BH-95000001",
  channel: "Direct-Phone",
  paymentStatus: "Unpaid",
  paymentStatusOverride: null,
} as unknown as Reservation;

const invoiceData: InvoiceData = {
  companyName: "Acme s.r.o.",
  companyAddress: "Street 1, Brno",
  ico: "12345678",
  vatNumber: "",
  billingEmail: "billing@acme.cz",
};

describe("invoiceGuestNames", () => {
  it("is the lead guest alone when nobody else is recorded", () => {
    expect(invoiceGuestNames(res)).toBe("Tomáš Dvořák");
  });

  it("lists the additional guests after the lead guest", () => {
    expect(invoiceGuestNames({ ...res, additionalGuests: ["Jana Nováková", "Petr Novák"] })).toBe(
      "Tomáš Dvořák, Jana Nováková, Petr Novák",
    );
  });

  it("skips an empty lead name instead of printing a leading comma", () => {
    expect(invoiceGuestNames({ ...res, firstName: "", lastName: "", additionalGuests: ["Jana"] })).toBe("Jana");
  });
});

describe("invoice line item names every guest", () => {
  it("prints both names on the default line", () => {
    const html = buildInvoiceHTML(
      { ...res, additionalGuests: ["Jana Nováková"] },
      invoiceData,
      "INV-95000001",
      undefined,
      true,
    );
    expect(html).toContain("Tomáš Dvořák, Jana Nováková");
  });

  it("still lets a modification's guest name override the default", () => {
    const mod: InvoiceModification = {
      id: "m1",
      dateRanges: [{ from: "2026-11-08", to: "2026-11-10" }],
      numberOfNights: 2,
      numberOfGuests: 2,
      room: "K.103",
      guestName: "Only Tomáš",
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    const html = buildInvoiceHTML(
      { ...res, additionalGuests: ["Jana Nováková"] },
      invoiceData,
      "INV-95000001",
      undefined,
      true,
      mod,
    );
    expect(html).toContain("Only Tomáš");
    expect(html).not.toContain("Jana Nováková");
  });
});
