/**
 * Fetch the recent message thread for a single booking from Beds24, so the
 * AI reply composer has conversation context (understands follow-ups, doesn't
 * repeat itself). Read-only; returns [] on any failure so the caller can
 * still compose a (context-light) reply rather than break.
 */

import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

export interface ConversationMessage {
  role: 'guest' | 'host';
  text: string;
  time: string;
}

export async function fetchRecentConversation(
  bookingId: number,
  max = 12,
): Promise<ConversationMessage[]> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[beds24Conversation] token fetch failed:', err instanceof Error ? err.message : err);
    return [];
  }

  const params = new URLSearchParams();
  params.append('bookingId', String(bookingId));

  let res: Response;
  try {
    res = await fetch(`${BEDS24_API_BASE}/bookings/messages?${params}`, {
      headers: { token },
      cache: 'no-store',
    });
  } catch (err) {
    console.error('[beds24Conversation] fetch failed:', err instanceof Error ? err.message : err);
    return [];
  }
  if (!res.ok) return [];

  const json = await res.json().catch(() => null);
  const raw: Array<{ source?: string; message?: string; time?: string }> = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown[] })?.data)
      ? (json as { data: Array<{ source?: string; message?: string; time?: string }> }).data
      : [];

  return raw
    .filter(
      (m) =>
        (m.source === 'guest' || m.source === 'host') &&
        typeof m.message === 'string' &&
        m.message.trim().length > 0,
    )
    .sort((a, b) => new Date(a.time ?? 0).getTime() - new Date(b.time ?? 0).getTime())
    .slice(-max)
    .map((m) => ({
      role: m.source === 'host' ? ('host' as const) : ('guest' as const),
      text: (m.message ?? '').trim(),
      time: m.time ?? '',
    }));
}
