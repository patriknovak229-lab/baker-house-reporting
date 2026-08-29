import { pgTable, text, integer, numeric, date, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Market benchmark cache — PriceLabs data, flattened.
 *
 * WHY THESE TABLES EXIST AT ALL
 * -----------------------------
 * The analytics page must stay a Postgres-only read. PriceLabs' neighborhood
 * payload is ~540 KB per listing and the API is rate-limited and occasionally
 * slow; calling it on a page load would make the slowest external dependency in
 * the app sit on the critical path of a dashboard. So a cron (or an operator
 * pressing Refresh) pulls it, extracts the handful of series that are actually
 * plotted, and upserts them here. Everything the UI reads is local.
 *
 * WHY EXTRACTED SERIES AND NOT THE BLOB
 * -------------------------------------
 * Storing the raw JSON would be less code and much worse: 2 MB per refresh,
 * re-parsed on every request, with no way to query "market occupancy for October"
 * without deserialising all of it. The extraction is the point.
 *
 * WHAT THESE NUMBERS ARE — AND ARE NOT
 * ------------------------------------
 * PriceLabs builds its comp set by scraping Airbnb and VRBO. Booking.com — 83% of
 * our nights — is not in it. Market occupancy holds up well regardless (a
 * multi-channel listing blocks its Airbnb calendar when a Booking.com reservation
 * lands, and PriceLabs' inferred occupancy for K.201 matched our archive to the
 * decimal), but market PRICE percentiles are an Airbnb-listed view: those prices
 * carry a ~3% host fee where our Booking.com-facing rates absorb ~17%, and
 * Booking.com-only listings are invisible entirely. Price position is context, not
 * a target. Every surface that renders it says so.
 *
 * Rows are keyed so a refresh is a plain idempotent upsert; re-running it is
 * always safe and never grows the table.
 */

/**
 * Per stay date, per listing: what the market is doing and what we are asking.
 *
 * ~540 rows per listing (their forward horizon), so a few thousand rows in total.
 * `captured_at` is per row rather than per batch so a partially-failed refresh is
 * visible instead of silently mixing vintages.
 */
export const marketDaily = pgTable(
  'market_daily',
  {
    /** PriceLabs listing id, e.g. 311322___679714. Joins to SELLABLE_UNITS. */
    listingId: text('listing_id').notNull(),
    /** The night being priced. */
    stayDate: date('stay_date', { mode: 'string' }).notNull(),
    /** Market occupancy for this night, 0–1. */
    marketOccupancy: numeric('market_occupancy'),
    /** Same night last year, 0–1 — PriceLabs' own STLY, which IS populated for the market. */
    marketOccupancyStly: numeric('market_occupancy_stly'),
    /**
     * Share of the comp set that newly booked this night in the last 7 days —
     * market pickup, as a ratio. Stored numeric, not integer: PriceLabs reports it
     * as a percentage of listings (11.9048), and rounding it to 12 would throw away
     * most of the resolution on a series whose whole job is showing small moves.
     */
    marketPickup7: numeric('market_pickup_7'),
    /** Share of the comp set that cancelled this night in the last 7 days. */
    marketCancellations7: numeric('market_cancellations_7'),
    /** Comp-set listings available for this night — the supply side. */
    marketSupply: integer('market_supply'),
    marketSupplyStly: integer('market_supply_stly'),
    /** Market asking-price percentiles for this night, in CZK. */
    p25: numeric('p25'),
    p50: numeric('p50'),
    p75: numeric('p75'),
    p90: numeric('p90'),
    /** Median price of comps that actually BOOKED this night — better than asks. */
    medianBookedPrice: numeric('median_booked_price'),
    /** PriceLabs' recommendation for us for this night. */
    recommendedPrice: numeric('recommended_price'),
    /** What is actually live on Beds24 for this night (null when unavailable). */
    livePrice: numeric('live_price'),
    /**
     * PriceLabs' per-date demand classification, verbatim: 'Low Demand' |
     * 'Normal Demand' | 'Good Demand' | 'High Demand' | 'Unavailable'. This is
     * the same signal that colors their pricing calendar, and it comes free in
     * the listing_prices payload the refresh already downloads. 'Unavailable'
     * means OUR calendar is closed/booked that night — it says nothing about
     * market demand, so demand analysis must treat it as null, not as a level.
     */
    demandDesc: text('demand_desc'),
    /** Their calendar hex for the same classification — pass-through for UI. */
    demandColor: text('demand_color'),
    /** Min stay in force on Beds24 for this night, per PriceLabs. */
    minStay: integer('min_stay'),
    /**
     * Comp-set bookings observed for this stay night ('N_Bookings' in the
     * neighborhood percentile block) — a raw demand signal to complement the
     * classification above.
     */
    nBookings: numeric('n_bookings'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.listingId, t.stayDate] }),
    index('market_daily_stay_date_idx').on(t.stayDate),
  ],
);

