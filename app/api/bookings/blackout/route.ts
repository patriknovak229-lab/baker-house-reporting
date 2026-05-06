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
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

/**
 * Encodes the operator email + reason into the Beds24 `comments` field with
 * a parseable header so we can render "blacked out by X" in the drawer.
 * Format:
 *   [BLACKOUT_BY:email@example.com]
 *   <free-text reason>
 */
function buildBlackoutComment(operatorEmail: string, reason: string): string {
  const header = `[BLACKOUT_BY:${operatorEmail}]`;
  return reason ? `${header}\n${reason}` : header;
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  // Resolve the current operator email — falls back to dev email locally
  let operatorEmail = '';
  if (process.env.NODE_ENV === 'development' && process.env.DEV_ADMIN_EMAIL) {
    operatorEmail = process.env.DEV_ADMIN_EMAIL;
  } else {
    const session = await auth();
    operatorEmail = session?.user?.email ?? 'unknown';
  }

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
    comments: buildBlackoutComment(operatorEmail, (notes ?? '').trim()),
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

/**
 * DELETE /api/bookings/blackout?id=12345
 *
 * Cancels a blackout in Beds24 (sets status to "cancelled"). Beds24 V2
 * doesn't hard-delete bookings — cancellation is the equivalent operation.
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

  const id = req.nextUrl.searchParams.get('id');
  const numericId = id ? Number(id.replace(/^BH-/, '')) : NaN;
  if (!Number.isFinite(numericId)) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 });
  }

  // Beds24 V2: PATCH /bookings with status="cancelled" (no hard-delete)
  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: 'PATCH',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ id: numericId, status: 'cancelled' }]),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json(
      { error: `Beds24 ${res.status}: ${text}` },
      { status: res.status },
    );
  }

  return NextResponse.json({ ok: true });
}
