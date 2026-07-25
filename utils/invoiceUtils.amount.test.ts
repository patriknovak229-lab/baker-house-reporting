import { describe, it, expect } from "vitest";
import { buildInvoiceHTML } from "./invoiceUtils";
import { formatCurrency } from "./formatters";
import type { Reservation, InvoiceData, InvoiceModification } from "@/types/reservation";

// Minimal shapes — buildInvoiceHTML only reads these fields.
const res = {
  price: 25000,
  room: "K.201",
  firstName: "Jan",
  lastName: "Novák",
  numberOfNights: 4,
  numberOfGuests: 2,
  checkInDate: "2026-08-01",
  checkOutDate: "2026-08-05",
  reservationNumber: "BH-1",
} as unknown as Reservation;

const invoiceData = {
  companyName: "ACME s.r.o.",
  companyAddress: "Street 1, Brno",
  ico: "12345678",
  vatNumber: "",
} as unknown as InvoiceData;

const baseMod = {
  id: "m1",
  dateRanges: [{ from: "2026-08-01", to: "2026-08-05" }],
  numberOfNights: 4,
  numberOfGuests: 2,
  room: "K.201",
  createdAt: "2026-07-24T00:00:00.000Z",
};

describe("buildInvoiceHTML invoice-amount override", () => {
  it("uses the booking price when there is no modification", () => {
    const html = buildInvoiceHTML(res, invoiceData, "INV-1", undefined, true);
    expect(html).toContain(formatCurrency(25000));
  });

  it("uses the booking price when a modification has no amount", () => {
    const mod = { ...baseMod } as InvoiceModification;
    const html = buildInvoiceHTML(res, invoiceData, "INV-1", undefined, true, mod);
    expect(html).toContain(formatCurrency(25000));
  });

  it("shows the overridden amount and never renders the booking price", () => {
    const mod = { ...baseMod, amount: 9999 } as InvoiceModification;
    const html = buildInvoiceHTML(res, invoiceData, "INV-1", undefined, true, mod);
    expect(html).toContain(formatCurrency(9999)); // Total + single line item
    // Self-contained: the booking price must not leak anywhere on the invoice.
    expect(html).not.toContain(formatCurrency(25000));
  });

  it("distributes a multi-range override so the line items still sum to it", () => {
    const mod = {
      ...baseMod,
      amount: 10000,
      dateRanges: [
        { from: "2026-08-01", to: "2026-08-03" },
        { from: "2026-08-03", to: "2026-08-05" },
      ],
      numberOfNights: 4,
    } as InvoiceModification;
    const html = buildInvoiceHTML(res, invoiceData, "INV-1", undefined, true, mod);
    expect(html).toContain(formatCurrency(10000)); // Total row
    expect(html).not.toContain(formatCurrency(25000));
  });
});
