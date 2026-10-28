import type { AdditionalPayment } from "./additionalPayment";
import type { Voucher } from "./voucher";
import type { SplitPayment } from "./splitPayment";
import type { InvoiceRequest } from "./invoiceRequest";
import type { EmailSendLogEntry } from "./emailSendLog";

// "Google" = Google Hotel Ads: the guest clicks through from Google and books on
// the Beds24 booking page (Beds24 apiSource "Google Ads"). Commission-free like
// the direct channels, paid through Beds24's Stripe gateway.
export type Channel = "Booking.com" | "Airbnb" | "Google" | "Direct" | "Direct-Phone" | "Direct-Web";
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
 * the Standard rate, not separate plans). Direct-Web and Direct-Phone both sell
 * the single direct rate and are always Standard; legacy Direct carries no rate
 * plan. Detection is best-effort from Beds24 signals — see utils/rateType.ts.
 */
export type RateType =
  | "Non-Refundable"
  | "Standard"
  | "Flexi"
  | "One-Night"
  | "Weekly";

/**
 * Split into two kinds by who acts on it (see CATEGORY_KIND in
 * ReservationDrawer): ADMIN falls on the operator, OPERATIONS is room-level
 * work. The cleaner-facing operations categories are the ones that reach the
 * cleaning app — `facility` deliberately does not (operator/facility manager
 * handles equipment themselves).
 */
export type IssueCategory =
  | "problem"        // General problem/issue — red !
  | "repair"         // Repair to organise — amber wrench. ADMIN: the operator books
                     //   the tradesperson. Distinct from `facility`, which is a room
                     //   task someone handles in passing.
  | "invoice"        // Send invoice task — amber envelope
  | "cleaning"       // Mid-stay cleaning task — blue sparkles
  | "special"        // Room task for the CLEANERS — purple ! (was "Special Treatment";
                     //   the generic ad-hoc request: restock minibar, extra towels,
                     //   leave a bottle of wine. Key kept so existing entries carry over.)
  | "facility"       // Room task for FACILITY/operator — slate ! (replace a wine opener,
                     //   equipment). Reporting-only; never published to cleaning.
  | "earlyCheckin"   // Guest-requested early check-in — teal clock ↑ (PENDING decision, not approved)
  | "lateCheckout";  // Guest-requested late checkout — orange clock ↓ (PENDING decision, not approved)

export interface Issue {
  id: string;              // timestamp-based unique ID
  category?: IssueCategory; // defaults to "problem" when absent (backwards compat)
  text: string;            // free text description
  actionableDate: string;  // ISO date YYYY-MM-DD — when the issue becomes actionable
  resolved: boolean;
  createdAt: string;       // ISO timestamp
  /**
   * WHEN in the stay a cleaner-facing room task must be done — the operator
   * picks it, because it decides which cleaning the task lands on:
   *   "prep"  → the cleaning that readies the room for this guest (physically
   *             the PREVIOUS booking's checkout clean, where this guest is the
   *             incoming one) — e.g. a welcome gift for a repeat customer.
   *   "after" → the next cleaning from now to the end of this stay: a mid-stay
   *             clean if one is still upcoming, otherwise the checkout clean.
   * Only meaningful for `special` (Room Task — cleaners); absent elsewhere.
   * Placement itself is Phase 2 (the cleaning app doesn't read this yet).
   */
  timing?: "prep" | "after";
  /**
   * Invoice tasks only: set when the send-due-invoices cron must leave this
   * invoice for the operator instead of auto-sending it. The value is the
   * human-readable reason, e.g. "guest asked for 3 509,41 Kč, booking price
   * 3 776,64 Kč" (a "Booking.com pays" discount Beds24 never sees). Absent =
   * auto-send allowed. Survives drawer saves because the UI passes task
   * objects through untouched.
   */
  holdAutoSend?: string;
  /**
   * Invoice tasks only: print the bank details + payment QR when the cron sends
   * it (and record the issued revenue invoice, as the drawer does when it sends
   * with the QR on). Set when the New Booking modal schedules an invoice with
   * "Include payment details". Absent = plain invoice, the cron's default.
   */
  includeQR?: boolean;
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
  /**
   * Override the invoice TOTAL in CZK — self-contained to this invoice variant.
   * When set, line-item prices are distributed to sum to this amount and the
   * Total row shows it. Purely display: NEVER changes the booking price
   * (`res.price`), payment status, or anything in Beds24. Absent = use res.price.
   */
  amount?: number;
  createdAt: string; // ISO timestamp
  /** ISO timestamp of the last successful email send of THIS version. */
  sentAt?: string;
  /** Address the last successful send went to. */
  sentTo?: string;
}

