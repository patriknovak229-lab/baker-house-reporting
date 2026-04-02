import { NextRequest, NextResponse } from 'next/server';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

// ── Beds24 message shape (verify `time` field name against ?raw=true if needed) ──
interface Beds24Message {
  id: number;
  bookingId: number;
  source: 'host' | 'guest' | 'internalNote' | 'system';
  message: string;
  time: string; // ISO datetime — field name inferred; check raw response if incorrect
}

export interface ThreadMessage {
  id: number;
  source: 'host' | 'guest' | 'system';
  text: string;
  time: string;
}

// ── GET /api/messages?bookingId=123 — fetch thread for one booking ─────────────
export async function GET(req: NextRequest) {
  const bookingId = req.nextUrl.searchParams.get('bookingId');
  if (!bookingId) {
    return NextResponse.json({ error: 'bookingId required' }, { status: 400 });
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

  const params = new URLSearchParams();
  params.append('bookingId', bookingId);

  const res = await fetch(`${BEDS24_API_BASE}/bookings/messages?${params}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: res.status });
  }

  const json = await res.json();
  const raw: Beds24Message[] = Array.isArray(json) ? json : (json.data ?? []);

  // Drop internal notes; return last 10 messages oldest-first
  const messages: ThreadMessage[] = raw
    .filter((m) => m.source !== 'internalNote')
    .slice(-10)
    .map((m) => ({
      id: m.id,
      source: m.source === 'host' ? 'host' : m.source === 'guest' ? 'guest' : 'system',
      text: m.message,
      time: m.time,
    }));

  return NextResponse.json(messages);
}

// ── POST /api/messages — send a message to a guest ────────────────────────────
export async function POST(req: NextRequest) {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

  const { bookingId, message } = await req.json();
  if (!bookingId || !message?.trim()) {
    return NextResponse.json({ error: 'bookingId and message required' }, { status: 400 });
  }

  const res = await fetch(`${BEDS24_API_BASE}/bookings/messages`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ bookingId, message: message.trim() }]),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: res.status });
  }

  return NextResponse.json({ ok: true });
}
