/**
 * SERVER ONLY. Beds24 price lookups, shared by /api/price-check and
 * /api/stay-request/quote.
 *
 * TWO ENDPOINTS, TWO DIFFERENT ANSWERS — the distinction matters:
 *
 *   `/inventory/rooms/offers` returns BOOKABLE offers. Beds24 evaluates rate
 *   plans, length-of-stay pricing and restrictions, so this is the real quote —
 *   but only for a stay it can actually sell. Nothing available, no price.
 *
 *   `/inventory/rooms/calendar` returns the STORED daily rate (`price1`). It
 *   answers regardless of availability, but it is a nominal number: no rate-plan
 *   evaluation, no LOS discount, no restriction check. Summing it across nights
 *   is an estimate, and on long stays it reads HIGH versus a real offer.
 *
 * So prefer offers and fall back to the calendar, labelling which one answered —
 * a quote the operator might send a guest must never silently mix the two.
 *
 * WHAT THE CALENDAR SUM NOW INCLUDES (2026-09-03). Beds24 builds a sellable
 * price out of layers, and `price1` is only the first of them:
 *   price1 (stored daily rate)
 *     × calendar multiplier   — per date, default 1, needs includeMultiplier
 *     × bookingPageMultiplier — per property, the direct/web adjustment
 *     … then rate plans (`/inventory/fixedPrices`) can REPLACE the nightly
 *       price outright (roomPrice / 1PersonPrice / 2PersonPrice / extraPerson)
 *       and apply length-of-stay `discounts[]`, and individual rates can opt
 *       out of the multiplier via `allowMultiplier`.
 * We apply the two multipliers, read live from Beds24 rather than hardcoded.
 * We do NOT evaluate rate plans, so on a long span the nominal number still
 * reads HIGH — that is the remaining gap, and it is measured, not guessed:
 * `comparePrice()` computes both numbers for spans Beds24 will actually quote.
 */
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

/** All Baker House rooms live under one Beds24 property. */
export const BEDS24_PROPERTY_ID = 311322;

/** Where a price came from — surfaced in the UI, never hidden. */
export type PriceSource = 'offers' | 'calendar-nominal' | 'none';

export interface SegmentPrice {
  price: number | null;
  source: PriceSource;
  /** How many offers Beds24 returned (0 when the span isn't sellable). */
  offersCount: number;
}

/**
 * Read a Beds24 multiplier defensively. The property setting is typed as a
 * string with no documented format, so accept both a factor ("0.75") and a
 * percentage ("75"), and refuse anything implausible rather than silently
 * scaling a guest-facing price by a junk value.
 * Returns null when there is no usable value — callers then apply no adjustment.
 */
export function parseMultiplier(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A factor above 3 is not a factor — Beds24 UIs also express these as percent.
  const factor = n > 3 ? n / 100 : n;
  return factor > 0 && factor <= 3 ? factor : null;
}

/**
 * Property settings change about never, and every price check would otherwise
 * spend a Beds24 credit on them (there is a rolling 5-minute limit), so cache.
 */
let multiplierCache: { value: number | null; raw: unknown; at: number } | null = null;
const MULTIPLIER_TTL_MS = 60 * 60 * 1000;

