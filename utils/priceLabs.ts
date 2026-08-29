/**
 * PriceLabs Customer API client — READ ONLY.
 *
 * SERVER ONLY. Reads `PRICELABS_API_KEY` from the environment, so it must never
 * be imported from a client component (see the note at the top of
 * `utils/analyticsTypes.ts` for what that mistake costs).
 *
 * SCOPE DISCIPLINE: this module exposes only GETs and the one POST that reads
 * prices. PriceLabs also has `update_listing_data`,
 * `update_listing_date_overrides`, `delete_listing_date_overrides` and
 * `refresh_listing_pricing` — all of which change what guests are charged on live
 * listings. They are deliberately absent. PriceLabs is the property's pricing
 * engine; analytics observes it and never steers it. Adding a write here would
 * make a reporting page capable of moving rates, which is not a capability this
 * app should have.
 *
 * WHAT THE DATA IS: a comp set scraped from Airbnb and VRBO around the property's
 * coordinates, bucketed by bedroom count. Occupancy inference is sound even for
 * Booking.com-dominated listings (a channel manager blocks the Airbnb calendar
 * when any channel books, and their inferred occupancy for K.201 matched our own
 * archive to the decimal). Price percentiles are an Airbnb-LISTED view and carry a
 * different fee load than our Booking.com-facing rates — context, not a target.
 *
 * Gotcha worth keeping: Cloudflare fronts this API and rejects unrecognised user
 * agents with an empty-bodied 403 and `error code: 1010`. Node's fetch is fine.
 */

const BASE_URL = 'https://api.pricelabs.co/v1';

/** How long a single call may take before we give up and keep the older snapshot. */
const TIMEOUT_MS = 60_000;

export class PriceLabsError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PriceLabsError';
  }
}

export function priceLabsConfigured(): boolean {
  return !!process.env.PRICELABS_API_KEY;
}

function apiKey(): string {
  const key = process.env.PRICELABS_API_KEY;
  if (!key) {
    throw new PriceLabsError(
      'PRICELABS_API_KEY is not set. Market benchmarks stay unavailable until it is.',
    );
  }
  return key;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'X-API-Key': apiKey(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: 'no-store',
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new PriceLabsError(`PriceLabs ${path} → HTTP ${res.status}: ${body}`, res.status);
  }
  return (await res.json()) as T;
}

// ── Sentinels and coercion ───────────────────────────────────────────────────

/**
 * PriceLabs encodes "no data" as small negative numbers, and they are NOT
 * interchangeable: -1 means the date is unavailable/unbookable, -2 means there is
 * no same-time-last-year to compare against (which is every STLY field on this
 * account — the business started trading in 2026), -4 appears on weekend splits
 * with too few observations. All of them would poison an average if treated as
 * zero, so everything numeric goes through this.
 */
export function plNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return null;
  return num <= -1 && num >= -5 ? null : num;
}

