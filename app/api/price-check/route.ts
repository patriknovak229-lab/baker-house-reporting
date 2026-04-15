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

/**
 * GET /api/price-check?arrival=YYYY-MM-DD&departure=YYYY-MM-DD&adults=2&children=0
 * Returns per-room prices from Beds24 offers endpoint.
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

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'arrival and departure are required' }, { status: 400 });
  }

  try {
    const token = await getAccessToken();

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

    // Extract prices from Beds24 response keyed by sellable roomId
    const priceMap: Record<number, number | null> = {};
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue;
      const rid = Number((row as { roomId?: unknown }).roomId);
      if (rid === SELL_ROOM_2KK || rid === SELL_ROOM_1KK) {
        priceMap[rid] = extractPrice((row as { offers?: unknown }).offers);
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

    return NextResponse.json({ offers });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
