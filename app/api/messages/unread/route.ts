import { NextResponse } from 'next/server';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

// Returns the set of Beds24 booking IDs that have at least one unread guest message.
// Polled every 30s from the client to drive the blinking badge in the table.
export async function GET() {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

  // maxAge=1 → only messages from the past 24 hours; source=guest → only guest messages
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
  const messages: { bookingId: number }[] = Array.isArray(json) ? json : (json.data ?? []);

  const bookingIds = [...new Set(messages.map((m) => m.bookingId))];
  return NextResponse.json({ bookingIds });
}
