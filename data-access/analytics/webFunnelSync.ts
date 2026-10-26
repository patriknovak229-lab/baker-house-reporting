/**
 * Web funnel — the writers. SERVER ONLY.
 *
 * 1. copyFunnelDays: the rental site's anonymous counters (its own Upstash Redis, read
 *    with a READ-ONLY token) → web_funnel_daily / web_funnel_searches.
 * 2. syncGaTraffic: GA4 Data API → web_traffic_daily.
 *
 * Both are idempotent upserts on natural keys, so the nightly cron can re-copy the
 * last few days every run (absorbing a missed night) and a backfill can be re-run at
 * will. A day that has expired from Redis (180-day TTL) returns nothing and leaves its
 * Postgres rows untouched — Postgres is the archive, Redis only the inbox.
 *
 * The rental-site Redis is a DIFFERENT Upstash database from this app's own. Only GET
 * commands are issued against it; use the read-only token so a bug here can't write.
 */
import { Redis } from '@upstash/redis';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { webFunnelDaily, webFunnelSearches, webTrafficDaily } from '@/lib/db/schema';
import { fetchGaTraffic, ga4Credentials } from '@/utils/ga4';
import {
  DEFAULT_FUNNEL_KEY_PREFIX,
  funnelDayKey,
  funnelSearchesKey,
  parseCounterHash,
  parseSearchRecord,
  type FunnelMetricRow,
  type FunnelSearchRow,
  type GaTrafficRow,
} from '@/utils/webFunnel';

const BATCH = 500;

export function funnelRedisConfigured(): boolean {
  return !!(process.env.RENTAL_SITE_REDIS_REST_URL && process.env.RENTAL_SITE_REDIS_REST_TOKEN);
}

export function gaConfigured(): boolean {
  return ga4Credentials() !== null;
}

/** `bh:funnel` unless overridden — `bh:funnel:dev` reads what `astro dev` wrote. */
export function funnelKeyPrefix(): string {
  const p = process.env.FUNNEL_KEY_PREFIX?.trim();
  return p && /^[a-z0-9:_-]{3,40}$/i.test(p) ? p : DEFAULT_FUNNEL_KEY_PREFIX;
}

function rentalSiteRedis(): Redis {
  return new Redis({
    url: process.env.RENTAL_SITE_REDIS_REST_URL!,
    token: process.env.RENTAL_SITE_REDIS_REST_TOKEN!,
  });
}

async function inBatches<T>(rows: T[], write: (batch: T[]) => Promise<unknown>): Promise<number> {
  for (let i = 0; i < rows.length; i += BATCH) await write(rows.slice(i, i + BATCH));
  return rows.length;
}

// Upsert builders are exported so the tests can assert the ON CONFLICT clause
// without a database (drizzle's .toSQL() never executes).

export function upsertFunnelMetrics(rows: FunnelMetricRow[]) {
  return db
    .insert(webFunnelDaily)
    .values(rows.map((r) => ({ day: r.day, metric: r.metric, value: String(r.value) })))
    .onConflictDoUpdate({
      target: [webFunnelDaily.day, webFunnelDaily.metric],
      set: { value: sql`excluded.value`, copiedAt: sql`now()` },
    });
}

export function upsertFunnelSearches(rows: FunnelSearchRow[]) {
  return db
    .insert(webFunnelSearches)
    .values(rows)
    .onConflictDoUpdate({
      target: [webFunnelSearches.day, webFunnelSearches.seq],
      set: {
        kind: sql`excluded.kind`,
        arrival: sql`excluded.arrival`,
        departure: sql`excluded.departure`,
        nights: sql`excluded.nights`,
        adults: sql`excluded.adults`,
        children: sql`excluded.children`,
        offersCount: sql`excluded.offers_count`,
        rooms: sql`excluded.rooms`,
        lang: sql`excluded.lang`,
        copiedAt: sql`now()`,
      },
    });
}

