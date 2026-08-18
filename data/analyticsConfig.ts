/**
 * Operator-tunable inputs for the analytics section.
 *
 * Everything here is a business fact the database cannot know. Edit this file
 * and redeploy — no migration, no UI, no risk to any operational path. It is
 * imported by both server and client code, so it must stay free of server-only
 * imports (see the note at the top of `utils/analyticsTypes.ts`).
 */
import type { DemandEvent } from '@/utils/analyticsTypes';

/**
 * When each room genuinely became sellable, if that differs from its first
 * booking.
 *
 * Analytics derives the online date from the earliest booking or blackout it can
 * see, which is right whenever a room sold quickly after listing. It is WRONG
 * when a room sat listed and empty for a while: the empty period silently
 * disappears from the availability denominator and occupancy comes out too high.
 *
 * Add a room here the moment you know it was on sale earlier than its first
 * booking. Format: room name → YYYY-MM-DD (first sellable night).
 *
 * Current defaults, derived from the archive, are roughly:
 *   K.202 / K.203 → 2026-02-06   K.201 → 2026-03-12
 *   K.102 / K.103 / K.106 → 2026-05-22   O.308 → 2026-06-12
 */
export const ROOM_ONLINE_OVERRIDES: Record<string, string> = {
  // 'K.102': '2026-05-15',
};

/**
 * Brno demand events — the local calendar that explains most of the spikes.
 *
 * With under a year of trading, a month-over-month chart cannot separate "the
 * season" from "that one weekend the city sold out". This list lets the
 * seasonality view attribute the spikes it can and stay honest about the rest.
 *
 * Keep it curated: only events big enough to move a 7-apartment property. Dates
 * are inclusive of both ends, and should be the NIGHTS people stay (usually the
 * event days minus the final day, plus the night before).
 *
 * Sourced from the official organisers; verify before relying on a future date.
 */
export const DEMAND_EVENTS: DemandEvent[] = [
  {
    id: 'motogp-2026',
    label: 'MotoGP — Grand Prix of Czechia',
    start: '2026-06-18',
    end: '2026-06-21',
    kind: 'motorsport',
    note: 'Automotodrom Brno. Race weekend 19–21 June 2026; arrivals from the 18th.',
  },
  {
    id: 'msv-2026',
    label: 'MSV — International Engineering Fair',
    start: '2026-10-05',
    end: '2026-10-09',
    kind: 'trade-fair',
    note: 'Brno Exhibition Centre, 6–9 October 2026. 1500+ exhibitors; the strongest business-travel week of the year.',
  },
  {
    id: 'easter-2026',
    label: 'Easter',
    start: '2026-04-03',
    end: '2026-04-06',
    kind: 'holiday',
    note: 'Czech Easter Monday 6 April 2026 — long weekend.',
  },
  {
    id: 'christmas-2026',
    label: 'Christmas & New Year',
    start: '2026-12-23',
    end: '2027-01-01',
    kind: 'holiday',
  },
];

/**
 * Buckets for the "which stay lengths actually make money" analysis.
 *
 * Cleaning, laundry and a consumables set are charged ONCE per stay regardless
 * of length, so a one-night booking carries the same turnover cost as a
 * seven-night one. These are the costs that scale per checkout rather than per
 * night; anything not listed is treated as a nightly or monthly cost.
 */
export const TURNOVER_COST_KEYS = ['cleaning', 'laundry', 'consumables'] as const;

/**
 * The commission rate the business pays each channel on paper, used only to
 * flag when the ACTUAL rate Beds24 reports drifts away from it. Analytics always
 * reports the actual figure; this is the expectation it is compared against.
 *
 * Set a channel to null to skip the check.
 */
export const EXPECTED_COMMISSION_RATES: Record<string, number | null> = {
  'Booking.com': 0.17,
  Airbnb: 0.19,
  'Direct-Web': 0,
  'Direct-Phone': 0,
  Direct: 0,
};

/** How far ahead the on-the-books / pace view looks. */
export const PACE_MONTHS_AHEAD = 6;

// ── Data hygiene ─────────────────────────────────────────────────────────────

/**
 * Bookings excluded from every analytics figure as test data.
 *
 * The rental-site integration was developed against the live Beds24 account, so
 * the archive contains real booking records named "Test", "Test2", "Test10" …
 * created and cancelled minutes later. There are enough of them to matter: they
 * are most of the `Direct-Web` and `Direct` cancellations, and left in they push
 * the direct-channel cancellation rate above 80% — a number that would look like
 * a broken checkout flow rather than a developer testing one.
 *
 * A POSIX regex matched case-insensitively against the guest's first OR last
 * name. Set to null to keep every booking.
 */
export const TEST_BOOKING_NAME_REGEX: string | null = '^(test|tester|testing|zkouska)[0-9]*$';

/**
 * A cancellation this soon after the booking was created is treated as an
 * ABANDONED CHECKOUT, not a guest cancellation.
 *
 * The two are different events and averaging them together destroys both
 * signals. Measured on real data: Booking.com cancellations arrive a median of
 * ~18 days after booking (a guest changing plans), while the direct-web ones
 * cluster inside two hours (a Stripe session that was never completed, or a
 * duplicate attempt). Analytics reports them as separate classes.
 */
