/**
 * POST /api/bookings/blackout
 *
 * Creates a Beds24 blackout — a "block" booking that closes a room for a date
 * range without representing a paying guest. Equivalent to the "Blackout"
 * option in the Beds24 calendar UI.
 *
 * Beds24 V2 represents blackouts as bookings with status="black" — same shape
 * as a normal booking but with no guest, no price, no payment. They show as
 * unavailable in the channel-manager and prevent OTAs from selling the room.
 *
 * Body: { roomId: number, arrival: 'YYYY-MM-DD', departure: 'YYYY-MM-DD', notes?: string }
 *
 * Auth: admin / super only.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

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
  const { roomId, arrival, departure, notes } = body as {
    roomId?: number | string;
    arrival?: string;
    departure?: string;
    notes?: string;
  };

  if (!roomId || !arrival || !departure) {
    return NextResponse.json(
      { error: 'roomId, arrival and departure are required' },
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

  const blackout = {
    roomId: Number(roomId),
    status: 'black',
    arrival,
    departure,
    // Beds24 wants firstName populated for any booking shape — use a clear label
    firstName: 'BLOCKED',
    lastName: '',
    referer: 'BlackoutDirect',
    apiSource: 'Direct',
    comments: notes ?? '',
    price: 0,
  };

  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify([blackout]),
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
  return NextResponse.json({ ok: true, data: json });
}
