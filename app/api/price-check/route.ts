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
 * Sum daily price1 across the date range from a Beds24 calendar response.
 * Beds24 returns calendar entries that may either be per-day or span ranges
 * (when prices/availability are constant across multiple days). We handle both.
 */
function sumCalendarPrice(roomCalendar: unknown, arrival: string, departure: string): number | null {
  if (!Array.isArray(roomCalendar) || roomCalendar.length === 0) return null;
  const startMs = new Date(arrival + 'T00:00:00Z').getTime();
  const endMs = new Date(departure + 'T00:00:00Z').getTime(); // exclusive
  let total = 0;
  let coveredNights = 0;

  for (const entry of roomCalendar) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { from?: unknown; to?: unknown; date?: unknown; price1?: unknown };
    // Support both { date } (single day) and { from, to } (range, "to" inclusive in Beds24 calendar)
    const fromStr = typeof e.from === 'string' ? e.from : typeof e.date === 'string' ? e.date : null;
    const toStr = typeof e.to === 'string' ? e.to : fromStr;
    if (!fromStr || !toStr) continue;

    const rawPrice = e.price1;
    const price = typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(',', '.')) : Number(rawPrice);
    if (!Number.isFinite(price) || price <= 0) continue;

    // Iterate each day in the entry's range, only count days inside [arrival, departure)
    const entryStart = new Date(fromStr + 'T00:00:00Z').getTime();
    const entryEnd = new Date(toStr + 'T00:00:00Z').getTime();
    for (let t = entryStart; t <= entryEnd; t += 86_400_000) {
      if (t >= startMs && t < endMs) {
        total += price;
        coveredNights += 1;
      }
    }
  }

  return coveredNights > 0 ? Math.round(total * 100) / 100 : null;
}

/**
 * Fetch prices ignoring availability via /inventory/rooms/calendar.
 * Returns total stay price = sum of daily price1 across nights.
 */
async function fetchCalendarPrices(token: string, arrival: string, departure: string): Promise<Record<number, number | null>> {
  // Calendar endpoint takes endDate inclusive, so use departure - 1
  const endDateInclusive = previousDay(departure);

  const params = new URLSearchParams({
    startDate: arrival,
    endDate: endDateInclusive,
    propertyId: String(PROPERTY_ID),
  });
  // Beds24 V2 typically supports repeated roomId params for multi-room queries
  params.append('roomId', String(SELL_ROOM_2KK));
  params.append('roomId', String(SELL_ROOM_1KK));

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 calendar returned ${res.status}: ${text}`);
  }

  const data = await res.json();
  const rows: unknown[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];

  const priceMap: Record<number, number | null> = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rid = Number((row as { roomId?: unknown }).roomId);
    if (rid !== SELL_ROOM_2KK && rid !== SELL_ROOM_1KK) continue;
    const calendar = (row as { calendar?: unknown }).calendar;
    priceMap[rid] = sumCalendarPrice(calendar, arrival, departure);
  }
  return priceMap;
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

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'arrival and departure are required' }, { status: 400 });
  }
  if (nightsBetween(arrival, departure) <= 0) {
    return NextResponse.json({ error: 'departure must be after arrival' }, { status: 400 });
  }

  try {
    const token = await getAccessToken();

    let priceMap: Record<number, number | null>;

    if (ignoreAvailability) {
      priceMap = await fetchCalendarPrices(token, arrival, departure);
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

    return NextResponse.json({ offers, ignoreAvailability });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