export const ABANDONED_CANCEL_MINUTES = 120;

// ── Sellable units (room groups) ─────────────────────────────────────────────

/**
 * A sellable unit — the thing the market actually buys.
 *
 * WHY THIS IS THE PRIMARY GRAIN, NOT THE PHYSICAL ROOM
 * ---------------------------------------------------
 * K.102, K.103 and K.106 are one product. They are listed as a single room type
 * ("1KK Urban Studios"), sold interchangeably, and Beds24 decides which physical
 * unit a booking lands in — so per-room occupancy is largely an artefact of the
 * allocator, not of demand. A single room reading 100% while its siblings sit at
 * 85% says the allocator packed that room first; it says nothing about pricing.
 * Read as a group, the three of them answer the real question: was there demand
 * for a 1KK Urban studio that night, and did we have one left?
 *
 * Two happy consequences:
 *   - it is the grain PriceLabs prices at, so market comparisons are 1:1 rather
 *     than needing a fudge (`311322___<beds24RoomId>` — see docs/pricelabs-evaluation.md);
 *   - "sold out" becomes meaningful. A group with every unit sold on a date had
 *     nothing left to sell, which is the only bias-free evidence of underpricing
 *     available without market data.
 *
 * Per-room figures are still reported — they matter for wear, cleaning and the
 * occasional genuinely different unit — but they are the detail, not the headline.
 */
export interface SellableUnit {
  /** Stable key used in API responses and as a React key. */
  id: string;
  /** How the unit is sold — matches the Beds24 room-type label where there is one. */
  label: string;
  /** Compact form for axes and dense tables. */
  shortLabel: string;
  /** The physical rooms that back it, in canonical order. */
  rooms: string[];
  bedrooms: number;
  /**
   * PriceLabs listing id, or null when the unit is not synced there.
   *
   * NOTE: O.308 is registered in PriceLabs as a 1-bedroom listing even though it
   * has two bedrooms, so its market benchmark is drawn from the wrong comp set
   * until that is fixed in the PriceLabs UI. `bedrooms` here is the truth.
   */
  priceLabsListingId: string | null;
}

export const SELLABLE_UNITS: SellableUnit[] = [
  {
    id: 'urban-1kk',
    label: '1KK Urban Studios',
    shortLabel: 'Urban 1KK',
    rooms: ['K.102', 'K.103', 'K.106'],
    bedrooms: 1,
    priceLabsListingId: '311322___679714',
  },
  {
    id: 'deluxe-1kk',
    label: '1KK Deluxe Studios',
    shortLabel: 'Deluxe 1KK',
    rooms: ['K.202', 'K.203'],
    bedrooms: 1,
    priceLabsListingId: '311322___648816',
  },
  {
    id: 'k201',
    label: 'K.201 — 2KK Deluxe',
    shortLabel: 'K.201',
    rooms: ['K.201'],
    bedrooms: 2,
    priceLabsListingId: '311322___656437',
  },
  {
    id: 'o308',
    label: 'O.308 — 2 Bedroom Deluxe',
    shortLabel: 'O.308',
    rooms: ['O.308'],
    bedrooms: 2,
    priceLabsListingId: '311322___674672',
  },
];

// ── Transient vs long stay ───────────────────────────────────────────────────

/**
 * The longest stay still treated as TRANSIENT demand.
 *
 * A Monday night sold inside a 25-night stay tells you nothing about what Monday
 * was worth: it was bought once, months earlier, at a negotiated long-stay rate,
 * and it then blocks the room against every later transient enquiry. Left in, it
 * drags weekday ADR down and inflates weekday occupancy at the same time — the
 * two errors point in opposite directions, so they cannot cancel out.
 *
 * Every weekday, compression and pricing-position figure is therefore computed on
 * transient nights only, against a denominator that also removes the room-nights
 * the long stay had already consumed (a room committed to a monthly guest was
 * never on sale to a Friday transient booker).
 *
 * 7 nights covers 97% of bookings and 85% of room-nights; the ten stays above it
 * account for 143 room-nights. Raise it and the long-stay rate contaminates the
 * signal; lower it and genuine week-long leisure stays get thrown away.
 */
export const TRANSIENT_LOS_MAX = 7;

/**
 * The far-out premium currently configured in PriceLabs, as a ratio.
 *
 * The engine is set so a stay booked ~3 months out is priced about 15% above the
 * same stay booked ~3 weeks out. Analytics does not enforce this — it measures
 * whether it is actually being earned: what ADR was achieved by lead-time bucket,
 * and what share of the book each bucket ends up delivering.
 *
 * Update it whenever the PriceLabs far-out settings change, otherwise the
 * comparison silently drifts.
 */
export const CONFIGURED_FAR_OUT_PREMIUM = {
  /** Lead-time (days) of the cheaper, near-in reference point. */
  nearDays: 21,
  /** Lead-time (days) of the more expensive, far-out point. */
  farDays: 90,
  /** Intended price uplift of far over near. */
  premium: 0.15,
};
