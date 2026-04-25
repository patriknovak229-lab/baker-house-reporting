import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/utils/beds24Auth';
import { requireRole } from '@/utils/authGuard';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const PROPERTY_ID = 311322;

// Sellable Beds24 room IDs (what the offers endpoint returns prices for)
const SELL_ROOM_2KK = 656437; // K.201 — 2KK Deluxe (physical = sellable, same ID)
const SELL_ROOM_1KK = 648816; // Virtual 1KK Deluxe (qty=2, maps to K.202 + K.203)

function extractPrice(roomOffers: unknown): number | null {
  if (!Array.isArray(roomOffers) || roomOffers.length === 0) return null;
  const first = roomOffers[0] as { totalPrice?: unknown; price?: unknown };
  const raw = first.totalPrice ?? first.price ?? null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

export type PriceCheckOffer = {
  room: string;      // "K.201" | "K.202 / K.203"
  description: string;
  price: number | null;
};

/** Subtract one day from a YYYY-MM-DD string (departure → last night). */
function previousDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Count nights between two YYYY-MM-DD strings (departure exclusive). */
function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival + 'T00:00:00Z').getTime();
  const b = new Date(departure + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Walk an arbitrary value tree and sum daily price1 entries that fall inside [arrival, departure).
 * The Beds24 V2 calendar response shape is undocumented in the consumer SDK and varies by version,
 * so this is intentionally permissive: any object that looks like a calendar day (has a price1
 * field plus either { from, to } or { date }) is included.
 */
function sumCalendarPrice(value: unknown, arrival: string, departure: string): number | null {
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
async function fetchRoomCalendar(
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

/**
 * Fetch prices ignoring availability via /inventory/rooms/calendar.
 * Issues one request per sellable roomId so the response shape is unambiguous.
 */
async function fetchCalendarPrices(
  token: string,
  arrival: string,
  departure: string,
): Promise<{ priceMap: Record<number, number | null>; rawByRoom: Record<number, unknown> }> {
  const [r2kk, r1kk] = await Promise.all([
    fetchRoomCalendar(token, SELL_ROOM_2KK, arrival, departure),
    fetchRoomCalendar(token, SELL_ROOM_1KK, arrival, departure),
  ]);
  return {
    priceMap: { [SELL_ROOM_2KK]: r2kk.price, [SELL_ROOM_1KK]: r1kk.price },
    rawByRoom: { [SELL_ROOM_2KK]: r2kk.raw, [SELL_ROOM_1KK]: r1kk.raw },
  };
}

/**
 * GET /api/price-check?arrival=YYYY-MM-DD&departure=YYYY-MM-DD&adults=2&children=0&ignoreAvailability=false
 * Returns per-room prices from Beds24.
 *
 * - ignoreAvailability=false (default): uses /inventory/rooms/offers — only available rooms have a price
 * - ignoreAvailability=true: uses /inventory/rooms/calendar — sums daily price1 across nights regardless of availability
 *
 * Room mapping:
 *   K.201 = Beds24 roomId 656437 (2KK Deluxe, 1 unit)
 *   K.202 / K.203 = Beds24 roomId 648816 (1KK Deluxe, virtual room qty=2)
 */
export async function GET(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const arrival = req.nextUrl.searchParams.get('arrival');
  const departure = req.nextUrl.searchParams.get('departure');
  const adults = req.nextUrl.searchParams.get('adults') ?? '2';
  const children = req.nextUrl.searchParams.get('children') ?? '0';
  const ignoreAvailability = req.nextUrl.searchParams.get('ignoreAvailability') === 'true';
  const debug = req.nextUrl.searchParams.get('debug') === '1';

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'arrival and departure are required' }, { status: 400 });
  }
  if (nightsBetween(arrival, departure) <= 0) {
    return NextResponse.json({ error: 'departure must be after arrival' }, { status: 400 });
  }

  try {
    const token = await getAccessToken();

    let priceMap: Record<number, number | null>;
    let rawByRoom: Record<number, unknown> | null = null;

    if (ignoreAvailability) {
      const result = await fetchCalendarPrices(token, arrival, departure);
      priceMap = result.priceMap;
      rawByRoom = result.rawByRoom;
    } else {
      const params = new URLSearchParams({
        propertyId: String(PROPERTY_ID),
        arrival,
        departure,
        numAdults: adults,
        numChildren: children,
      });

      const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/offers?${params.toString()}`, {
        headers: { token },
        cache: 'no-store',
      });

      if (!res.ok) {
        const text = await res.text();
        return NextResponse.json(
          { error: `Beds24 returned ${res.status}`, detail: text },
          { status: 502 },
        );
      }

      const data = await res.json();
      const rows: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

      priceMap = {};
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const rid = Number((row as { roomId?: unknown }).roomId);
        if (rid === SELL_ROOM_2KK || rid === SELL_ROOM_1KK) {
          priceMap[rid] = extractPrice((row as { offers?: unknown }).offers);
        }
      }
    }

    const offers: PriceCheckOffer[] = [
      {
        room: 'K.201',
        description: '2KK Deluxe Apartment',
        price: priceMap[SELL_ROOM_2KK] ?? null,
      },
      {
        room: 'K.202 / K.203',
        description: '1KK Deluxe Apartment',
        price: priceMap[SELL_ROOM_1KK] ?? null,
      },
    ];

    if (debug) {
      return NextResponse.json({ offers, ignoreAvailability, debug: { rawByRoom, priceMap } });
    }
    return NextResponse.json({ offers, ignoreAvailability });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
