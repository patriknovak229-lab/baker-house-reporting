/**
 * Web funnel — the pure half: the rental site's Redis contract, parsing of what the
 * nightly copy reads, and the funnel/bucketing maths the tab shows.
 *
 * KEEP THIS MODULE FREE OF SERVER-ONLY IMPORTS — the Web funnel section imports it in
 * the browser for day/week/month bucketing. Redis and Postgres access live in
 * data-access/analytics/webFunnelSync.ts.
 *
 * THE CONTRACT (mirrors rental-site src/lib/funnel-events.ts — keep the two in step)
 *   {prefix}:d:{YYYY-MM-DD}  HASH  counters for one Prague day
 *   {prefix}:s:{YYYY-MM-DD}  LIST  one JSON record per search, append-only, capped
 * prefix = `bh:funnel` in production (`bh:funnel:dev` is what `astro dev` writes).
 * Counter fields: `{event}` · `{event}|lang={cs|en}` · `{event}|room={beds24 id}` ·
 *   `{event}|combo` · `select_item|method={user|preselected}` · `{event}|value` (CZK) ·
 *   `_accepted` · `_dropped|{bot|rate|cap|invalid|dupe}`
 * Search record: {e:'v'|'n', a, d, ad, ch, o, r:[room ids], l?:'cs'|'en'}
 */

export const DEFAULT_FUNNEL_KEY_PREFIX = 'bh:funnel';

export function funnelDayKey(prefix: string, day: string): string {
  return `${prefix}:d:${day}`;
}

export function funnelSearchesKey(prefix: string, day: string): string {
  return `${prefix}:s:${day}`;
}

// ── Dates ────────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

export function addDaysIso(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function daysBetweenIso(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Every day from `from` to `to`, inclusive. Empty when the range is inverted. */
export function dayList(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysIso(d, 1)) out.push(d);
  return out;
}

// ── Parsing what the copy reads out of Redis ─────────────────────────────────

export interface FunnelMetricRow {
  day: string;
  metric: string;
  value: number;
}

/** Field names the site writes; anything else in the hash is not ours and is skipped. */
const METRIC_NAME = /^[a-z_]{1,40}(\|[a-z_]{1,20}(=[a-z0-9_-]{1,20})?)?$/;

/**
 * HGETALL result → rows. Upstash deserialises numeric strings to numbers, so both
 * shapes are accepted; negatives, NaN and unknown field names are dropped.
 */
export function parseCounterHash(day: string, hash: unknown): FunnelMetricRow[] {
  if (!hash || typeof hash !== 'object' || Array.isArray(hash)) return [];
  const rows: FunnelMetricRow[] = [];
  for (const [metric, raw] of Object.entries(hash as Record<string, unknown>)) {
    if (!METRIC_NAME.test(metric)) continue;
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0) continue;
    rows.push({ day, metric, value });
  }
  return rows.sort((a, b) => a.metric.localeCompare(b.metric));
}

export interface FunnelSearchRow {
  day: string;
  seq: number;
  kind: 'offers' | 'none';
  arrival: string;
  departure: string;
  nights: number;
  adults: number;
  children: number;
  offersCount: number;
  rooms: number[];
  lang: 'cs' | 'en' | null;
}