export function upsertGaTraffic(rows: GaTrafficRow[]) {
  return db
    .insert(webTrafficDaily)
    .values(rows.map((r) => ({ ...r, purchaseRevenue: String(r.purchaseRevenue) })))
    .onConflictDoUpdate({
      target: [webTrafficDaily.day, webTrafficDaily.channelGroup, webTrafficDaily.sourceMedium],
      set: {
        sessions: sql`excluded.sessions`,
        totalUsers: sql`excluded.total_users`,
        purchases: sql`excluded.purchases`,
        purchaseRevenue: sql`excluded.purchase_revenue`,
        fetchedAt: sql`now()`,
      },
    });
}

export interface FunnelCopyResult {
  configured: boolean;
  prefix: string;
  days: { day: string; metrics: number; searches: number; skippedRecords: number }[];
  metricRows: number;
  searchRows: number;
}

export interface FunnelInbox {
  prefix: string;
  days: FunnelCopyResult['days'];
  metricRows: FunnelMetricRow[];
  searchRows: FunnelSearchRow[];
}

/** Read and parse the given Prague days from the rental-site Redis (GET commands only). */
export async function readFunnelInbox(days: string[]): Promise<FunnelInbox> {
  const prefix = funnelKeyPrefix();
  // One round trip for the whole range: HGETALL + LRANGE per day.
  const pipe = rentalSiteRedis().pipeline();
  for (const day of days) {
    pipe.hgetall(funnelDayKey(prefix, day));
    pipe.lrange(funnelSearchesKey(prefix, day), 0, -1);
  }
  const replies = days.length > 0 ? await pipe.exec() : [];

  const metricRows: FunnelMetricRow[] = [];
  const searchRows: FunnelSearchRow[] = [];
  const perDay: FunnelCopyResult['days'] = [];
  days.forEach((day, i) => {
    const metrics = parseCounterHash(day, replies[i * 2]);
    const list = Array.isArray(replies[i * 2 + 1]) ? (replies[i * 2 + 1] as unknown[]) : [];
    let skipped = 0;
    const searches: FunnelSearchRow[] = [];
    list.forEach((raw, seq) => {
      const row = parseSearchRecord(day, seq, raw);
      if (row) searches.push(row);
      else skipped++;
    });
    metricRows.push(...metrics);
    searchRows.push(...searches);
    perDay.push({ day, metrics: metrics.length, searches: searches.length, skippedRecords: skipped });
  });
  return { prefix, days: perDay, metricRows, searchRows };
}

/** Copy the given Prague days from the rental-site Redis into Postgres. */
export async function copyFunnelDays(days: string[]): Promise<FunnelCopyResult> {
  if (!funnelRedisConfigured()) {
    return { configured: false, prefix: funnelKeyPrefix(), days: [], metricRows: 0, searchRows: 0 };
  }
  const inbox = await readFunnelInbox(days);
  await inBatches(inbox.metricRows, (batch) => upsertFunnelMetrics(batch));
  await inBatches(inbox.searchRows, (batch) => upsertFunnelSearches(batch));
  return {
    configured: true,
    prefix: inbox.prefix,
    days: inbox.days,
    metricRows: inbox.metricRows.length,
    searchRows: inbox.searchRows.length,
  };
}

export interface GaSyncResult {
  configured: boolean;
  from: string;
  to: string;
  rows: number;
}

/** Pull GA4 traffic for a date range and upsert it. */
export async function syncGaTraffic(from: string, to: string): Promise<GaSyncResult> {
  if (!gaConfigured()) return { configured: false, from, to, rows: 0 };
  // Merge on the primary key first: an INSERT … ON CONFLICT may not touch the same
  // row twice, and two empty dimension values both land on '(not set)'.
  const merged = new Map<string, GaTrafficRow>();
  for (const r of await fetchGaTraffic(from, to)) {
    const key = `${r.day}\u0000${r.channelGroup}\u0000${r.sourceMedium}`;
    const prev = merged.get(key);
    merged.set(
      key,
      prev
        ? {
            ...prev,
            sessions: prev.sessions + r.sessions,
            totalUsers: prev.totalUsers + r.totalUsers,
            purchases: prev.purchases + r.purchases,
            purchaseRevenue: prev.purchaseRevenue + r.purchaseRevenue,
          }
        : r,
    );
  }
  const rows = [...merged.values()];
  await inBatches(rows, (batch) => upsertGaTraffic(batch));
  return { configured: true, from, to, rows: rows.length };
}
