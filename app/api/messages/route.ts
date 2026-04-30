import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { getAccessToken } from '@/utils/beds24Auth';
import { requireRole } from '@/utils/authGuard';
import { isInvoiceRequest, parseInvoiceRequest } from '@/utils/invoiceRequestParser';
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

  // Side effect: detect invoice-request templates from Booking.com.
  // Fire-and-forget — don't block the messages response on Redis writes.
  detectAndStoreInvoiceRequests(Number(bookingId), raw).catch((err) =>
    console.error('[messages] invoice-request detection failed', err),
  );

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
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

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
