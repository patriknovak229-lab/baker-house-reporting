import { describe, it, expect } from "vitest";
import { buildInvoiceHTML, resolvePaymentChannel, effectivePaymentStatus } from "./invoiceUtils";
import { formatCurrency } from "./formatters";
import type { Reservation, InvoiceData } from "@/types/reservation";

// Minimal shapes — buildInvoiceHTML only reads these fields.
const base = {
  price: 25000,
  amountPaid: 25000,
  room: "K.201",
  firstName: "Jan",
  lastName: "Novák",
  numberOfNights: 4,
  numberOfGuests: 2,
  checkInDate: "2026-08-01",
  checkOutDate: "2026-08-05",
  reservationNumber: "BH-1",
  channel: "Direct-Web",
  paymentStatus: "Paid",
  paymentStatusOverride: null,
} as unknown as Reservation;

const invoiceData = {
  companyName: "ACME s.r.o.",
  companyAddress: "Street 1, Brno",
  ico: "12345678",
  vatNumber: "",
} as unknown as InvoiceData;

const html = (res: Partial<Reservation>) =>
  buildInvoiceHTML({ ...base, ...res } as Reservation, invoiceData, "INV-1", undefined, true);

describe("invoice status band — payment status", () => {
  it("states the reservation is paid", () => {
    expect(html({})).toContain("UHRAZENO / PAID");
  });

  it("honours a manual payment-status override over the derived value", () => {
    expect(effectivePaymentStatus({ ...base, paymentStatusOverride: "Unpaid" } as Reservation)).toBe("Unpaid");
    expect(html({ paymentStatusOverride: "Unpaid" })).toContain("NEUHRAZENO / UNPAID");
  });

  it("shows the outstanding balance on a partially paid booking", () => {
    const out = html({ paymentStatus: "Partially Paid", amountPaid: 10000 });
    expect(out).toContain("ČÁSTEČNĚ UHRAZENO / PARTIALLY PAID");
    expect(out).toContain(`Outstanding: ${formatCurrency(15000)}`);
  });
});

describe("invoice status band — payment channel", () => {
  it("names Stripe for rental-site bookings", () => {
    expect(html({})).toContain("Paid via Stripe payment gateway");
  });

  it("names Stripe for a phone booking settled through a payment link", () => {
    const res = {
      channel: "Direct-Phone",
      additionalPayments: [{ id: "cs_1", status: "paid" }],
    } as unknown as Partial<Reservation>;
    expect(html(res)).toContain("Paid via Stripe payment gateway");
  });

  it("names the OTA that collected the money", () => {
    expect(html({ channel: "Booking.com" })).toContain("Paid via Booking.com");
    expect(html({ channel: "Airbnb" })).toContain("Paid via Airbnb");
  });

  it("says nothing about the method when it cannot be determined", () => {
    expect(resolvePaymentChannel({ ...base, channel: "Direct" } as Reservation)).toBeNull();
    expect(html({ channel: "Direct" })).not.toContain("Paid via");
  });

  it("does not claim a payment method on an unpaid invoice", () => {
    expect(html({ paymentStatus: "Unpaid", amountPaid: 0 })).not.toContain("Paid via");
  });
});

describe("invoice status band — booking validity", () => {
  it("states the reservation is confirmed and valid", () => {
    expect(html({})).toContain("This reservation is confirmed and valid.");
  });

  it("says cancelled instead when the booking is cancelled", () => {
    const out = html({ isCancelled: true });
    expect(out).toContain("This reservation has been cancelled.");
    expect(out).not.toContain("confirmed and valid");
  });
});
