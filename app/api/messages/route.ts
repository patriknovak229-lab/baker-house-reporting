import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getAccessToken } from '@/utils/beds24Auth';
import { requireRole } from '@/utils/authGuard';
import { isInvoiceRequest, parseInvoiceRequest } from '@/utils/invoiceRequestParser';
import { sendBeds24Message } from '@/utils/beds24Messages';
import type { InvoiceRequest } from '@/types/invoiceRequest';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const INVOICE_REQUESTS_KEY = 'baker:invoice-requests';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Lazy auto-reply nudge — fire-and-forget POST to our own webhook URL.
 * The webhook handles the SYNC_ROOM payload like any other Beds24 fire,
 * including its 15s debounce, so this is cheap to call repeatedly. The
 * roomId/propId values are placeholders (the webhook doesn't use them
 * directly — it just polls Beds24 for unread messages property-wide).
 */
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

/**
 * Side-effect on GET /api/messages: scan guest messages for Booking.com
 * "I need an invoice" auto-templates and persist new ones as pending
 * InvoiceRequest rows in Redis. Dedup is by beds24MessageId so re-fetches
 * never store duplicates. Anything missing fields is still stored — the
 * operator fills the gaps when accepting.
 */
async function detectAndStoreInvoiceRequests(
  bookingId: number,
  raw: Beds24Message[],
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const guestMessages = raw.filter((m) => m.source === 'guest' && isInvoiceRequest(m.message));
  if (guestMessages.length === 0) return;

  const existing = (await redis.get<InvoiceRequest[]>(INVOICE_REQUESTS_KEY)) ?? [];
  const knownIds = new Set(existing.map((r) => r.beds24MessageId));
  const newOnes: InvoiceRequest[] = [];
  for (const m of guestMessages) {
    if (knownIds.has(m.id)) continue;
    const parsed = parseInvoiceRequest(m.message);
    newOnes.push({
      id: `ir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      reservationNumber: `BH-${bookingId}`,
      beds24MessageId: m.id,
      rawMessage: m.message,
      companyName: parsed.companyName,
      ico: parsed.ico,
      dic: parsed.dic,
      email: parsed.email,
      detectedAt: new Date().toISOString(),
      status: 'pending',
    });
  }
  if (newOnes.length === 0) return;
  await redis.set(INVOICE_REQUESTS_KEY, [...existing, ...newOnes]);
}

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
  /** True when this host message was sent by the auto-reply pipeline.
   *  Surfaced in MessageThread as a small ⚡ Auto chip so operators can tell
   *  which replies came from the bot. */
  isAutoReply?: boolean;
}

/** Auto-reply log entry shape (mirrors webhook/beds24-message/route.ts). */
interface AutoReplyLogEntry {
  beds24SentMessageId: number | null;
  bookingId: number;
}

// ── GET /api/messages?bookingId=123 — fetch thread for one booking ─────────────
//
// Supports `&raw=true` debug mode that returns the unmodified Beds24
// response BEFORE any filtering/sorting/source-mapping happens. Useful
// when a message is missing from the thread and we need to confirm
// whether Beds24 returned it at all.
export async function GET(req: NextRequest) {
  const bookingId = req.nextUrl.searchParams.get('bookingId');
  const debugRaw = req.nextUrl.searchParams.get('raw') === 'true';
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

  // Debug short-circuit: return everything Beds24 sent us, completely
  // unfiltered. Operator-only diagnostic path.
  if (debugRaw) {
    return NextResponse.json({
      bookingId,
      fetchedAt: new Date().toISOString(),
      beds24Response: json,
    });
  }

  const raw: Beds24Message[] = Array.isArray(json) ? json : (json.data ?? []);

  // Side effect: detect invoice-request templates from Booking.com.
  // Fire-and-forget — don't block the messages response on Redis writes.
  detectAndStoreInvoiceRequests(Number(bookingId), raw).catch((err) =>
    console.error('[messages] invoice-request detection failed', err),
  );

  // Side effect: nudge the auto-reply pipeline. Beds24's Inventory
  // Webhook doesn't fire on guest messages — only on booking/inventory
  // changes — so without this nudge the auto-reply pipeline never runs
  // when a guest sends a message into an existing conversation.
  // Every drawer fetch (initial + 30s polling) fires a SYNC_ROOM POST
  // at our own webhook URL, which respects its own 15s debounce so we
  // don't hammer Beds24 even if many drawers are open simultaneously.
  // Fire-and-forget — the drawer response doesn't wait on the poll.
  triggerAutoReplyPoll().catch((err) =>
    console.warn('[messages] auto-reply nudge failed:', err),
  );

  // Load auto-reply audit log so we can tag host messages that came from
  // the bot. Best-effort — if Redis is unreachable, messages render
  // without the ⚡ Auto chip rather than the whole thread failing.
  const autoReplyMessageIds = new Set<number>();
  const redis = getRedis();
  if (redis) {
    try {
      const log = (await redis.get<AutoReplyLogEntry[]>('baker:auto-reply:log')) ?? [];
      for (const entry of log) {
        if (entry.bookingId !== Number(bookingId)) continue;
        if (entry.beds24SentMessageId != null) {
          autoReplyMessageIds.add(entry.beds24SentMessageId);
        }
      }
    } catch (err) {
      console.warn('[messages] auto-reply log read failed:', err);
    }
  }

  // Sort by time ascending so order is deterministic regardless of how
  // Beds24 returns the page. Drop internal notes. Cap at the most recent
  // 30 messages — enough context without dragging months of history onto
  // every poll. Returned oldest-first so the client can render top→bottom.
  const MAX_THREAD_MESSAGES = 30;
  const messages: ThreadMessage[] = [...raw]
    .filter((m) => m.source !== 'internalNote')
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .slice(-MAX_THREAD_MESSAGES)
    .map((m) => ({
      id: m.id,
      source: m.source === 'host' ? 'host' : m.source === 'guest' ? 'guest' : 'system',
      text: m.message,
      time: m.time,
      isAutoReply: autoReplyMessageIds.has(m.id) || undefined,
    }));

  return NextResponse.json(messages);
}

// ── POST /api/messages — send a message to a guest ────────────────────────────
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { bookingId, message } = await req.json();
  if (!bookingId || !message?.trim()) {
    return NextResponse.json({ error: 'bookingId and message required' }, { status: 400 });
  }

  try {
    const result = await sendBeds24Message(bookingId, message);
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
