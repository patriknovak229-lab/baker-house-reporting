/**
 * Corporate agreements — shared vocabulary.
 *
 * A corporate agreement is a company's standing request for repeated stays
 * ("1KK Urban or Deluxe, Monday and Tuesday nights, every week until
 * December"). The agreement is OURS (Postgres); every stay it produces is a
 * normal Beds24 booking, created by this app and tagged with a comment marker
 * so Transactions can recognise it.
 *
 * Deliberately free of server-only imports: the API routes, the data layer,
 * the Beds24 → Reservation mapper AND the client components all import from
 * here, so anything that touches Redis, Postgres or Beds24 must live elsewhere
 * (see the lib/db.ts note on what happens when a server module leaks into the
 * client bundle).
 */

// ─── Beds24 comment marker ───────────────────────────────────────────────────

/**
 * Written into `comments` on every Beds24 booking an agreement creates, next
 * to the existing phone-booking marker. The channel stays Direct-Phone — a
 * corporate stay IS a direct booking arranged by the operator — and this tag is
 * what tells the dashboard which agreement the booking belongs to.
 */
export function corporateMarker(agreementId: string): string {
  return `[CORPORATE:${agreementId}]`;
}

const CORPORATE_MARKER_RE = /\[CORPORATE:([A-Za-z0-9_-]+)\]/;

/** The agreement id a Beds24 booking was created for, or null. */
export function parseCorporateMarker(comments: string | null | undefined): string | null {
  if (!comments) return null;
  const m = comments.match(CORPORATE_MARKER_RE);
  return m ? m[1] : null;
}

// ─── Enumerations ────────────────────────────────────────────────────────────

/**
 * flat    — the operator agreed a nightly rate; every stay = rate × nights.
 * dynamic — each stay sells at what the web would charge for those dates
 *           (a real Beds24 offer), minus the agreed discount.
 */
export type PricingMode = 'flat' | 'dynamic';

/**
 * How the company expects to be invoiced. Stored from day one so the invoice
 * automation (phase 2) has something to schedule against; phase 1 only shows it.
 */
export type BillingCadence = 'per_stay' | 'monthly' | 'upfront' | 'manual';

/**
 * draft     — saved, nothing in Beds24 yet.
 * active    — at least one stay exists as a Beds24 booking.
 * completed — operator closed it (all stays over or no more coming).
 * cancelled — operator cancelled the agreement itself. Does NOT cancel the
 *             Beds24 bookings — each stay is cancelled on its own, on purpose.
 */
export type AgreementStatus = 'draft' | 'active' | 'completed' | 'cancelled';

/**
 * planned   — a dated stay we intend to create; editable (room, price, guest).
 * created   — exists in Beds24 (`reservationNumber` set).
 * failed    — Beds24 refused it (usually no availability); stays editable and
 *             can be retried.
 * skipped   — operator excluded this occurrence (holiday, company said no).
 * cancelled — was created, then cancelled in Beds24 through this app.
 */
export type StayStatus = 'planned' | 'created' | 'failed' | 'skipped' | 'cancelled';

/** Where a stay's price came from, so the operator can tell a quote from a hand-typed number. */
export type StayPriceSource = 'flat' | 'offers' | 'calendar-nominal' | 'manual';

export const BILLING_CADENCE_LABELS: Record<BillingCadence, string> = {
  per_stay: 'Per stay, before each arrival',
  monthly: 'Monthly',
  upfront: 'Whole period up front',
  manual: 'Manual / ad hoc',
};