/** The property's booking-page (direct/web) multiplier, or null if unset. */
export async function fetchBookingPageMultiplier(
  token: string,
): Promise<{ value: number | null; raw: unknown }> {
  if (multiplierCache && Date.now() - multiplierCache.at < MULTIPLIER_TTL_MS) {
    return { value: multiplierCache.value, raw: multiplierCache.raw };
  }

  const res = await fetch(`${BEDS24_API_BASE}/properties?id=${BEDS24_PROPERTY_ID}`, {
    headers: { token },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 properties returned ${res.status}: ${text}`);
  }

  const json = (await res.json()) as { data?: { bookingPageMultiplier?: unknown }[] };
  const raw = Array.isArray(json?.data) ? json.data[0]?.bookingPageMultiplier : undefined;
  const value = parseMultiplier(raw);
  multiplierCache = { value, raw, at: Date.now() };
  return { value, raw };
}

/** Test seam — drops the cached property multiplier. */
export function resetMultiplierCache(): void {
  multiplierCache = null;
}

/** Subtract one day from a YYYY-MM-DD string (departure → last night). */
export function previousDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Price of a room's offer list. Beds24 orders its own offers, so the first one
 * is the one it would sell — no cheapest-of scan on our side (operator's call,
 * 2026-08-19).
 */
export function extractPrice(roomOffers: unknown): number | null {
  if (!Array.isArray(roomOffers) || roomOffers.length === 0) return null;
  const first = roomOffers[0] as { totalPrice?: unknown; price?: unknown };
  const raw = first.totalPrice ?? first.price ?? null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** How many offers came back for a room — 0 means "not sellable as asked". */
export function countOffers(roomOffers: unknown): number {
  return Array.isArray(roomOffers) ? roomOffers.length : 0;
}

/**
 * Walk an arbitrary value tree and sum daily price1 entries that fall inside
 * [arrival, departure). The Beds24 V2 calendar response shape is undocumented in
 * the consumer SDK and varies by version, so this is intentionally permissive:
 * any object that looks like a calendar day (has a price1 field plus either
 * { from, to } or { date }) is included.
 *
 * Each night is scaled by that date's `multiplier` (Beds24 default 1, present
 * only when the caller passed includeMultiplier). A date-level adjustment is
 * part of the stored price, so ignoring it understates or overstates the night.
 */
export function sumCalendarPrice(value: unknown, arrival: string, departure: string): number | null {
  const startMs = new Date(arrival + 'T00:00:00Z').getTime();
  const endMs = new Date(departure + 'T00:00:00Z').getTime(); // exclusive
  let total = 0;
  let coveredNights = 0;

  function visit(node: unknown) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;

    // Heuristic: a calendar day entry has price1 + a date field
    const hasPrice = 'price1' in obj || 'price' in obj;
    const fromStr = typeof obj.from === 'string' ? obj.from
      : typeof obj.date === 'string' ? obj.date : null;
    const toStr = typeof obj.to === 'string' ? obj.to : fromStr;

    if (hasPrice && fromStr && toStr && /^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
      const rawPrice = obj.price1 ?? obj.price;
      const price = typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(',', '.')) : Number(rawPrice);
      const dayMultiplier = parseMultiplier(obj.multiplier) ?? 1;
      if (Number.isFinite(price) && price > 0) {
        const entryStart = new Date(fromStr + 'T00:00:00Z').getTime();
        const entryEnd = new Date(toStr + 'T00:00:00Z').getTime();
        for (let t = entryStart; t <= entryEnd; t += 86_400_000) {
          if (t >= startMs && t < endMs) {
            total += price * dayMultiplier;
            coveredNights += 1;
          }
        }
      }
    }

    // Recurse into child objects/arrays — handles nested { calendar: [...] } shapes
    for (const key of Object.keys(obj)) visit(obj[key]);
  }

  visit(value);
  return coveredNights > 0 ? Math.round(total * 100) / 100 : null;
}

/**
 * Fetch the calendar for a single roomId.
 * Returns { price, raw } — raw is the parsed JSON response (used by debug mode).
 */
export async function fetchRoomCalendar(
  token: string,
  roomId: number,
  arrival: string,
  departure: string,
): Promise<{ price: number | null; raw: unknown }> {
  const endDateInclusive = previousDay(departure);
  // Per Beds24 V2 spec: calendar returns nothing unless at least one includeX flag is set.
  // includePrices gives price1; includeMultiplier gives the per-date factor that
  // scales it. Without the second flag the field is simply absent and every
  // night silently counts at multiplier 1.
  const params = new URLSearchParams({
    startDate: arrival,
    endDate: endDateInclusive,
    roomId: String(roomId),
    includePrices: 'true',
    includeMultiplier: 'true',
  });

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 calendar (room ${roomId}) returned ${res.status}: ${text}`);
  }

  const raw = await res.json();
  const price = sumCalendarPrice(raw, arrival, departure);
  return { price, raw };
}

