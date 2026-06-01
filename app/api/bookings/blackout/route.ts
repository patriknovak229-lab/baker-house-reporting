/**
 * POST /api/bookings/blackout
 *
 * Creates a Beds24 inventory-calendar BLACKOUT OVERRIDE — the same mechanism
 * Beds24's own UI uses when you pick "Override → Blackout" on the calendar.
 *
 * This is INTENTIONALLY different from the older `POST /bookings` with
 * `status: "black"` flow that this endpoint used to do. That flow created
 * a fake "BLOCKED" booking record. The new flow uses the dedicated
 * inventory-override API which:
 *   - layers a "blackout" tag on the room/date pair (no fake booking)
 *   - blocks new sales on those dates without affecting existing bookings
 *   - matches what operators see when they create blackouts directly in Beds24
 *
 * Body: {
 *   roomIds: number[],         // physical room IDs (e.g. [679703, 679704])
 *   arrival:   'YYYY-MM-DD',   // first blacked-out night
 *   departure: 'YYYY-MM-DD',   // morning after last blacked-out night
 *   notes?: string             // currently ignored — calendar overrides don't carry comments
 * }
 *
 * Multi-room is supported in a single Beds24 request — the array body
 * lets us blackout any combination of rooms in one shot.
 *
 * Auth: admin / super only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
/** Same key as /api/bookings — must invalidate so manual blackout
 *  changes show up on the next dashboard refresh instead of waiting
 *  for the 5-min TTL to expire. */
const OVERRIDE_BLACKOUTS_CACHE_KEY = 'baker:override-blackouts-cache';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function invalidateOverrideBlackoutsCache(): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.del(OVERRIDE_BLACKOUTS_CACHE_KEY);
  } catch (err) {
    console.warn('[blackout] cache invalidation failed:', err);
  }
}

/** Subtract one day from YYYY-MM-DD. Departure (checkout-morning) → inclusive last night. */
function previousDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Auth error' },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => ({}));
  const { roomIds, arrival, departure } = body as {
    roomIds?: unknown;
    arrival?: string;
    departure?: string;
  };

  if (!Array.isArray(roomIds) || roomIds.length === 0) {
    return NextResponse.json(
      { error: 'roomIds (non-empty array) is required' },
      { status: 400 },
    );
  }
  const normalisedRoomIds = roomIds.map((r) => Number(r)).filter((n) => Number.isFinite(n));
  if (normalisedRoomIds.length === 0) {
    return NextResponse.json({ error: 'roomIds must contain at least one numeric id' }, { status: 400 });
  }

  if (!arrival || !departure) {
    return NextResponse.json(
      { error: 'arrival and departure are required' },
      { status: 400 },
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrival) || !/^\d{4}-\d{2}-\d{2}$/.test(departure)) {
    return NextResponse.json(
      { error: 'arrival and departure must be YYYY-MM-DD' },
      { status: 400 },
    );
  }
  if (departure <= arrival) {
    return NextResponse.json(
      { error: 'departure must be after arrival' },
      { status: 400 },
    );
  }

  // Beds24's calendar endpoint uses INCLUSIVE date ranges (from..to span
  // every night through to). Our UI passes departure = morning-after-last-
  // night (booking convention), so the last blacked-out night is
  // `departure - 1`.
  const to = previousDay(departure);

  // Single multi-room payload — Beds24 accepts an array of { roomId, calendar: [...] }
  const payload = normalisedRoomIds.map((roomId) => ({
    roomId,
    calendar: [
      {
        from: arrival,
        to,
        override: 'blackout',
      },
    ],
  }));

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Beds24 ${res.status}: ${text}` },
      { status: res.status },
    );
  }

  const json = await res.json();
  await invalidateOverrideBlackoutsCache();
  return NextResponse.json({ ok: true, data: json });
}

/**
 * DELETE /api/bookings/blackout?id=OV-<roomId>-<from>-<to>
 *
 * Clears a blackout override by writing `override: "none"` for the same
 * room+range. The `id` shape encodes everything needed — generated by
 * `/api/bookings` GET when it synthesises override-blackout Reservations.
 *
 * Legacy `id=BH-<bookingId>` (old status="black" bookings) is intentionally
 * NOT supported here — that mechanism has been retired. The two pre-existing
 * BH-blackouts in production data can be cancelled via the Beds24 UI if needed.
 */
export async function DELETE(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Auth error' },
      { status: 500 },
    );
  }

  const id = req.nextUrl.searchParams.get('id') ?? '';
  // Expected shape: OV-<roomId>-<YYYY-MM-DD>-<YYYY-MM-DD>
  const m = id.match(/^OV-(\d+)-(\d{4}-\d{2}-\d{2})-(\d{4}-\d{2}-\d{2})$/);
  if (!m) {
    return NextResponse.json(
      {
        error:
          'id must be in the form OV-<roomId>-<from>-<to> (legacy BH- blackouts are not supported here)',
      },
      { status: 400 },
    );
  }
  const roomId = Number(m[1]);
  const from = m[2];
  const to = m[3];

  const payload = [
    {
      roomId,
      calendar: [
        {
          from,
          to,
          // 'none' resets the override flag back to whatever the underlying
          // availability/price says — same effect as removing the blackout
          // tag in the Beds24 UI.
          override: 'none',
        },
      ],
    },
  ];

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Beds24 ${res.status}: ${text}` },
      { status: res.status },
    );
  }

  await invalidateOverrideBlackoutsCache();
  return NextResponse.json({ ok: true });
}
