import type { AdditionalPayment } from "./additionalPayment";
import type { Voucher } from "./voucher";
import type { SplitPayment } from "./splitPayment";
import type { InvoiceRequest } from "./invoiceRequest";
import type { EmailSendLogEntry } from "./emailSendLog";

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

/** Where a guest rating came from. "booking"/"airbnb" are synced from Beds24's
 *  review endpoints; "manual" is operator-entered (the ad-hoc fallback for
 *  channels Beds24 can't supply — Google, Direct — or before a review lands). */
export type RatingSource = "booking" | "airbnb" | "manual";

/**
 * A numeric guest rating with its native scale preserved. Booking.com reviews
 * are out of 10, Airbnb out of 5 — we keep the original scale rather than
 * normalising, and display "9.2/10" / "5/5" with channel context.
 */
export interface GuestRating {
  score: number;                 // native score, e.g. 9.2 or 5
  scale: 5 | 10;                 // native max for the source channel
  source: RatingSource;
  channel?: Channel | "Google";  // which channel it reflects (esp. for manual entries)
  reviewText?: string;           // optional, when the endpoint returns it
  reviewDate?: string;           // ISO date, optional
}

/**
 * Rate plan a booking was made under. Booking.com offers all five; Airbnb only
 * has Non-Refundable / Standard (its length-of-stay discounts are applied to
 * the Standard rate, not separate plans). Direct bookings carry no channel rate
 * plan. Detection is best-effort from Beds24 signals — see utils/rateType.ts.
 */
export type RateType =
  | "Non-Refundable"
  | "Standard"
  | "Flexi"
  | "One-Night"
  | "Weekly";

export type IssueCategory =
  | "problem"        // General problem/issue — red !
  | "invoice"        // Send invoice task — amber envelope
  | "cleaning"       // Mid-stay cleaning task — blue sparkles
  | "special"        // Special treatment / VIP — purple gift
  | "earlyCheckin"   // Guest-requested early check-in — teal clock ↑ (PENDING decision, not approved)
  | "lateCheckout";  // Guest-requested late checkout — orange clock ↓ (PENDING decision, not approved)

export interface Issue {
  id: string;              // timestamp-based unique ID
  category?: IssueCategory; // defaults to "problem" when absent (backwards compat)
  text: string;            // free text description
  actionableDate: string;  // ISO date YYYY-MM-DD — when the issue becomes actionable
  resolved: boolean;
  createdAt: string;       // ISO timestamp
}

/**
 * A frozen snapshot of a booking's user-visible fields, used as the
 * baseline for "what changed?" diff display on past-stay modifications.
 * Captured client-side at acknowledgment time and persisted under
 * `baker:reservation-overrides`. Only includes fields the operator
 * cares about for cross-channel re-import drift — not every booking
 * column.
 */
export interface BookingSnapshot {
  capturedAt: string;       // ISO timestamp — when snapshot was taken
  checkInDate: string;      // YYYY-MM-DD
  checkOutDate: string;     // YYYY-MM-DD
  numberOfNights: number;
  numberOfGuests: number;
  price: number;            // CZK
  room: string;             // physical or virtual label
  channel: string;          // Channel string
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
  /**
   * True when this is a Beds24 "blackout" (status="black") — a room block
   * created by the operator to close the room without representing a paying
   * guest. Blackouts skip payment/invoice/cleaning/performance pipelines and
   * are rendered with a simplified row + drawer.
   */
  isBlackout?: boolean;
  /** Operator email captured at blackout-creation time (parsed from comments). */
  blackoutCreatedBy?: string;
  /** Free-text reason ("Renovation", "Owner stay", etc.) — also from comments. */
  blackoutReason?: string;
  /**
   * True when this reservation sits on a virtual room (e.g. 1KK Urban Studios
   * VR 679714, 1KK Deluxe Twin VR 648816) WITHOUT a physical-room allocation.
   * Happens when Beds24 cannot auto-allocate because no single physical
   * room is free for the full stay — operator must manually assign in
   * Beds24's calendar. Rendered with a "Room unassigned" badge in the
   * reservation list and surfaces as a pending task in the alert bar.
   */
  isUnallocatedVR?: boolean;
  /**
   * ISO timestamp from Beds24's `modifiedTime` field — last time any
   * booking field changed on Beds24's side. Used to detect channel
   * re-imports that overwrite operator changes after a stay has
   * completed (`modifiedAt > checkOutDate` ⇒ post-stay modification
   * worth flagging for operator review).
   */
  modifiedAt?: string;
  /**
   * ISO timestamp of when the operator last acknowledged a post-stay
   * modification on this reservation. Stored locally in Redis under
   * `baker:reservation-overrides`. Used to filter the "past-stay
   * changes" task pill — entries with `modifiedAt > postStayAcknowledgedAt`
   * remain unacked and keep showing.
   */
  postStayAcknowledgedAt?: string;
  /**
   * Booking state captured at the moment the operator last acknowledged
   * a past-stay modification. Compared against current Beds24 state to
   * show "what changed since you last looked at this booking" — e.g.
   * `checkOutDate: 2026-05-30 → 2026-06-01`. Beds24 doesn't expose
   * history so this self-snapshot is the only way to surface diffs.
   */
  postStaySnapshot?: BookingSnapshot;
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

