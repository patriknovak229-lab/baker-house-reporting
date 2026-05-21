/**
 * Beds24 V2 messaging — server-side helper.
 *
 * Used by app/api/messages/route.ts (POST handler for operator-composed
 * messages) and app/api/webhook/beds24-message/route.ts (auto-reply path).
 * Centralised so both paths emit identical Beds24 requests and stay in
 * sync if the API shape changes.
 */

import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

export interface SendMessageResult {
  /** Beds24's response payload, useful for capturing the new message id. */
  raw: unknown;
  /**
   * The id Beds24 assigned to the message we just sent — extracted from
   * the response so callers can tag it as an auto-reply in audit logs.
   * Null when the response shape doesn't carry an id (older API versions).
   */
  messageId: number | null;
}

/**
 * Send `message` to the guest of `bookingId` via Beds24.
 * Throws on non-2xx so the caller can surface or log the failure.
 *
 * `token` is optional — when omitted, the helper acquires its own via
 * getAccessToken(). Pass an existing token when sending many messages
 * back-to-back to avoid repeated refresh-token round trips.
 */
export async function sendBeds24Message(
  bookingId: number | string,
  message: string,
  token?: string,
): Promise<SendMessageResult> {
  const t = token ?? (await getAccessToken());

  const res = await fetch(`${BEDS24_API_BASE}/bookings/messages`, {
    method: 'POST',
    headers: { token: t, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ bookingId: Number(bookingId), message: message.trim() }]),
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 ${res.status}: ${text}`);
  }

  const raw = await res.json().catch(() => null);
  const messageId = extractMessageId(raw);
  return { raw, messageId };
}

/**
 * Best-effort extraction of the new message id from Beds24's response.
 * Beds24 returns shapes like `[{ id, modifiedTime }]` or
 * `{ data: [{ id }] }` depending on endpoint version — handle both.
 */
function extractMessageId(raw: unknown): number | null {
  if (!raw) return null;
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0] as { id?: number | string };
    const id = Number(first?.id);
    return Number.isFinite(id) ? id : null;
  }
  if (typeof raw === 'object') {
    const obj = raw as { data?: unknown; id?: number | string };
    if (Array.isArray(obj.data) && obj.data.length > 0) {
      const id = Number((obj.data[0] as { id?: number | string })?.id);
      return Number.isFinite(id) ? id : null;
    }
    const id = Number(obj.id);
    return Number.isFinite(id) ? id : null;
  }
  return null;
}
