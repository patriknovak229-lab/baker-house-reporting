import { pgTable, text, integer, numeric, date, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Web funnel — the rental site's own anonymous booking-funnel counts, plus a GA4
 * traffic-source snapshot. Read by the admin-only "Web funnel" tab under /analytics.
 *
 * WHERE THE FIRST-PARTY DATA COMES FROM
 * -------------------------------------
 * bakerhouseapartments.cz sends a cookie-free beacon for every funnel step to its own
 * /api/funnel, which keeps per-Prague-day counters and a capped list of search records
 * in the rental site's Redis (contract: rental-site src/lib/funnel-events.ts, mirrored
 * in utils/webFunnel.ts). Those Redis keys expire after 180 days, so a nightly cron
 * (/api/cron/web-funnel-sync) copies them here: THIS is the durable archive. Every
 * write is an upsert on a natural key, so re-copying a day is always safe, and an
 * expired Redis day never deletes anything here.
 *
 * Nothing in these tables identifies a person — the beacons carry no cookie, no ID,
 * no IP and no user agent. A count is per search / page event, not per visitor.
 *
 * WHY GA4 IS HERE AT ALL
 * ----------------------
 * Only for traffic sources, which the site cannot see. GA only measures visitors who
 * accept cookies and don't block Google, so web_traffic_daily is a SAMPLE — fine for
 * the channel mix, never for funnel volumes. Every surface that shows it says so.
 */

/**
 * One row per (Prague day, counter field) — the Redis hash copied verbatim.
 *
 * Narrow on purpose: the field grammar (`view_item_list`, `select_item|room=679714`,
 * `purchase|value`, `_dropped|bot`, …) lives in utils/webFunnel.ts, so a new event or
 * dimension on the site needs no migration here.
 */
export const webFunnelDaily = pgTable(
  'web_funnel_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    /** A count, or a sum in whole CZK for the `|value` fields. */
    value: numeric('value').notNull(),
    copiedAt: timestamp('copied_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.metric] })],
);

/**
 * One row per search (view_item_list or no_availability) — the demand signal: which
 * stays people asked for, and whether we had anything to offer.
 *
 * `seq` is the record's position in that day's Redis list. The site appends and only
 * ever trims the tail (3 000/day cap), so positions never shift and (day, seq) is a
 * stable key for the upsert. No time of day is recorded, by design.
 */
export const webFunnelSearches = pgTable(
  'web_funnel_searches',
  {
    /** Day the search happened (Prague). */
    day: date('day', { mode: 'string' }).notNull(),
    seq: integer('seq').notNull(),
    /** 'offers' = at least one bookable offer shown, 'none' = no availability. */
    kind: text('kind').$type<'offers' | 'none'>().notNull(),
    arrival: date('arrival', { mode: 'string' }).notNull(),
    departure: date('departure', { mode: 'string' }).notNull(),
    nights: integer('nights').notNull(),
    adults: integer('adults').notNull(),
    children: integer('children').notNull(),
    offersCount: integer('offers_count').notNull(),
    /** Beds24 room ids that had a bookable offer (empty on 'none'). */
    rooms: integer('rooms').array().notNull(),
    /** Page language, 'cs' | 'en'. */
    lang: text('lang'),
    copiedAt: timestamp('copied_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.seq] }),
    index('web_funnel_searches_arrival_idx').on(t.arrival),
  ],
);

/**
 * GA4 sessions / users / purchases per day × channel × source/medium (Data API
 * runReport, property 529936917). Consent-only sample — see the header.
 *
 * `total_users` is GA's per-day user count; summing it over days counts a returning
 * visitor once per day, so the UI labels the sum as such.
 */
export const webTrafficDaily = pgTable(
  'web_traffic_daily',
  {
    day: date('day', { mode: 'string' }).notNull(),
    channelGroup: text('channel_group').notNull(),
    sourceMedium: text('source_medium').notNull(),
    sessions: integer('sessions').notNull(),
    totalUsers: integer('total_users').notNull(),
    purchases: integer('purchases').notNull(),
    purchaseRevenue: numeric('purchase_revenue').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.channelGroup, t.sourceMedium] })],
);

export type WebFunnelDailyInsert = typeof webFunnelDaily.$inferInsert;
export type WebFunnelSearchInsert = typeof webFunnelSearches.$inferInsert;
export type WebTrafficDailyInsert = typeof webTrafficDaily.$inferInsert;
