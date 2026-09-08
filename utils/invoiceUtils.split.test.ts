import { describe, it, expect } from "vitest";
import {
  buildInvoiceHTML,
  splitInvoiceNumber,
  splitTotals,
  revenueInvoiceId,
} from "./invoiceUtils";
import { formatCurrency } from "./formatters";
import type { Reservation, InvoiceData, InvoiceSplit } from "@/types/reservation";

const res = {
  price: 27000,
  amountPaid: 27000,
  room: "K.202",
  firstName: "Abhi",
  lastName: "Singla",
  numberOfNights: 15,
  numberOfGuests: 2,
  checkInDate: "2026-09-12",
  checkOutDate: "2026-09-27",
  reservationNumber: "BH-92538626",
  channel: "Direct-Web",
  paymentStatus: "Paid",
  paymentStatusOverride: null,
} as unknown as Reservation;

const invoiceData = {
  companyName: "Acme s.r.o.",
  companyAddress: "Street 1, Brno",
  ico: "12345678",
  vatNumber: "",
} as unknown as InvoiceData;

const split = (over: Partial<InvoiceSplit> = {}): InvoiceSplit => ({
  id: "s1",
  seq: 1,
  invoiceData,
  amountCzk: 9000,
  createdAt: "2026-09-08T00:00:00.000Z",
  ...over,
});

describe("split invoice numbering", () => {
  it("suffixes the booking's invoice number with the stable seq", () => {
    expect(splitInvoiceNumber("BH-92538626", 1)).toBe("INV-92538626-1");
    expect(splitInvoiceNumber("BH-92538626", 2)).toBe("INV-92538626-2");
  });

  it("keeps revenue-invoice ids distinct per split", () => {
    expect(revenueInvoiceId("BH-1")).toBe("rev-BH-1");
    expect(revenueInvoiceId("BH-1", 2)).toBe("rev-BH-1-2");
  });
});

describe("splitTotals", () => {
  it("reports what is left uninvoiced", () => {
    const t = splitTotals(27000, [split({ amountCzk: 10000 }), split({ id: "s2", seq: 2, amountCzk: 12000 })]);
    expect(t.allocated).toBe(22000);
    expect(t.remaining).toBe(5000);
    expect(t.over).toBe(false);
  });

  it("flags a set that bills more than the booking", () => {
    const t = splitTotals(27000, [split({ amountCzk: 20000 }), split({ id: "s2", seq: 2, amountCzk: 10000 })]);
    expect(t.over).toBe(true);
    expect(t.remaining).toBe(-3000);
  });

  it("tolerates 1 Kč of rounding on an even split of an odd price", () => {
    // 27001 split in two rounds to 13501 + 13500 = 27001, and 13501 + 13501 = 27002.
    expect(splitTotals(27001, [split({ amountCzk: 13501 }), split({ id: "s2", seq: 2, amountCzk: 13501 })]).over).toBe(false);
  });

  it("treats no splits as nothing allocated", () => {
    expect(splitTotals(27000, undefined)).toEqual({ allocated: 0, remaining: 27000, over: false });
  });
});

describe("buildInvoiceHTML with a split's amount", () => {
  const render = (opts: Parameters<typeof buildInvoiceHTML>[6]) =>
    buildInvoiceHTML(res, invoiceData, "INV-92538626-1", undefined, true, undefined, opts);

  it("bills the split amount and never the booking price", () => {
    const html = render({ amountOverride: 9000 });
    expect(html).toContain(formatCurrency(9000));
    expect(html).not.toContain(formatCurrency(27000));
  });

  it("prices the nights from the split, not the booking", () => {
    const html = render({ amountOverride: 9000 });
    expect(html).toContain(formatCurrency(600)); // 9000 / 15 nights
    expect(html).not.toContain(formatCurrency(1800)); // 27000 / 15
  });

  it("reads as a standalone invoice — nothing marks it as part of a split", () => {
    const html = render({ amountOverride: 9000 });
    for (const marker of ["Dílčí", "Part 1", "of 2", "split", "Split"]) {
      expect(html).not.toContain(marker);
    }
    // ...and it is still a complete invoice for the party receiving it.
    expect(html).toContain("Acme s.r.o.");
    expect(html).toContain("Celkem / Total");
  });

  it("uses the split's own guest name on the line item", () => {
    expect(render({ amountOverride: 9000, guestName: "Jan Novák" })).toContain("Jan Novák");
  });

  it("falls back to the booking guest when the split has no name", () => {
    expect(render({ amountOverride: 9000 })).toContain("Abhi Singla");
  });

  it("does not quote a booking-level outstanding balance on a part-invoice", () => {
    const partly = { ...res, paymentStatus: "Partially Paid", amountPaid: 10000 } as Reservation;
    const html = buildInvoiceHTML(partly, invoiceData, "INV-1-1", undefined, true, undefined, { amountOverride: 9000 });
    expect(html).not.toContain("Outstanding");
  });

  it("leaves the whole-booking invoice untouched when no split is passed", () => {
    const html = buildInvoiceHTML(res, invoiceData, "INV-92538626", undefined, true);
    expect(html).toContain(formatCurrency(27000));
  });
});