export const AGREEMENT_STATUS_LABELS: Record<AgreementStatus, string> = {
  draft: 'Draft',
  active: 'Active',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const STAY_STATUS_LABELS: Record<StayStatus, string> = {
  planned: 'Planned',
  created: 'Created',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

/** ISO weekday numbering (Mon = 1 … Sun = 7) — never JS's Sunday-is-0. */
export const ISO_WEEKDAYS: { iso: number; short: string; long: string }[] = [
  { iso: 1, short: 'Mon', long: 'Monday' },
  { iso: 2, short: 'Tue', long: 'Tuesday' },
  { iso: 3, short: 'Wed', long: 'Wednesday' },
  { iso: 4, short: 'Thu', long: 'Thursday' },
  { iso: 5, short: 'Fri', long: 'Friday' },
  { iso: 6, short: 'Sat', long: 'Saturday' },
  { iso: 7, short: 'Sun', long: 'Sunday' },
];

// ─── Records as the API hands them to the client ─────────────────────────────

export interface CorporateAgreement {
  id: string;
  companyName: string;
  companyAddress: string | null;
  /** Czech company number. */
  ico: string | null;
  /** VAT / DIČ. */
  vatNumber: string | null;
  billingEmail: string | null;
  billingCadence: BillingCadence;
  /** The person at the company who arranges the stays. */
  repName: string | null;
  repPhone: string | null;
  repEmail: string | null;
  /** Default guest for every stay; a stay can override any of these. */
  guestFirstName: string | null;
  guestLastName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  adults: number;
  children: number;
  /** ISO 3166-1 alpha-2 — drives the booking's language in Beds24. */
  nationality: string;
  /** Sellable Beds24 room ids the company accepts (see SELLABLE_UNITS). */
  roomIds: number[];
  /** The type to use whenever it is free; null = first of `roomIds`. */
  preferredRoomId: number | null;
  /** First night the pattern may fall on (YYYY-MM-DD). */
  startDate: string;
  /** Last night the pattern may fall on, inclusive (YYYY-MM-DD). */
  endDate: string;
  /** ISO weekdays (1–7) of the nights the guest sleeps here. */
  nightWeekdays: number[];
  pricingMode: PricingMode;
  flatNightPriceCzk: number | null;
  /** Percent off the web price in dynamic mode; ignored for flat. */
  discountPercent: number;
  notes: string | null;
  status: AgreementStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CorporateStay {
  id: string;
  agreementId: string;
  /** 1-based position in the generated schedule — stable, never renumbered. */
  seq: number;
  arrival: string;
  departure: string;
  nights: number;
  /** Sellable Beds24 room id this stay is (to be) booked on. */
  roomId: number;
  guestFirstName: string | null;
  guestLastName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  /** Web price before discount (dynamic mode), or null. */
  listPriceCzk: number | null;
  /** What the company is charged for this stay; null until known. */
  priceCzk: number | null;
  priceSource: StayPriceSource | null;
  status: StayStatus;
  beds24BookingId: number | null;
  /** "BH-<id>" once created. */
  reservationNumber: string | null;
  /** Why the last create attempt failed, if it did. */
  error: string | null;
  bookedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Roll-up of an agreement's stays, as the list and the detail header show it. */
export interface AgreementSummary {
  stays: number;
  planned: number;
  created: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** Nights across the stays that count (planned + created + failed). */
  nights: number;
  /** Price across the same stays; unpriced ones contribute 0. */
  priceCzk: number;
  /** How many of those stays still have no price. */
  unpriced: number;
  firstArrival: string | null;
  lastDeparture: string | null;
}

export interface AgreementListItem extends CorporateAgreement {
  summary: AgreementSummary;
}

export interface AgreementDetail extends CorporateAgreement {
  stays: CorporateStay[];
  summary: AgreementSummary;
}

/** Stays that still represent a (wanted) stay — everything but skipped and cancelled. */
export function countsTowardsAgreement(status: StayStatus): boolean {
  return status === 'planned' || status === 'created' || status === 'failed';
}

export function summariseStays(
  stays: Pick<CorporateStay, 'status' | 'nights' | 'priceCzk' | 'arrival' | 'departure'>[],
): AgreementSummary {
  const summary: AgreementSummary = {
    stays: stays.length,
    planned: 0,
    created: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    nights: 0,
    priceCzk: 0,
    unpriced: 0,
    firstArrival: null,
    lastDeparture: null,
  };
  for (const s of stays) {
    summary[s.status] += 1;
    if (!countsTowardsAgreement(s.status)) continue;
    summary.nights += s.nights;
    if (s.priceCzk === null) summary.unpriced += 1;
    else summary.priceCzk += s.priceCzk;
    if (summary.firstArrival === null || s.arrival < summary.firstArrival) summary.firstArrival = s.arrival;
    if (summary.lastDeparture === null || s.departure > summary.lastDeparture) summary.lastDeparture = s.departure;
  }
  return summary;
}

export function formatCzk(n: number): string {
  return `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
}

/** "Mon 12 Oct" — short, unambiguous, same on server and client (UTC, no locale drift). */
export function formatStayDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

/** "Mon 12 Oct → Wed 14 Oct" */
export function formatStayRange(arrival: string, departure: string): string {
  return `${formatStayDate(arrival)} → ${formatStayDate(departure)}`;
}

/** Short room-type label for tight table cells: "Urban 1KK", "Deluxe 1KK", "K.201 2KK", "O.308 2BR". */
export function roomShortLabel(roomId: number): string {
  switch (roomId) {
    case 679714:
      return 'Urban 1KK';
    case 648816:
      return 'Deluxe 1KK';
    case 656437:
      return 'K.201 2KK';
    case 674672:
      return 'O.308 2BR';
    default:
      return `room ${roomId}`;
  }
}