/**
 * Monthly market KPIs — 27 months of history, including the periods before we
 * traded. This is the only source in the whole system for a market booking
 * window, which is the benchmark our 7-day median most needs.
 */
export const marketMonthly = pgTable(
  'market_monthly',
  {
    listingId: text('listing_id').notNull(),
    /** YYYY-MM. */
    month: text('month').notNull(),
    /** Mean days between booking and arrival across the comp set. */
    marketBookingWindow: numeric('market_booking_window'),
    /** Mean length of stay across the comp set. */
    marketLos: numeric('market_los'),
    /** Market occupancy for the month, 0–1. */
    marketOccupancy: numeric('market_occupancy'),
    /** Market ADR for the month, CZK. */
    marketAdr: numeric('market_adr'),
    /** Bookings the comp set picked up in the trailing 7 days for this month. */
    marketPickup7: integer('market_pickup_7'),
    marketPickup7Stly: integer('market_pickup_7_stly'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.month] })],
);

/**
 * Forward-looking position by horizon — the MPI table.
 *
 * PriceLabs reports our own occupancy here too, but it is WRONG for multi-unit
 * listings (it reads 0.0% for both virtual rooms because bookings land on physical
 * rooms it does not attribute back). Only the MARKET columns are trustworthy; our
 * side is computed from `bookings_mirror` and MPI is derived here rather than
 * taken from their `mpi` field. Their value is stored anyway, for comparison when
 * a discrepancy needs explaining.
 */
export const marketHorizon = pgTable(
  'market_horizon',
  {
    listingId: text('listing_id').notNull(),
    /** 7, 30, 60, 90, 180 or 360 days forward from the capture date. */
    horizonDays: integer('horizon_days').notNull(),
    /** Market occupancy over the horizon, 0–1. */
    marketOccupancy: numeric('market_occupancy'),
    /** Market ADR over the horizon, CZK. */
    marketAdr: numeric('market_adr'),
    /** PriceLabs' own view of our occupancy — unreliable for multi-unit listings. */
    theirOwnOccupancy: numeric('their_own_occupancy'),
    /** PriceLabs' own MPI — same caveat. */
    theirMpi: numeric('their_mpi'),
    /**
     * How many comp listings PriceLabs used for this listing's benchmark.
     *
     * Worth storing because it varies more than expected: the 1-bedroom pool is
     * 283 listings, K.201's 2-bedroom pool is 48, and O.308 — registered in
     * PriceLabs as 1-bedroom despite having two — draws a 2-bedroom pool of only
     * 17. A benchmark built on 17 listings deserves a visible warning, so the UI
     * shows this number rather than implying every comparison is equally solid.
     */
    compSetListings: integer('comp_set_listings'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.listingId, t.horizonDays] })],
);

export type MarketDailyRow = typeof marketDaily.$inferSelect;
export type MarketDailyInsert = typeof marketDaily.$inferInsert;
export type MarketMonthlyRow = typeof marketMonthly.$inferSelect;
export type MarketMonthlyInsert = typeof marketMonthly.$inferInsert;
export type MarketHorizonRow = typeof marketHorizon.$inferSelect;
export type MarketHorizonInsert = typeof marketHorizon.$inferInsert;
