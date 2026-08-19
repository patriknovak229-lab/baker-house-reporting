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
      if (Number.isFinite(price) && price > 0) {
        const entryStart = new Date(fromStr + 'T00:00:00Z').getTime();
        const entryEnd = new Date(toStr + 'T00:00:00Z').getTime();
        for (let t = entryStart; t <= entryEnd; t += 86_400_000) {
          if (t >= startMs && t < endMs) {
            total += price;
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
  // includePrices=true is what we need; we don't care about availability/restrictions here.
  const params = new URLSearchParams({
    startDate: arrival,
    endDate: endDateInclusive,
    roomId: String(roomId),
    includePrices: 'true',
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

  const { price } = await fetchRoomCalendar(token, roomId, arrival, departure);
  return {
    price,
    source: price === null ? 'none' : 'calendar-nominal',
    offersCount: countOffers(roomOffers),
  };
}
