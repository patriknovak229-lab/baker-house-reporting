import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/utils/beds24Auth';
import { requireRole } from '@/utils/authGuard';
// Beds24 price plumbing is shared with /api/stay-request/quote — one place for
// the offers-vs-calendar distinction and the undocumented response shapes.
import {
  extractPrice,
  fetchOffers,
  offersForRoom,
  nominalWebPrice,
  comparePrice,
} from '@/utils/beds24Pricing';

// Sellable Beds24 room IDs (what the offers endpoint returns prices for)
const SELL_ROOM_2KK   = 656437; // K.201 — 2KK Deluxe (physical = sellable, same ID)
const SELL_ROOM_1KK   = 648816; // Virtual 1KK Deluxe (qty=2, maps to K.202 + K.203)
const SELL_ROOM_2BR   = 674672; // O.308 — 2 Bedroom Apartment (physical = sellable, same ID)
const SELL_ROOM_URBAN = 679714; // Virtual 1KK Urban Studios (qty=3, maps to K.102 + K.103 + K.106)

export type PriceCheckOffer = {
  /** Beds24 sellable room ID — used by the manual booking form to match
   *  fetched prices to the corresponding unit row. */
  roomId: number;
  room: string;      // "K.201" | "K.202 / K.203" | "1KK Urban Studios"
  description: string;
  price: number | null;
};