/**
 * One invoice in a split — a single booking billed to more than one party.
 * The case it exists for: two colleagues share an apartment and each needs
 * their own invoice to claim as an expense.
 *
 * Display + accounting only. A split NEVER changes the booking price, the
 * payment status, or anything in Beds24 — it only decides how the amount
 * already owed is presented across several documents.
 *
 * Persisted in `baker:reservation-overrides` alongside `invoiceModifications`.
 */
export interface InvoiceSplit {
  id: string;
  /**
   * Stable 1-based sequence behind the invoice number (`INV-<beds24Id>-<seq>`).
   * Assigned once at creation and never reused: deleting split 2 must not
   * renumber split 3 onto an invoice number that has already been sent.
   */
  seq: number;
  /** This invoice's own customer block — the whole point of splitting. */
  invoiceData: InvoiceData;
  /** This invoice's share of the booking, in CZK. */
  amountCzk: number;
  /** Name on the line item; falls back to the booking guest when empty. */
  guestName?: string;
  createdAt: string;   // ISO timestamp
  /** ISO timestamp of the last successful email send of THIS split. */
  sentAt?: string;
  /** Address the last successful send went to. */
  sentTo?: string;
}

/**
 * Non-arrival details, persisted in the `baker:reservation-overrides` map.
 * See the `nonArrival` field on Reservation.
 */
export interface NonArrival {
  flaggedAt: string;         // ISO timestamp when flagged
  flaggedBy: string;         // operator email
  reason?: string;           // optional free-text note
  originalPriceCzk: number;  // Beds24 price snapshot at flag time
}

/**
 * An off-channel refund the operator granted on a booking the CHANNEL still
 * bills in full — e.g. a goodwill discount paid back to a Booking.com guest
 * after a complaint.
 *
 * This exists because the reduction never reaches us any other way. Booking.com
 * keeps charging its commission on the ORIGINAL price and does not push the
 * refund back down the channel connection, so Beds24's `price` (and therefore
 * `Reservation.price`) still shows the full amount long after the money went
 * back — verified on BH-90387422, whose price and commission were unchanged
 * three days after a 2 500 Kč refund. Without this record the booking's
 * economics stay permanently overstated.
 *
 * Revenue treatment (see utils/reservationRevenue.ts): gross booking value
 * drops by the refunded amount, while commission and payment fees stay exactly
 * as the channel charged them — the same fee on a smaller base, which is what
 * makes the effective channel rate on a refunded booking higher. Net sales,
 * gross profit and the owner settlement all fall out of that automatically.
 * Persisted in `baker:reservation-overrides`.
 */
export interface PlatformRefund {
  /** Amount returned to the guest, in CZK. Always positive. */
  amountCzk: number;
  /** ISO date (YYYY-MM-DD) the money went back — operator-entered. */
  refundedAt: string;
  /** Free-text reason ("noisy neighbours", "late check-in"), optional. */
  reason?: string;
  /** ISO timestamp the flag was set. */
  flaggedAt: string;
  /** Operator email that set it. */
  flaggedBy: string;
  /**
   * Booking price at flag time. Used to pro-rate the refund when a package
   * booking is split across its rooms (`expandLinkedReservations`), the same
   * way `NonArrival.originalPriceCzk` is — and to spot the price drifting
   * underneath a recorded refund.
   */
  originalPriceCzk: number;
  /**
   * Stripe refunds of the booking's web checkout that are included in
   * `amountCzk` — written by `POST /api/stripe/web-payment/refund` (or /record
   * for one made in the Stripe Dashboard). Keyed by Stripe refund id so the
   * same refund can never be counted twice. Absent on refunds recorded by hand.
   */
  stripeRefunds?: PlatformRefundStripeEntry[];
}

