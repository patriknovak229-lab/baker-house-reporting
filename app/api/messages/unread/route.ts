import { NextResponse } from 'next/server';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const ACTIVE_WINDOW_MS = 120 * 60 * 1000; // 120 minutes

interface Beds24Message {
  bookingId: number;
  time: string; // ISO datetime from Beds24
}

// Returns the set of Beds24 booking IDs that have at least one unread guest message
// received within the last 120 minutes.
// Polled every 30s from the client to drive the blinking badge in the table.
export async function GET() {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

  // maxAge=1 → messages from the past 24 hours; source=guest → only guest messages
  // We then narrow to 120 min client-side using the message timestamp.
  const params = new URLSearchParams({ filter: 'unread', maxAge: '1', source: 'guest' });

  const res = await fetch(`${BEDS24_API_BASE}/bookings/messages?${params}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: res.status });
  }

  const json = await res.json();
  const messages: Beds24Message[] = Array.isArray(json) ? json : (json.data ?? []);

  const now = Date.now();

  // Only surface bookings where the unread message arrived within 120 minutes
  const recentUnread = messages.filter((m) => {
    if (!m.time) return false;
    return now - new Date(m.time).getTime() <= ACTIVE_WINDOW_MS;
  });

  const bookingIds = [...new Set(recentUnread.map((m) => m.bookingId))];
  return NextResponse.json({ bookingIds });
}