/** Count nights between two YYYY-MM-DD strings (departure exclusive). */
function nightsBetween(arrival: string, departure: string): number {
  const a = new Date(arrival + 'T00:00:00Z').getTime();
  const b = new Date(departure + 'T00:00:00Z').getTime();
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

/**
 * Fetch prices ignoring availability via /inventory/rooms/calendar.
 * Issues one request per sellable roomId so the response shape is unambiguous.
 */
async function fetchCalendarPrices(
  token: string,
  arrival: string,
  departure: string,
): Promise<{
  priceMap: Record<number, number | null>;
  rawByRoom: Record<number, unknown>;
  bookingPageMultiplier: number | null;
  basePriceMap: Record<number, number | null>;
}> {
  const [r2kk, r1kk, r2br, rUrban] = await Promise.all([
    nominalWebPrice(token, SELL_ROOM_2KK,   arrival, departure),
    nominalWebPrice(token, SELL_ROOM_1KK,   arrival, departure),
    nominalWebPrice(token, SELL_ROOM_2BR,   arrival, departure),
    nominalWebPrice(token, SELL_ROOM_URBAN, arrival, departure),
  ]);
  return {
    priceMap: {
      [SELL_ROOM_2KK]:   r2kk.price,
      [SELL_ROOM_1KK]:   r1kk.price,
      [SELL_ROOM_2BR]:   r2br.price,
      [SELL_ROOM_URBAN]: rUrban.price,
    },
    basePriceMap: {
      [SELL_ROOM_2KK]:   r2kk.basePrice,
      [SELL_ROOM_1KK]:   r1kk.basePrice,
      [SELL_ROOM_2BR]:   r2br.basePrice,
      [SELL_ROOM_URBAN]: rUrban.basePrice,
    },
    // Same property for every room, so any of them carries the same value.
    bookingPageMultiplier: rUrban.bookingPageMultiplier,
    rawByRoom: {
      [SELL_ROOM_2KK]:   r2kk.raw,
      [SELL_ROOM_1KK]:   r1kk.raw,
      [SELL_ROOM_2BR]:   r2br.raw,
      [SELL_ROOM_URBAN]: rUrban.raw,
    },
  };
}

/**
 * GET /api/price-check?arrival=YYYY-MM-DD&departure=YYYY-MM-DD&adults=2&children=0&ignoreAvailability=false
 * Returns per-room prices from Beds24.
 *
 * - ignoreAvailability=false (default): uses /inventory/rooms/offers — only available rooms have a price
 * - ignoreAvailability=true: uses /inventory/rooms/calendar — sums daily price1 × the
 *   per-date multiplier, then applies the property's bookingPageMultiplier, so the
 *   number is on the same footing as a web price. It still does NOT evaluate rate
 *   plans, so length-of-stay discounts are missing and long spans read high.
 * - compare=1: prices one span BOTH ways and returns the ratio, to measure that
 *   remaining gap on spans Beds24 will actually quote. Read-only diagnostics.
 *
 * Room mapping:
 *   K.201            = Beds24 roomId 656437 (2KK Deluxe, 1 unit)
 *   K.202 / K.203    = Beds24 roomId 648816 (1KK Deluxe, virtual room qty=2)
 *   O.308            = Beds24 roomId 674672 (2 Bedroom, 1 unit)
 *   1KK Urban Studios = Beds24 roomId 679714 (virtual room qty=3, maps to K.102 + K.103 + K.106)
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
  const compare = req.nextUrl.searchParams.get('compare') === '1';

  if (!arrival || !departure) {
    return NextResponse.json({ error: 'arrival and departure are required' }, { status: 400 });
  }
  if (nightsBetween(arrival, departure) <= 0) {
    return NextResponse.json({ error: 'departure must be after arrival' }, { status: 400 });
  }

  try {
    // Diagnostics: real offer vs our estimate, per sellable room, for this span.
    if (compare) {
      const comparisons = [];
      for (const rid of [SELL_ROOM_URBAN, SELL_ROOM_2KK, SELL_ROOM_1KK, SELL_ROOM_2BR]) {
        comparisons.push(await comparePrice(rid, arrival, departure, Number(adults), Number(children)));
      }
      return NextResponse.json({ arrival, departure, comparisons });
    }

    const token = await getAccessToken();

    let priceMap: Record<number, number | null>;
    let rawByRoom: Record<number, unknown> | null = null;
    let bookingPageMultiplier: number | null = null;
    let basePriceMap: Record<number, number | null> | null = null;

    if (ignoreAvailability) {
      const result = await fetchCalendarPrices(token, arrival, departure);
      priceMap = result.priceMap;
      rawByRoom = result.rawByRoom;
      bookingPageMultiplier = result.bookingPageMultiplier;
      basePriceMap = result.basePriceMap;
    } else {
      const wantedIds = [SELL_ROOM_2KK, SELL_ROOM_1KK, SELL_ROOM_2BR, SELL_ROOM_URBAN];
      const data = await fetchOffers(token, arrival, departure, Number(adults), Number(children));

      priceMap = {};
      for (const rid of wantedIds) {
        priceMap[rid] = extractPrice(offersForRoom(data, rid));
      }

      // Capture raw response for debug=1 so we can see what Beds24 returned
      // when a room appears as "Unavailable" despite the calendar showing
      // availability — usually means no rate plan is publishing prices.
      if (debug) {
        rawByRoom = { _rawOffers: data } as Record<number, unknown>;
      }
    }

    // Order matches the calendar/filter layout: Urban first, then Deluxe units
    const offers: PriceCheckOffer[] = [
      {
        roomId: SELL_ROOM_URBAN,
        room: '1KK Urban Studios',
        description: '1KK Urban (K.102 / K.103 / K.106)',
        price: priceMap[SELL_ROOM_URBAN] ?? null,
      },
      {
        roomId: SELL_ROOM_2KK,
        room: 'K.201',
        description: '2KK Deluxe Apartment',
        price: priceMap[SELL_ROOM_2KK] ?? null,
      },
      {
        roomId: SELL_ROOM_1KK,
        room: 'K.202 / K.203',
        description: '1KK Deluxe Apartment',
        price: priceMap[SELL_ROOM_1KK] ?? null,
      },
      {
        roomId: SELL_ROOM_2BR,
        room: 'O.308',
        description: '2 Bedroom Apartment',
        price: priceMap[SELL_ROOM_2BR] ?? null,
      },
    ];

    if (debug) {
      return NextResponse.json({
        offers, ignoreAvailability, bookingPageMultiplier,
        debug: { rawByRoom, priceMap, basePriceMap },
      });
    }
    return NextResponse.json({ offers, ignoreAvailability, bookingPageMultiplier });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    // An upstream Beds24 failure stays a 502 (as before the shared helpers
    // started throwing it); anything else is ours and stays a 500.
    const status = /^Beds24 (offers|calendar|properties)/.test(message) ? 502 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