/** One Stripe refund counted in a `PlatformRefund` — see `stripeRefunds`. */
export interface PlatformRefundStripeEntry {
  /** Stripe refund id (re_…). */
  id: string;
  /** Checkout session (cs_…) of the web booking the refund came off. */
  sessionId: string;
  amountCzk: number;
  /** YYYY-MM-DD (Prague) the refund was issued. */
  refundedAt: string;
  /** Operator email that issued or recorded it. */
  by: string;
}

/**
 * Record of a stay the operator trimmed at the guest's request — see
 * `POST /api/bookings/shorten`. The dates themselves live in Beds24 (a real
 * modification, so the freed nights go back on sale), but the PRICE does not
 * move: the guest paid for the original stay and any refund is agreed later,
 * often only once we know which of the freed nights were resold.
 *
 * So this record is also a revenue input. A shortened stay is treated as a
 * partial non-arrival: the nights the guest slept keep the original nightly
 * rate, and whatever the guest has paid beyond that stays as revenue on the
 * trimmed nights' ORIGINAL dates — not piled onto the shorter stay, which
 * would inflate the stayed month. A refund, recorded as a `platformRefund`
 * ("Mark partially refunded"), comes off the trimmed nights first. See
 * `shortenedRevenueSpans` in utils/stayShorten.ts.
 * Persisted in `baker:reservation-overrides`.
 */
export interface StayShortening {
  /** ISO timestamp the stay was shortened. */
  shortenedAt: string;
  /** Operator email that did it. */
  shortenedBy: string;
  fromArrival: string;    // YYYY-MM-DD
  fromDeparture: string;  // YYYY-MM-DD
  toArrival: string;      // YYYY-MM-DD
  toDeparture: string;    // YYYY-MM-DD
  /** Nights freed for resale. */
  nightsRemoved: number;
  /** Beds24 price at the moment the dates moved, before any manual reduction. */
  originalPriceCzk: number;
  /** True when channel updates were blocked so the OTA can't restore the dates. */
  channelLocked?: boolean;
  /** Free-text note ("guest flying home a day early"), optional. */
  reason?: string;
}

/**
 * "This booking continues the stay of `prev`" — a prolongation (or early
 * arrival) booked as its own reservation, typically a direct booking that
 * extends an OTA one. Stored on the LATER booking by dates, so a chain of
 * several bookings is followed through `prev`. Operator-confirmed only:
 * consumers that act on it (the cleaning app skips the turnover between the
 * two) never guess. See utils/stayChains.ts.
 * Persisted in `baker:reservation-overrides`.
 */
export interface StayLink {
  /** Reservation number of the booking this one continues, e.g. "BH-93901799". */
  prev: string;
  /** How it was confirmed: by hand, from a suggestion, or by an extend flow. */
  source: "manual" | "suggestion" | "extend-flow";
  /** ISO timestamp the link was made. */
  linkedAt: string;
  /** Operator email that made it. */
  linkedBy: string;
}

/**
 * The guest's answer to "are you coming by car?" (Beds24 auto action right after
 * booking). 'no-car' marks the stay's garage space as spare in the parking grid —
 * the guest keeps it, it's just known to be empty.
 */
export interface ParkingUse {
  status: "car" | "no-car";
  /** Licence plate as the guest wrote it, upper-cased. Several cars → comma-separated. */
  plate?: string;
  source: "guest" | "operator";
  updatedAt: string; // ISO
}

