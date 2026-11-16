import { NextRequest, NextResponse, after } from 'next/server';
import { Redis } from '@upstash/redis';
import { triggerAutoReplyPoll } from '@/utils/autoReplyNudge';
import { readAllAutoReplyLog } from '@/utils/autoReplyLogStore';
import { getAccessToken } from '@/utils/beds24Auth';
import { requireRole } from '@/utils/authGuard';
import { isInvoiceRequest, parseInvoiceRequest } from '@/utils/invoiceRequestParser';
import { sendBeds24Message } from '@/utils/beds24Messages';
import { markOperatorActive } from '@/utils/operatorActivity';
import type { InvoiceRequest } from '@/types/invoiceRequest';
import { readAllInvoiceRequests, writeAllInvoiceRequests } from '@/utils/invoiceRequestsStore';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * Side-effect on GET /api/messages: scan guest messages for Booking.com
 * "I need an invoice" auto-templates and persist new ones as pending
 * InvoiceRequest rows. Anything missing fields is still stored — the operator
 * fills the gaps when accepting.
 *
 * This is the LEGACY detector, and it now only covers bookings the multi-turn
 * chat flow never picked up. Dedup by beds24MessageId alone is not enough:
 * an invoice conversation runs across several messages, the flow creates ONE
 * request from the first and merges the rest into it, so every other message
 * still looks "new" here. Opening the drawer then minted a fresh `pending` row
 * per message — BH-95025203 collected two on 2026-10-23 for a booking that was
 * already auto-completed and queued, each offering an Accept that would clobber
 * invoiceData and append a duplicate Send-invoice task.
 *
 * So: if the booking already has a live (non-rejected) request, the flow owns
 * it and this detector stays out. `rejected` is excluded deliberately — the
 * operator dismissed that one, and a genuinely new request afterwards should
 * still surface.
 */
