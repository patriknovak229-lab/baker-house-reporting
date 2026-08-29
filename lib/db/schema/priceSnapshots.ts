import { pgTable, text, integer, numeric, date, timestamp, jsonb, serial, index } from 'drizzle-orm/pg-core';

/**
 * Channel price parity — what a customer actually sees, captured over time.
 *
 * WHERE THE ROWS COME FROM
 * ------------------------
 * The local parity runner (scripts/parity-runner, launchd on the operator's
 * Mac) scrapes Airbnb and Booking.com from a residential IP — Vercel
 * datacenter IPs get bot-challenged by Booking.com, which is why the previous
 * serverless scraper returned empty Booking columns for months. The runner
 * POSTs to /api/pricing/ingest, which adds the Web column from the Beds24
 * offers API (the server holds that token; the Mac does not need it) and
 * writes everything here.
 *
 * APPEND-ONLY BY DESIGN. Every run inserts new rows under a fresh run_id; the
 * UI reads the latest grid run and history queries become possible for free
 * ("what did Booking charge at lead-14 each day this month?"). Nothing ever
 * updates a snapshot — a scrape result is an observation, and observations
 * don't change after the fact.
 *
 * THE GRID: the scheduled run samples the same relative windows every day —
 * lead times × stay lengths from data/parityConfig — so day-over-day rows are
 * comparable. Ad-hoc checks land here too, under source='custom'.
 */
export const priceSnapshots = pgTable(
  'price_snapshots',
  {
    id: serial('id').primaryKey(),
    /** Groups every row captured by one runner invocation. */
    runId: text('run_id').notNull(),
    /** 'grid' = scheduled sampling grid; 'custom' = operator-requested check. */
    source: text('source').notNull(),
    /** Sellable unit id — matches SELLABLE_UNITS / PARITY_UNITS ids. */
    unitId: text('unit_id').notNull(),
    /** 'web' | 'airbnb' | 'booking'. */
    channel: text('channel').notNull(),
    checkIn: date('check_in', { mode: 'string' }).notNull(),
    nights: integer('nights').notNull(),
    /** Days between capture and check-in — the grid axis. */
    leadDays: integer('lead_days').notNull(),
    /** Total stay price in CZK a customer would pay; null when not bookable. */
    price: numeric('price'),
    /** Strikethrough original when the channel shows a discount. */
    originalPrice: numeric('original_price'),
    /** Overall percent off, when derivable: (original − price) / original × 100. */
    discountPct: numeric('discount_pct'),
    /** Itemised discount lines [{name, amountKc?, pp?}] where the channel exposes them. */
    discounts: jsonb('discounts'),
    /** Loose badge/deal labels seen on the offer ("Early Booker Deal", "Genius"). */
    labels: jsonb('labels'),
    /** 'available' | 'not_available' | 'error'. */
    availability: text('availability').notNull(),
    /**
     * What the configured channel economics say this stay SHOULD cost
     * (data/parityConfig markup + discount stack over the Web price). Null
     * until the config carries real numbers — the comparison is the point of
     * the column, so it is computed at ingest time against the same run's Web
     * row and frozen with the observation.
     */
    expectedPrice: numeric('expected_price'),
    capturedAt: timestamp('captured_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    index('price_snapshots_run_idx').on(t.runId),
    index('price_snapshots_series_idx').on(t.unitId, t.channel, t.nights, t.leadDays, t.capturedAt),
    index('price_snapshots_captured_idx').on(t.capturedAt),
  ],
);

/**
 * Operator-requested price checks, queued for the local runner.
 *
 * The Mac polls GET /api/pricing/ingest every few minutes; a pending row here
 * makes its next poll scrape that stay and ingest the result under
 * source='custom' with the row's id echoed back, closing the loop.
 */
export const priceCheckRequests = pgTable(
  'price_check_requests',
  {
    id: serial('id').primaryKey(),
    checkIn: date('check_in', { mode: 'string' }).notNull(),
    nights: integer('nights').notNull(),
    /** 'pending' → 'done' | 'error'. No 'running': the runner is single-shot. */
    status: text('status').notNull().default('pending'),
    requestedBy: text('requested_by'),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    /** run_id of the snapshot rows that answered this request. */
    runId: text('run_id'),
    error: text('error'),
  },
  (t) => [index('price_check_requests_status_idx').on(t.status)],
);

export type PriceSnapshotRow = typeof priceSnapshots.$inferSelect;
export type PriceSnapshotInsert = typeof priceSnapshots.$inferInsert;
export type PriceCheckRequestRow = typeof priceCheckRequests.$inferSelect;
