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
  /** Beds24 message id — lets callers tell our automatic sends apart from
   *  the operator's own replies (utils/operatorActivity). */
  id?: number;
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
  type RawMessage = { id?: number | string; source?: string; message?: string; time?: string };
  const raw: RawMessage[] = Array.isArray(json)
    ? json
    : Array.isArray((json as { data?: unknown[] })?.data)
      ? (json as { data: RawMessage[] }).data
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
      ...(Number.isFinite(Number(m.id)) && m.id != null ? { id: Number(m.id) } : {}),
    }));
}

/**
 * Every guest/host message across the property from the last `maxAgeDays`
 * days, grouped by booking id and sorted oldest first. One paged call instead
 * of one per booking — used by the contact-details pass (utils/guestContactService).
 * Returns an empty map on any failure.
 */
export async function fetchRecentMessagesByBooking(
  maxAgeDays: number,
  maxPages = 5,
): Promise<Map<number, ConversationMessage[]>> {
  const out = new Map<number, ConversationMessage[]>();
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[beds24Conversation] token fetch failed:', err instanceof Error ? err.message : err);
    return out;
  }

  let url: string | null = `${BEDS24_API_BASE}/bookings/messages?${new URLSearchParams({ maxAge: String(maxAgeDays) })}`;
  for (let page = 0; url && page < maxPages; page++) {
    let json: unknown;
    try {
      const res: Response = await fetch(url, { headers: { token }, cache: 'no-store' });
      if (!res.ok) break;
      json = await res.json();
    } catch (err) {
      console.error('[beds24Conversation] bulk fetch failed:', err instanceof Error ? err.message : err);
      break;
    }
    type RawMessage = { id?: number | string; bookingId?: number | string; source?: string; message?: string; time?: string };
    const body = json as { data?: RawMessage[]; pages?: { nextPageExists?: boolean; nextPageLink?: string | null } };
    const raw: RawMessage[] = Array.isArray(json) ? (json as RawMessage[]) : Array.isArray(body?.data) ? body.data : [];
    for (const m of raw) {
      const bookingId = Number(m.bookingId);
      if (!Number.isFinite(bookingId)) continue;
      if (m.source !== 'guest' && m.source !== 'host') continue;
      if (typeof m.message !== 'string' || !m.message.trim()) continue;
      const list = out.get(bookingId) ?? [];
      list.push({
        role: m.source,
        text: m.message.trim(),
        time: m.time ?? '',
        ...(Number.isFinite(Number(m.id)) && m.id != null ? { id: Number(m.id) } : {}),
      });
      out.set(bookingId, list);
    }
    url = body?.pages?.nextPageExists && body.pages.nextPageLink ? body.pages.nextPageLink : null;
  }
  for (const list of out.values()) {
    list.sort((a, b) => new Date(a.time || 0).getTime() - new Date(b.time || 0).getTime());
  }
  return out;
}