  /**
   * Rate plan detected from Beds24 (read-only, best-effort). null/undefined =
   * could not be detected. Only populated for current+future OTA stays (no
   * backfill — see utils/rateType.ts isRateTypeInScope). Long Booking.com stays
   * are the expected miss: Beds24 truncates the source field past a char limit.
   */
  rateType?: RateType | null;

  // Locally managed (editable)
  additionalEmail: string; // guest-provided email (Beds24 email is usually OTA conduit)
  paymentStatusOverride: PaymentStatus | null; // manual override; null = use derived value
  notes: string;
  // Flag overrides: true = force on, false = force off, missing key = follow auto rule
  manualFlagOverrides: Partial<Record<CustomerFlag, boolean>>;
  ratingStatus: RatingStatus;
  /**
   * Guest review score synced from Beds24 (Booking.com / Airbnb). Server-supplied
   * on every bookings sync — NOT stored in the Redis overrides map. Takes
   * precedence over `manualRating` when present. null/undefined = no synced review.
   */
  syncedRating?: GuestRating | null;
  /**
   * Operator-entered rating — the ad-hoc fallback for channels Beds24 can't supply
   * (Google, Direct) or before a synced review arrives. Persisted in Redis
   * overrides. Only drives the smiley/value when there is no `syncedRating`.
   */
  manualRating?: GuestRating | null;
  /** Manual rate-plan override; null/undefined = use the detected `rateType`. */
  rateTypeOverride?: RateType | null;
  invoiceData: InvoiceData | null;
  invoiceStatus: InvoiceStatus;
  includeQR?: boolean;   // true = QR payment code was included; Revenue section will track this
  issues?: Issue[]; // locally managed task/issue log; undefined = no issues
  additionalPayments?: AdditionalPayment[]; // Stripe payment links created for this reservation
  splitPayments?: SplitPayment[]; // scheduled future payments (cron-emailed when sendDate ≤ today)
  vouchers?: Voucher[]; // discount vouchers linked to this reservation
  parkingOverride?: string; // undefined = auto rules, "none" = no parking, "152"/"153"/etc = manual space
  invoiceModifications?: InvoiceModification[]; // display-only invoice variants; never touches Beds24
  invoiceRequests?: InvoiceRequest[]; // auto-detected invoice requests from Booking.com guest messages
  emailSendLog?: EmailSendLogEntry[]; // template emails sent via "Email Guest" — append-only audit trail
  /**
   * Reservation numbers of OTHER reservations that occupy the same room on
   * overlapping dates. Populated server-side after the bookings sync. Means
   * the room appears double-booked in the dashboard — usually a stale cache
   * issue from a cancel-then-rebook that didn't propagate, but the operator
   * should always verify on Beds24. Empty/undefined = no conflict.
   */
  overlapWith?: string[];
}
