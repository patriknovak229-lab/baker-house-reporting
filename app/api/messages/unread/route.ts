import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const ACTIVE_WINDOW_MS = 120 * 60 * 1000; // 120 minutes
const AUTO_REPLY_LOG_KEY = 'baker:auto-reply:log';
/** Auto-replies considered "recent enough to mention" alongside an unread
 *  message. 24 hours captures the same multi-turn conversation cleanly
 *  without dragging in old activity. */
const AUTO_REPLY_LOOKBACK_MS = 24 * 60 * 60 * 1000;

interface Beds24Message {
  id: number;
  bookingId: number;
  source?: string;
  message?: string;
  time: string; // ISO datetime from Beds24
}

interface AutoReplyLogEntry {
  bookingId: number;
  category: string;
  action: string;
  sentText: string | null;
  decidedAt: string;
}

/**
 * One row in the response — the operator's "what just landed" snapshot.
 * The TransactionsPage joins these against the cached reservations list
 * by bookingId to surface guest name + room.
 */
export interface UnreadBookingSummary {
  bookingId: number;
  /** Text of the most-recent unread guest message (truncated to ~200 chars). */
  latestMessage: string;
  /** ISO timestamp of that message. */
  latestMessageTime: string;
  /** Total unread guest messages in this conversation. */
  unreadCount: number;
  /** Auto-replies sent on this booking in the last 24h (newest first). */
  autoReplies: Array<{
    category: string;
    sentAt: string;
  }>;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * GET /api/messages/unread
 *
 * Returns:
 *   bookingIds[]  — legacy: numeric IDs that have unread guest messages
 *                   in the past 120 min. Drives the blinking table badge.
 *   bookings[]    — enriched: per-booking metadata (latest message text,
 *                   timestamp, unread count, recent auto-reply summary)
 *                   used by the "Unread messages" pill panel.
 *
 * Polled every 30s from the client. Side-effect: when recent unread
 * messages exist, fires a SYNC_ROOM at our own webhook URL so the
 * auto-reply pipeline runs (Beds24's Inventory Webhook doesn't fire on
 * incoming messages — see /api/webhook/beds24-message for context).
 */
export async function GET() {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

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

  // Group unread messages by bookingId, pick the most recent one as "the
  // latest", count the rest. Skip messages without text content (which
  // shouldn't happen but defensive).
  const byBooking = new Map<number, { msgs: Beds24Message[] }>();
  for (const m of recentUnread) {
    if (!byBooking.has(m.bookingId)) byBooking.set(m.bookingId, { msgs: [] });
    byBooking.get(m.bookingId)!.msgs.push(m);
  }

  // Load auto-reply log once; filter per booking inside the loop.
  let autoReplyLog: AutoReplyLogEntry[] = [];
  const redis = getRedis();
  if (redis) {
    try {
      autoReplyLog = (await redis.get<AutoReplyLogEntry[]>(AUTO_REPLY_LOG_KEY)) ?? [];
    } catch (err) {
      console.warn('[messages/unread] auto-reply log read failed:', err);
    }
  }

  const bookings: UnreadBookingSummary[] = [];
  for (const [bookingId, group] of byBooking) {
    const sortedMsgs = [...group.msgs].sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
    );
    const latest = sortedMsgs[0];
    const latestText = (latest.message ?? '').trim();

    // Auto-replies for this booking in the past 24h, newest first
    const lookbackCutoff = now - AUTO_REPLY_LOOKBACK_MS;
    const autoReplies = autoReplyLog
      .filter((e) => e.bookingId === bookingId)
      .filter((e) => e.action === 'sent' || e.action === 'sent-with-task')
      .filter((e) => {
        const t = new Date(e.decidedAt).getTime();
        return Number.isFinite(t) && t >= lookbackCutoff;
      })
      .sort((a, b) => new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime())
      .map((e) => ({ category: e.category, sentAt: e.decidedAt }));

    bookings.push({
      bookingId,
      latestMessage: latestText.length > 200 ? latestText.slice(0, 197) + '…' : latestText,
      latestMessageTime: latest.time,
      unreadCount: group.msgs.length,
      autoReplies,
    });
  }

  // Newest activity first so the pill panel surfaces "most recent" at the top
  bookings.sort(
    (a, b) => new Date(b.latestMessageTime).getTime() - new Date(a.latestMessageTime).getTime(),
  );

  // Lazy auto-reply nudge — only when we actually saw recent unread guest
  // messages. See route docstring for context.
  if (recentUnread.length > 0) {
    triggerAutoReplyPoll().catch((err) =>
      console.warn('[messages/unread] auto-reply nudge failed:', err),
    );
  }

  return NextResponse.json({ bookingIds, bookings });
}

async function triggerAutoReplyPoll(): Promise<void> {
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL?.trim() ||
    'https://reporting.bakerhouseapartments.cz';
  await fetch(`${baseUrl}/api/webhook/beds24-message`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roomId: '0',
      propId: '311322',
      ownerId: '0',
      action: 'SYNC_ROOM',
    }),
    cache: 'no-store',
  });
}
