import type { AdditionalPayment } from "./additionalPayment";
import type { Voucher } from "./voucher";
import type { SplitPayment } from "./splitPayment";

export type Channel = "Booking.com" | "Airbnb" | "Direct" | "Direct-Phone" | "Direct-Web";
// Physical room name (e.g. "K.201") or combined for package bookings (e.g. "K.202 + K.203")
export type Room = string;
export type CleaningStatus = "Pending" | "In Progress" | "Completed";
export type PaymentStatus = "Unpaid" | "Partially Paid" | "Paid" | "Refunded";
export type CustomerFlag =
  | "Repeat Customer"
  | "High Value Customer"
  | "Problematic Customer"
  | "VIP Customer";
export type RatingStatus = "none" | "good" | "bad";
export type InvoiceStatus = "Not Issued" | "Issued" | "Sent";

export type IssueCategory =
  | "problem"   // General problem/issue — red !
  | "invoice"   // Send invoice task — amber envelope
  | "cleaning"  // Mid-stay cleaning task — blue sparkles
  | "special";  // Special treatment / VIP — purple gift

export interface Issue {
  id: string;              // timestamp-based unique ID
  category?: IssueCategory; // defaults to "problem" when absent (backwards compat)
  text: string;            // free text description
  actionableDate: string;  // ISO date YYYY-MM-DD — when the issue becomes actionable
  resolved: boolean;
  createdAt: string;       // ISO timestamp
}

export interface InvoiceData {
  companyName: string;
  companyAddress: string;
  ico: string;
  vatNumber: string;
  billingEmail: string;
}

export interface InvoiceDateRange {
  from: string; // YYYY-MM-DD
  to: string;   // YYYY-MM-DD
}

/** A display-only invoice variant — never changes stored reservation or Beds24 data. */
export interface InvoiceModification {
  id: string;
  dateRanges: InvoiceDateRange[];
  numberOfNights: number;
  numberOfGuests: number;
  room: string;
  /** Override the guest name shown on the invoice (overrides "{firstName} {lastName}" on the line items). */
  guestName?: string;
  /** Override the line-item description (defaults to "Ubytování / Accommodation"). */
  lineDescription?: string;
  createdAt: string; // ISO timestamp
}

export interface Reservation {
  // From Beds24 (read-only)
  reservationNumber: string;
  // Set when this reservation spans multiple physical rooms (package/virtual room booking).
  // Each entry is a physical room name. Used by performance views to split revenue per room.
  linkedRooms?: string[];
  firstName: string;
  lastName: string;
  channel: Channel;
  room: Room;
  checkInDate: string; // ISO date
  checkOutDate: string; // ISO date
  reservationDate: string;    // ISO date (YYYY-MM-DD) — used for display/sort
  bookingTimestamp: string;   // Full ISO datetime from Beds24 bookingTime — used for "New" badge
  numberOfNights: number;
  numberOfGuests: number;
  email: string;
  phone: string;
  price: number; // CZK
  nationality: string; // 2-letter ISO country code

  // From cleaning app (read-only)
  cleaningStatus: CleaningStatus;

  // From Stripe (read-only)
  paymentStatus: PaymentStatus;
  amountPaid: number; // CZK

  // From Beds24 — channel fee breakdown (read-only)
  commissionAmount: number;    // OTA/channel commission in CZK (Booking.com, Airbnb)
  paymentChargeAmount: number; // Payment processing fee in CZK

  // Locally managed (editable)
  additionalEmail: string; // guest-provided email (Beds24 email is usually OTA conduit)
  paymentStatusOverride: PaymentStatus | null; // manual override; null = use derived value
  notes: string;
  // Flag overrides: true = force on, false = force off, missing key = follow auto rule
  manualFlagOverrides: Partial<Record<CustomerFlag, boolean>>;
  ratingStatus: RatingStatus;
  invoiceData: InvoiceData | null;
  invoiceStatus: InvoiceStatus;
  includeQR?: boolean;   // true = QR payment code was included; Revenue section will track this
  issues?: Issue[]; // locally managed task/issue log; undefined = no issues
  additionalPayments?: AdditionalPayment[]; // Stripe payment links created for this reservation
  splitPayments?: SplitPayment[]; // scheduled future payments (cron-emailed when sendDate ≤ today)
  vouchers?: Voucher[]; // discount vouchers linked to this reservation
  parkingOverride?: string; // undefined = auto rules, "none" = no parking, "152"/"153"/etc = manual space
  invoiceModifications?: InvoiceModification[]; // display-only invoice variants; never touches Beds24
}