function smallInt(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

/**
 * One LRANGE element → row, or null when it is not a well-formed record. Upstash
 * hands JSON list elements back already parsed; a plain string is parsed here.
 */
export function parseSearchRecord(day: string, seq: number, raw: unknown): FunnelSearchRow | null {
  let rec: unknown = raw;
  if (typeof raw === 'string') {
    try {
      rec = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const r = rec as Record<string, unknown>;
  if (r.e !== 'v' && r.e !== 'n') return null;
  if (!isIsoDate(r.a) || !isIsoDate(r.d)) return null;
  const nights = daysBetweenIso(r.a, r.d);
  if (nights < 1 || nights > 60) return null;
  const adults = smallInt(r.ad, 20);
  const children = smallInt(r.ch, 20);
  const offers = smallInt(r.o, 50);
  if (adults == null || children == null || offers == null) return null;
  const rooms = Array.isArray(r.r)
    ? [...new Set(r.r.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x > 0))]
    : [];
  return {
    day,
    seq,
    kind: r.e === 'v' ? 'offers' : 'none',
    arrival: r.a,
    departure: r.d,
    nights,
    adults,
    children,
    offersCount: offers,
    rooms,
    lang: r.l === 'cs' || r.l === 'en' ? r.l : null,
  };
}

// ── GA4 Data API ─────────────────────────────────────────────────────────────

export interface GaTrafficRow {
  day: string;
  channelGroup: string;
  sourceMedium: string;
  sessions: number;
  totalUsers: number;
  purchases: number;
  purchaseRevenue: number;
}

interface GaReportLike {
  dimensionHeaders?: { name?: string | null }[] | null;
  metricHeaders?: { name?: string | null }[] | null;
  rows?: { dimensionValues?: { value?: string | null }[] | null; metricValues?: { value?: string | null }[] | null }[] | null;
}

/**
 * runReport response → rows, matching columns by header NAME rather than position so
 * a reordered request can't silently swap sessions and users. GA's date is YYYYMMDD.
 */
export function parseGaReport(report: GaReportLike): GaTrafficRow[] {
  const dims = (report.dimensionHeaders ?? []).map((h) => h.name ?? '');
  const mets = (report.metricHeaders ?? []).map((h) => h.name ?? '');
  const di = (name: string) => dims.indexOf(name);
  const mi = (name: string) => mets.indexOf(name);
  const num = (v: string | null | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const out: GaTrafficRow[] = [];
  for (const row of report.rows ?? []) {
    const dv = row.dimensionValues ?? [];
    const mv = row.metricValues ?? [];
    const rawDate = dv[di('date')]?.value ?? '';
    if (!/^\d{8}$/.test(rawDate)) continue;
    out.push({
      day: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
      channelGroup: dv[di('sessionDefaultChannelGroup')]?.value || '(not set)',
      sourceMedium: dv[di('sessionSourceMedium')]?.value || '(not set)',
      sessions: Math.round(num(mv[mi('sessions')]?.value)),
      totalUsers: Math.round(num(mv[mi('totalUsers')]?.value)),
      purchases: Math.round(num(mv[mi('ecommercePurchases')]?.value)),
      purchaseRevenue: num(mv[mi('purchaseRevenue')]?.value),
    });
  }
  return out;
}

// ── Funnel maths (server and browser) ────────────────────────────────────────

/** The steps the tab shows, from our own counters. */
export interface FunnelCounts {
  /** view_item_list + no_availability — every search that came back. */
  searches: number;
  /** view_item_list — at least one bookable offer shown. */
  offersShown: number;
  noAvailability: number;
  /** select_item — one per offer chosen (a guest switching cards counts each). */
  selected: number;
  /** begin_checkout — contact form opened. */
  contactForm: number;
  /** add_payment_info — redirected to Stripe Checkout. */
  toStripe: number;
  /** purchase — booking-success confirmed view (reloads de-duped by the site). */
  confirmed: number;
  /** generate_lead — corporate enquiry sent. */
  leads: number;
  toStripeValue: number;
  confirmedValue: number;
}

export const EMPTY_FUNNEL: FunnelCounts = {
  searches: 0,
  offersShown: 0,
  noAvailability: 0,
  selected: 0,
  contactForm: 0,
  toStripe: 0,
  confirmed: 0,
  leads: 0,
  toStripeValue: 0,
  confirmedValue: 0,
};

/**
 * Counters → funnel steps. `suffix` selects a slice of the same counters, e.g.
 * `|lang=en` for the English pages.
 */
export function funnelFromMetrics(metrics: Record<string, number>, suffix = ''): FunnelCounts {
  const m = (event: string) => metrics[`${event}${suffix}`] ?? 0;
  const v = (event: string) => (suffix ? 0 : (metrics[`${event}|value`] ?? 0));
  return {
    searches: m('view_item_list') + m('no_availability'),
    offersShown: m('view_item_list'),
    noAvailability: m('no_availability'),
    selected: m('select_item'),
    contactForm: m('begin_checkout'),
    toStripe: m('add_payment_info'),
    confirmed: m('purchase'),
    leads: m('generate_lead'),
    toStripeValue: v('add_payment_info'),
    confirmedValue: v('purchase'),
  };
}

export function addFunnel(a: FunnelCounts, b: FunnelCounts): FunnelCounts {
  const out = { ...a };
  for (const k of Object.keys(out) as (keyof FunnelCounts)[]) out[k] = a[k] + b[k];
  return out;
}

/** Room-level counters: `{event}|room={id}` → { id → { event → count } }. */
export function roomCounters(metrics: Record<string, number>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [metric, value] of Object.entries(metrics)) {
    const match = /^([a-z_]+)\|room=(\d+)$/.exec(metric);
    if (!match) continue;
    (out[match[2]] ??= {})[match[1]] = (out[match[2]]?.[match[1]] ?? 0) + value;
  }
  return out;
}

export type Granularity = 'day' | 'week' | 'month';

/** Bucket label: the day itself, the Monday of its ISO week, or YYYY-MM. */
export function bucketOf(day: string, granularity: Granularity): string {
  if (granularity === 'day') return day;
  if (granularity === 'month') return day.slice(0, 7);
  const d = new Date(`${day}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7; // Monday = 0
  return addDaysIso(day, -offset);
}

/** Group per-day rows into buckets, summing every numeric field. */
export function bucketRows<T extends { day: string }>(
  rows: T[],
  granularity: Granularity,
  sum: (a: T, b: T) => T,
): (T & { bucket: string })[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const key = bucketOf(row.day, granularity);
    const prev = map.get(key);
    map.set(key, prev ? sum(prev, row) : row);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, row]) => ({ ...row, bucket }));
}

/** Safe step conversion, 0–1; null when there is nothing to convert from. */
export function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

// ── Sync range (cron default or an admin backfill) ───────────────────────────

/**
 * `?from&to` for the sync routes. Both absent → the default window. Bad input is
 * rejected rather than clamped, matching the analytics routes: a backfill that
 * silently copied a different range would look like missing data later.
 */
export function resolveSyncRange(
  params: { from: string | null; to: string | null },
  opts: { todayIso: string; defaultBackDays: number; defaultEndBackDays?: number; maxDays: number },
): { from: string; to: string } | { error: string } {
  const defaultTo = addDaysIso(opts.todayIso, -(opts.defaultEndBackDays ?? 0));
  const from = params.from ?? (params.to ? null : addDaysIso(opts.todayIso, -opts.defaultBackDays));
  const to = params.to ?? defaultTo;
  if (!from || !isIsoDate(from) || !isIsoDate(to)) return { error: 'from and to must both be YYYY-MM-DD' };
  if (from > to) return { error: 'from must not be after to' };
  if (to > opts.todayIso) return { error: 'to must not be in the future' };
  const span = daysBetweenIso(from, to) + 1;
  if (span > opts.maxDays) return { error: `Range too large (${span} days). Maximum is ${opts.maxDays}.` };
  return { from, to };
}