/** Raw offers response for a whole property over one span. */
export async function fetchOffers(
  token: string,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<unknown> {
  const params = new URLSearchParams({
    propertyId: String(BEDS24_PROPERTY_ID),
    arrival,
    departure,
    numAdults: String(adults),
    numChildren: String(children),
  });

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/offers?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 offers returned ${res.status}: ${text}`);
  }
  return res.json();
}

/** Pull one room's offer list out of an offers response. */
export function offersForRoom(data: unknown, roomId: number): unknown {
  const container = data as { data?: unknown } | null;
  const rows: unknown[] = Array.isArray(container?.data)
    ? (container!.data as unknown[])
    : Array.isArray(data)
      ? (data as unknown[])
      : [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (Number((row as { roomId?: unknown }).roomId) === roomId) {
      return (row as { offers?: unknown }).offers;
    }
  }
  return null;
}

/**
 * Price ONE itinerary segment: a real Beds24 offer when the span is sellable,
 * otherwise the nominal calendar sum, always saying which it was. A segment that
 * looks free in our own occupancy data can still yield no offer — a min-stay or
 * max-stay restriction, or a guest count over capacity, is enough — so the
 * fallback keeps the operator informed instead of showing a blank.
 */
export async function priceSegment(
  roomId: number,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<SegmentPrice> {
  const token = await getAccessToken();

  const offersData = await fetchOffers(token, arrival, departure, adults, children);
  const roomOffers = offersForRoom(offersData, roomId);
  const offerPrice = extractPrice(roomOffers);
  if (offerPrice !== null) {
    return { price: offerPrice, source: 'offers', offersCount: countOffers(roomOffers) };
  }

  const { price } = await nominalWebPrice(token, roomId, arrival, departure);
  return {
    price,
    source: price === null ? 'none' : 'calendar-nominal',
    offersCount: countOffers(roomOffers),
  };
}

/**
 * The "if it were free, what would the web charge?" number: the stored daily
 * rates for the span, scaled by each date's multiplier and then by the
 * property's booking-page multiplier.
 *
 * Still NOT a Beds24 quote — rate plans and their length-of-stay discounts are
 * not evaluated — so it reads high on long spans. Callers must keep labelling
 * it as an estimate; `basePrice` and `bookingPageMultiplier` are returned so the
 * operator can see how the number was built rather than trusting it blind.
 */
export interface NominalWebPrice {
  /** After both multipliers — the number to show. */
  price: number | null;
  /** Sum of price1 × per-date multiplier, before the booking-page multiplier. */
  basePrice: number | null;
  /** The factor applied, or null when Beds24 has none set. */
  bookingPageMultiplier: number | null;
  /** Exactly what Beds24 returned for the setting, for debugging. */
  bookingPageMultiplierRaw: unknown;
  raw?: unknown;
}

export async function nominalWebPrice(
  token: string,
  roomId: number,
  arrival: string,
  departure: string,
): Promise<NominalWebPrice> {
  const [{ price: basePrice, raw }, multiplier] = await Promise.all([
    fetchRoomCalendar(token, roomId, arrival, departure),
    fetchBookingPageMultiplier(token).catch(() => ({ value: null, raw: undefined })),
  ]);

  const factor = multiplier.value ?? 1;
  return {
    price: basePrice === null ? null : Math.round(basePrice * factor * 100) / 100,
    basePrice,
    bookingPageMultiplier: multiplier.value,
    bookingPageMultiplierRaw: multiplier.raw,
    raw,
  };
}

/**
 * Measure the gap instead of assuming it: for one span, the real Beds24 offer
 * next to our nominal estimate. Only spans Beds24 will actually quote produce
 * both numbers — which is the point, since that is where the estimate can be
 * checked. `ratio` is offer ÷ nominal: at 1.0 the estimate is exact, below 1.0
 * a rate plan (usually a length-of-stay discount) is doing something we do not
 * model yet.
 */
export interface PriceComparison {
  roomId: number;
  arrival: string;
  departure: string;
  nights: number;
  offerPrice: number | null;
  nominalPrice: number | null;
  basePrice: number | null;
  bookingPageMultiplier: number | null;
  ratio: number | null;
}

export async function comparePrice(
  roomId: number,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<PriceComparison> {
  const token = await getAccessToken();
  const nights = Math.round(
    (Date.parse(departure + 'T00:00:00Z') - Date.parse(arrival + 'T00:00:00Z')) / 86_400_000,
  );

  const [offersData, nominal] = await Promise.all([
    fetchOffers(token, arrival, departure, adults, children),
    nominalWebPrice(token, roomId, arrival, departure),
  ]);
  const offerPrice = extractPrice(offersForRoom(offersData, roomId));

  return {
    roomId,
    arrival,
    departure,
    nights,
    offerPrice,
    nominalPrice: nominal.price,
    basePrice: nominal.basePrice,
    bookingPageMultiplier: nominal.bookingPageMultiplier,
    ratio:
      offerPrice !== null && nominal.price !== null && nominal.price > 0
        ? Math.round((offerPrice / nominal.price) * 1000) / 1000
        : null,
  };
}