async function detectAndStoreInvoiceRequests(
  bookingId: number,
  raw: Beds24Message[],
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const guestMessages = raw.filter((m) => m.source === 'guest' && isInvoiceRequest(m.message));
  if (guestMessages.length === 0) return;

  const existing = await readAllInvoiceRequests();
  const reservationNumber = `BH-${bookingId}`;
  const alreadyHandled = existing.some(
    (r) => r.reservationNumber === reservationNumber && r.status !== 'rejected',
  );
  if (alreadyHandled) return;

  const knownIds = new Set(existing.map((r) => r.beds24MessageId));
  const newOnes: InvoiceRequest[] = [];
  for (const m of guestMessages) {
    if (knownIds.has(m.id)) continue;
    const parsed = parseInvoiceRequest(m.message);
    newOnes.push({
      id: `ir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      reservationNumber,
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
  await writeAllInvoiceRequests([...existing, ...newOnes]);
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
  /** The Beds24 booking this message belongs to. For a multi-apartment
   *  (group) reservation each apartment is its own Beds24 booking with its
   *  own thread — Beds24 auto actions (arrival guide) post to each one. */
  bookingId: number;
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

// ── GET /api/messages?bookingId=123[&bookingId=456…][&limit=200] ─────────────
//
// Several `bookingId`s = one merged thread for a multi-apartment reservation.
// The FIRST id is the primary (master) booking: invoice detection is filed
// under it and the drawer sends replies to it. Sub-bookings of a Beds24 group
// carry their own message threads, so reading only the master missed e.g.
// the arrival guide Beds24 posted to K.106 of BH-95377263.
//
// `limit` caps how many of the most recent messages come back (default 30 for
// the drawer; the "full chat" window asks for more history, max 500).
//
// Supports `&raw=true` debug mode that returns the unmodified Beds24
// response(s) BEFORE any filtering/sorting/source-mapping happens.
const DEFAULT_THREAD_LIMIT = 30;
const MAX_THREAD_LIMIT = 500;
const MAX_GROUP_BOOKINGS = 10;

async function fetchBookingMessages(token: string, bookingId: number): Promise<unknown> {
  const params = new URLSearchParams({ bookingId: String(bookingId) });
  const res = await fetch(`${BEDS24_API_BASE}/bookings/messages?${params}`, {
    headers: { token },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw Object.assign(new Error(`Beds24 ${res.status}: ${text}`), { status: res.status });
  }
  return res.json();
}

export async function GET(req: NextRequest) {
  const bookingIds = [
    ...new Set(
      req.nextUrl.searchParams
        .getAll('bookingId')
        .flatMap((v) => v.split(','))
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].slice(0, MAX_GROUP_BOOKINGS);
  const debugRaw = req.nextUrl.searchParams.get('raw') === 'true';
  const limitParam = Number(req.nextUrl.searchParams.get('limit'));
  const limit = Number.isInteger(limitParam) && limitParam > 0
    ? Math.min(limitParam, MAX_THREAD_LIMIT)
    : DEFAULT_THREAD_LIMIT;
  if (bookingIds.length === 0) {
    return NextResponse.json({ error: 'bookingId required' }, { status: 400 });
  }
  const primaryId = bookingIds[0];

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Auth error' }, { status: 500 });
  }

  // The primary thread must load; a sub-booking that fails (e.g. deleted in
  // Beds24) only loses its own messages instead of blanking the chat.
  const settled = await Promise.allSettled(bookingIds.map((id) => fetchBookingMessages(token, id)));
  const primary = settled[0];
  if (primary.status === 'rejected') {
    const err = primary.reason as Error & { status?: number };
    return NextResponse.json({ error: err.message }, { status: err.status ?? 502 });
  }
  settled.slice(1).forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[messages] sub-booking ${bookingIds[i + 1]} fetch failed:`, r.reason);
    }
  });

  // Debug short-circuit: return everything Beds24 sent us, completely
  // unfiltered. Operator-only diagnostic path.
  if (debugRaw) {
    return NextResponse.json({
      bookingIds,
      fetchedAt: new Date().toISOString(),
      beds24Response: bookingIds.length === 1
        ? primary.value
        : Object.fromEntries(bookingIds.map((id, i) => {
            const r = settled[i];
            return [id, r.status === 'fulfilled' ? r.value : { error: String(r.reason) }];
          })),
    });
  }

  const asList = (json: unknown): Beds24Message[] =>
    Array.isArray(json) ? json : ((json as { data?: Beds24Message[] })?.data ?? []);
  // Dedup by message id — in case Beds24 ever echoes a group's messages
  // under more than one of its bookings.
  const byId = new Map<number, Beds24Message>();
  settled.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const m of asList(r.value)) {
      if (!byId.has(m.id)) byId.set(m.id, { ...m, bookingId: m.bookingId ?? bookingIds[i] });
    }
  });
  const raw = [...byId.values()];

  // Side effect: detect invoice-request templates from Booking.com.
  // Filed under the primary booking — that's the reservation the operator
  // sees. Fire-and-forget — don't block the messages response on Redis writes.
  detectAndStoreInvoiceRequests(primaryId, raw).catch((err) =>
    console.error('[messages] invoice-request detection failed', err),
  );

  // Side effect: nudge the auto-reply pipeline. Beds24's Inventory
  // Webhook doesn't fire on guest messages — only on booking/inventory
  // changes — so without this nudge the auto-reply pipeline never runs
  // when a guest sends a message into an existing conversation.
  // Every drawer fetch (initial + 30s polling) fires a SYNC_ROOM POST
  // at our own webhook URL, which respects its own 15s debounce so we
  // don't hammer Beds24 even if many drawers are open simultaneously.
  // Runs after the response — the drawer doesn't wait on the poll.
  after(() =>
    triggerAutoReplyPoll().catch((err) =>
      console.warn('[messages] auto-reply nudge failed:', err),
    ),
  );

  // Load auto-reply audit log so we can tag host messages that came from
  // the bot. Best-effort — if Redis is unreachable, messages render
  // without the ⚡ Auto chip rather than the whole thread failing.
  const idSet = new Set(bookingIds);
  const autoReplyMessageIds = new Set<number>();
  try {
    const log = await readAllAutoReplyLog<AutoReplyLogEntry>();
    for (const entry of log) {
      if (!idSet.has(entry.bookingId)) continue;
      if (entry.beds24SentMessageId != null) {
        autoReplyMessageIds.add(entry.beds24SentMessageId);
      }
    }
  } catch (err) {
    console.warn('[messages] auto-reply log read failed:', err);
  }

  // Sort by time ascending so order is deterministic regardless of how
  // Beds24 returns the page. Drop internal notes. Cap at the most recent
  // `limit` messages. Returned oldest-first so the client renders top→bottom.
  const messages: ThreadMessage[] = raw
    .filter((m) => m.source !== 'internalNote')
    .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
    .slice(-limit)
    .map((m) => ({
      id: m.id,
      bookingId: m.bookingId,
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
    // A person just wrote to this guest — pause auto-replies for 24 h so a
    // canned answer doesn't land on top of the conversation.
    await markOperatorActive(getRedis(), bookingId);
    return NextResponse.json({ ok: true, messageId: result.messageId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 502 });
  }
}