/** "49 %" → 0.49. Their listing summary returns percentages as strings. */
export function plPercentString(value: unknown): number | null {
  if (typeof value !== 'string') return plNumber(value) === null ? null : plNumber(value)! / 100;
  const parsed = Number(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

/** A percentage-valued number (0–100) → ratio (0–1), respecting the sentinels. */
export function plRatio(value: unknown): number | null {
  const num = plNumber(value);
  return num === null ? null : num / 100;
}

// ── /listings ────────────────────────────────────────────────────────────────

export interface PriceLabsListing {
  id: string;
  pms: string;
  name: string;
  latitude: string;
  longitude: string;
  city_name: string;
  currency: string;
  no_of_bedrooms: number;
  min: number | null;
  base: number | null;
  max: number | null;
  recommended_base_price: number | null;
  isHidden: boolean;
  push_enabled: boolean;
  last_refreshed_at: string | null;
  /** Percent strings, e.g. "90 %". Own-side values are unreliable for multi-unit listings. */
  occupancy_next_7?: string;
  occupancy_next_30?: string;
  occupancy_next_60?: string;
  market_occupancy_next_7?: string;
  market_occupancy_next_30?: string;
  market_occupancy_next_60?: string;
}

export async function fetchListings(): Promise<PriceLabsListing[]> {
  const body = await call<{ listings?: PriceLabsListing[] }>('/listings');
  return body.listings ?? [];
}

// ── /listing_metrics ─────────────────────────────────────────────────────────

/**
 * Metrics keyed by horizon in days: positive = the next N days, negative = the
 * trailing N days. Keys in the 990s are their own aggregate buckets (year to
 * date, and so on) and are ignored here.
 */
export type HorizonMap = Record<string, number>;

export interface ListingMetrics {
  listing_level: {
    occupancy?: HorizonMap;
    adjusted_occupancy?: HorizonMap;
    revenue?: HorizonMap;
    adr?: HorizonMap;
    revpar?: HorizonMap;
  };
  market_level: {
    occupancy?: HorizonMap;
    adjusted_occupancy?: HorizonMap;
    weekend_total_occupancy?: HorizonMap;
    weekday_total_occupancy?: HorizonMap;
    currency?: string;
  };
}

export async function fetchListingMetrics(
  listingId: string,
  pms = 'beds24',
): Promise<ListingMetrics> {
  const body = await call<{ data: ListingMetrics }>(
    `/listing_metrics?listing_id=${encodeURIComponent(listingId)}&pms_name=${encodeURIComponent(pms)}`,
  );
  return body.data;
}

// ── /neighborhood_data ───────────────────────────────────────────────────────

/**
 * One chart block. `X_values` are the categories (dates or month labels) and
 * `Y_values` holds one series per entry in `Labels`, in the same order.
 *
 * Inconsistency to absorb, not fight: some blocks nest each series one level
 * deeper than others (`Future Occ/New/Canc` gives `[[...]]`, `Future Percentile
 * Prices` gives `[...]`). `series()` normalises both.
 */
export interface NeighborhoodBlock {
  X_values: string[];
  Y_values: (number[] | number[][])[];
  'Listings Used'?: number;
}

export interface NeighborhoodData {
  'Listings Used'?: number;
  currency?: string;
  lat?: number;
  lng?: number;
  source?: string;
  /** Keyed by bedroom count as a string: '1', '2', '3', '-1' (studio/unknown). */
  'Future Occ/New/Canc'?: { Labels: string[]; Category: Record<string, NeighborhoodBlock> };
  'Future Percentile Prices'?: { Labels: string[]; Category: Record<string, NeighborhoodBlock> };
  'Future Percentile Prices Monthly'?: { Labels: string[]; Category: Record<string, NeighborhoodBlock> };
  'Market KPI'?: { Labels: string[]; Category: Record<string, NeighborhoodBlock> };
  'Neighborhood Data Source'?: string;
}

export async function fetchNeighborhoodData(
  listingId: string,
  pms = 'beds24',
): Promise<NeighborhoodData> {
  const body = await call<{ data: NeighborhoodData; status?: string }>(
    `/neighborhood_data?listing_id=${encodeURIComponent(listingId)}&pms=${encodeURIComponent(pms)}`,
  );
  return body.data;
}

/**
 * Pull one named series out of a block, aligned to `X_values`.
 *
 * Returns nulls rather than zeros for missing points: a market occupancy of 0% and
 * "we have no reading" plot identically on a line chart but mean opposite things.
 */
export function series(
  block: NeighborhoodBlock | undefined,
  labels: string[] | undefined,
  label: string,
): (number | null)[] {
  if (!block || !labels) return [];
  const index = labels.indexOf(label);
  if (index < 0) return [];
  const raw = block.Y_values?.[index];
  if (!raw) return [];
  const flat = (Array.isArray(raw[0]) ? (raw as number[][])[0] : raw) as number[];
  return (flat ?? []).map((v) => plNumber(v));
}

/** "Aug 2024" → "2024-08". Returns null for their aggregate rows ("Last 365 Days"). */
export function monthLabelToIso(label: string): string | null {
  const match = /^([A-Z][a-z]{2})\s+(\d{4})$/.exec(label.trim());
  if (!match) return /^\d{4}-\d{2}$/.test(label.trim()) ? label.trim() : null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(match[1]) + 1;
  return month > 0 ? `${match[2]}-${String(month).padStart(2, '0')}` : null;
}

// ── POST /listing_prices ─────────────────────────────────────────────────────

export interface ListingPriceDay {
  date: string;
  /** PriceLabs' recommendation for this night. */
  price: number;
  /** What is actually live on Beds24. -1 when the night is unavailable or booked. */
  user_price: number;
  uncustomized_price?: number;
  min_stay?: number;
  booking_status?: string;
  /** Achieved ADR for the night, where PriceLabs can see it. */
  ADR?: number;
  booked_date?: string;
  unbookable?: number;
  occupancy?: number;
  /** 'Low Demand' | 'Normal Demand' | 'Good Demand' | 'High Demand' | 'Unavailable'. */
  demand_desc?: string;
  /** Hex color for the same classification — what their calendar paints. */
  demand_color?: string;
}

export interface ListingPrices {
  id: string;
  pms: string;
  currency: string;
  last_refreshed_at: string | null;
  data: ListingPriceDay[];
}

/**
 * Recommended and live prices per night.
 *
 * A POST that only reads — PriceLabs' own API design, not ours. `reason` is left
 * off: the factor breakdown is interesting when diagnosing one date by hand, and
 * multiplies the payload when pulling a year.
 */
export async function fetchListingPrices(
  listingId: string,
  dateFrom: string,
  dateTo: string,
  pms = 'beds24',
): Promise<ListingPrices | null> {
  const body = await call<ListingPrices[]>('/listing_prices', {
    method: 'POST',
    body: JSON.stringify({
      listings: [{ id: listingId, pms, dateFrom, dateTo, reason: false }],
    }),
  });
  return body.find((entry) => entry.id === listingId) ?? body[0] ?? null;
}