/** One apartment of a multi-apartment reservation that Beds24 hasn't put in a unit yet. */
export interface UnallocatedLeg {
  /** That apartment's own Beds24 booking, "BH-<id>" — the one the resolver moves. */
  reservationNumber: string;
  /** Its room-type label, e.g. "1KK Urban Studios". */
  room: string;
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
   * VR 679714, 1KK Deluxe Studios VR 648816) WITHOUT a physical-room allocation.
   * Happens when Beds24 cannot auto-allocate because no single physical
   * room is free for the full stay — operator must manually assign in
   * Beds24's calendar. Rendered with a "Room unassigned" badge in the
   * reservation list and surfaces as a pending task in the alert bar.
   *
   * A multi-apartment reservation is flagged when ANY of its apartments is
   * still on a virtual room — `unallocatedLegs` then says which.
   */
  isUnallocatedVR?: boolean;
  /**
   * The apartments of a multi-apartment reservation that still sit on a
   * virtual room, each under its OWN Beds24 booking number (that booking is
   * what gets moved into a unit). BH-95377263: O.308 placed, its Urban studio
   * BH-95377264 still on the Urban VR → one entry. Absent on single-apartment
   * reservations, whose own number is the one to place.
   */
  unallocatedLegs?: UnallocatedLeg[];
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
  // Each entry is a physical room name — or a room-type label ("1KK Urban Studios")
  // for an apartment not placed in a unit yet (see `unallocatedLegs`). Used by
  // performance views to split revenue per room.
  linkedRooms?: string[];
  /**
   * Each linked room's share of the money, parallel to `linkedRooms` (sums to
   * 1). Set when every apartment carries its own price — Booking.com sells N
   * rooms as N bookings, so O.308 + an Urban studio is NOT a 50/50 split.
   * Absent = equal shares (a package whose master carries the whole price).
   */
  linkedRoomShares?: number[];
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
  /**
   * Cancellation policy for THIS booking (read-only, server-derived). Answers
   * "when does the guest lose the right to cancel free of charge" — the free
   * window and the penalty after it. Parsed per booking, not per rate plan:
   * live data shows the same Booking.com plan name carrying different policies,
   * so `rateType` is not a safe proxy. See utils/cancellationPolicy.ts.
   * null/undefined = no policy data (older arrival, or a channel that sends none).
   */
  cancellationPolicy?: import("@/utils/cancellationPolicy").CancellationPolicy | null;
  /**
   * Beds24 booking status, passed through so the UI can tell cancellations
   * apart. Typical values: 'confirmed' | 'new' | 'request' | 'cancelled' | 'black'.
   */
  status?: string;
  /**
   * True when the Beds24 status is cancelled/canceled. Cancelled bookings are
   * shown in Transactions (red flag) but excluded from the default Active view
   * and from revenue/occupancy/commission — UNLESS flagged as a non-arrival.
   */
  isCancelled?: boolean;
  /**
   * Set when this booking was created by a corporate agreement (Corporate tab):
   * the agreement's id, parsed from the `[CORPORATE:<id>]` comment marker the
   * app writes on every booking it creates for one. Server-derived on each
   * sync, never stored in the overrides map. See utils/corporateShared.ts.
   */
  corporateAgreementId?: string;
  /**
   * Everyone on the booking besides the lead guest (firstName/lastName), as
   * full names. Parsed from the `[ADDITIONAL GUESTS: …]` comment line the New
   * Booking modal writes into Beds24 — server-derived on each sync, never stored
   * in the overrides map. Printed on the invoice after the lead guest. See
   * utils/additionalGuests.ts.
   */
  additionalGuests?: string[];

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
  /**
   * Operator overrides for the rate-driven perks (early check-in / late
   * checkout / special treatment). Each absent field falls back to the value
   * the effective rate grants; see utils/ratePerks.ts. Persisted in Redis
   * overrides so the operator keeps full control (manual wins over auto).
   */
  perkOverrides?: import("@/utils/ratePerks").PerkOverrides;
  /**
   * Non-arrival marker. Set when a guest can't come and can't cancel on the OTA
   * without penalty: the operator cancels the booking in Beds24 to free the
   * nights for resale, but we keep charging per the OTA. Flagged non-arrivals
   * stay visible in Transactions + the Active view and are counted in
   * performance at `nonArrivalNetPriceCzk`. Persisted in `baker:reservation-overrides`.
   */
  nonArrival?: NonArrival | null;
  /**
   * Net revenue retained from a non-arrival after any channel-side refund.
   * Operator-editable; defaults to the original booking price. Only meaningful
   * when `nonArrival` is set.
   */
  nonArrivalNetPriceCzk?: number | null;
  /**
   * Partial-refund marker for a booking that still stands: the guest stayed,
   * the channel billed and commissioned the full price, and the operator gave
   * some of it back. Reduces gross booking value — and so net sales, gross
   * profit and the owner settlement — while leaving commission and fees at what
   * the channel actually charged. Mutually exclusive with `nonArrival`, whose
   * `nonArrivalNetPriceCzk` already nets off any channel-side refund.
   * Persisted in `baker:reservation-overrides`.
   */
  platformRefund?: PlatformRefund | null;
  /**
   * Set when the operator trimmed nights off this stay at the guest's request.
   * The shortened dates are the ones Beds24 reports (occupancy follows them);
   * revenue stays on the original nightly schedule — see StayShortening.
   * Persisted in `baker:reservation-overrides`.
   */
  stayShortened?: StayShortening | null;
  /**
   * Set when this booking continues another booking's stay (see StayLink).
   * Only valid while the two still meet: `prev` checks out the day this one
   * arrives and neither is cancelled — `utils/stayChains.ts` ignores it otherwise.
   */
  stayLink?: StayLink | null;
  /**
   * Reservation numbers the operator marked "not the same guest" — a
   * back-to-back booking under the same name that is NOT a continuation. Stops
   * the suggestion and stops the room resolver chaining the two by name.
   */
  stayLinkRejected?: string[];
  /**
   * Set only on the per-apartment pieces `expandLinkedReservations` makes of a
   * SHORTENED reservation: how the piece's money is spread over nights, as
   * shares of the piece's own amounts. Computed from the whole booking before
   * it is split, because the shares depend on the booking's total price. Read
   * through `revenueShareInPeriod`, never directly.
   */
  revenueSpans?: RevenueSpan[];
  invoiceData: InvoiceData | null;
  invoiceStatus: InvoiceStatus;
  includeQR?: boolean;   // true = QR payment code was included; Revenue section will track this
  issues?: Issue[]; // locally managed task/issue log; undefined = no issues
  additionalPayments?: AdditionalPayment[]; // Stripe payment links created for this reservation
  splitPayments?: SplitPayment[]; // scheduled future payments (cron-emailed when sendDate ≤ today)
  vouchers?: Voucher[]; // discount vouchers linked to this reservation
  parkingOverride?: string; // undefined = auto rules, "none" = no parking, "152"/"153"/etc = manual space
  /** Is the guest actually bringing a car? From their reply to the post-booking
   *  question (utils/guestContact) or set by the operator. undefined/null = not answered. */
  parkingUse?: ParkingUse | null;
  invoiceModifications?: InvoiceModification[]; // display-only invoice variants; never touches Beds24
  /**
   * Split invoices — one booking billed to several parties (see InvoiceSplit).
   * Non-empty means the Invoice section issues these INSTEAD of one invoice
   * against `invoiceData`. Their amounts must not exceed the booking price.
   */
  invoiceSplits?: InvoiceSplit[];
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
  /**
   * Set only when the guest was moved MID-STAY (drawer "Move to another room"
   * with a move date): the physical unit per night range, in order. The last
   * segment's room is `room` (what Beds24 holds). Derived server-side from
   * `room_moves.effective_from` — see utils/roomSegments.ts. Per-apartment
   * money and occupancy must read these, not `room`.
   */
  roomSegments?: RoomSegment[];
  /**
   * Set only on the per-apartment PIECES `splitBySegments` makes of a
   * mid-stay-moved reservation (never on a real reservation). Pieces share the
   * reservationNumber, so anything that counts bookings or adds a
   * per-reservation amount must count the booking once — see
   * `isRepeatSegmentPiece` / `isFinalSegmentPiece` in utils/roomSegments.
   */
  segmentPiece?: { index: number; of: number };
}

/** One stretch of a mid-stay-moved reservation spent in one physical unit. */
/**
 * A run of nights carrying a fixed share of a reservation's money, spread
 * evenly over those nights. Shares across a reservation's spans add up to 1
 * (on a split piece they can exceed it — see `Reservation.revenueSpans`).
 */
export interface RevenueSpan {
  from: string;  // YYYY-MM-DD, first night
  to: string;    // YYYY-MM-DD, exclusive
  share: number;
}

export interface RoomSegment {
  room: string;
  /** First night (YYYY-MM-DD). */
  from: string;
  /** Exclusive end — the move date, or the checkout for the last segment. */
  to: string;
  nights: number;
  /** nights / total nights — the share of the booking's money this room earns. */
  share: number;
}
