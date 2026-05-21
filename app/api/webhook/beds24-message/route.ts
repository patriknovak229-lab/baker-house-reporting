/**
 * POST /api/webhook/beds24-message
 *
 * Receives Beds24 webhook events and runs the guest-message auto-reply
 * pipeline. Register this URL in the Beds24 control panel under
 *   Settings → API → Webhooks → "New message" notification type
 * (or any event type — the handler filters internally to message events
 * with source=guest and ignores everything else).
 *
 * Flow:
 *   1. Validate payload shape, return 200 immediately to Beds24 even on
 *      errors (failed retries cause more harm than missed auto-replies).
 *   2. Dedupe by Beds24 message id via Redis (`baker:auto-reply:processed`).
 *   3. Categorise the message via Claude Haiku.
 *   4. If confidence ≥ 0.8 AND category != other:
 *      - parking / wifi / minibar: render reply, wait 10s for natural feel,
 *        POST to Beds24, audit-log, count toward daily limit.
 *      - early-checkin / late-checkout: same auto-reply ("we'll check") AND
 *        append a red `problem` task to reservation.issues via local-state.
 *   5. Audit log appended for every action (sent / skipped / errored).
 *
 * Returns 200 immediately; the work above runs in `after()` so Beds24
 * never waits on our processing. `maxDuration = 60` gives the after-block
 * time to complete the 10-second human-feel delay + send round trip.
 *
 * Bypasses NextAuth — `api/webhook/*` is already in proxy.ts's matcher
 * exclusion list, same as the existing new-booking webhook.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { Redis } from '@upstash/redis';
import type { Reservation, Issue, Room } from '@/types/reservation';
import { sendBeds24Message } from '@/utils/beds24Messages';
import { detectAutoReplyCategory } from '@/utils/messageAutoReplyDetector';
import {
  buildTemplate,
  renderAutoReply,
} from '@/utils/messageAutoReplyTemplates';
import { computeParking } from '@/utils/parkingUtils';

export const maxDuration = 60;

// Redis keys
const PROCESSED_KEY = 'baker:auto-reply:processed'; // Set<beds24MessageId>
const LOG_KEY = 'baker:auto-reply:log';             // AutoReplyLogEntry[]
const RATE_LIMIT_PREFIX = 'baker:auto-reply:count'; // :{bookingId}:{yyyymmdd}
const BOOKINGS_CACHE_KEY = 'baker:beds24-bookings-cache';
const LOCAL_STATE_KEY = 'baker:reservation-overrides';

const MAX_AUTO_REPLIES_PER_BOOKING_PER_DAY = 3;
const CONFIDENCE_THRESHOLD = 0.8;
const NATURAL_FEEL_DELAY_MS = 10_000;

// Beds24 roomId → physical Room name. Keep in sync with UNIT_MAP in
// app/api/bookings/route.ts. Intentionally duplicated rather than imported
// from a Next.js route file (Next discourages cross-route imports).
const UNIT_MAP: Record<number, Room> = {
  656437: 'K.201',
  648596: 'K.202',
  648772: 'K.203',
  674672: 'O.308',
  679703: 'K.102',
  679704: 'K.103',
  679705: 'K.106',
};

interface Beds24MessagePayload {
  timeStamp?: string;
  booking?: {
    id?: number | string;
    bookId?: number | string;
    roomId?: number | string;
    firstName?: string;
    lastName?: string;
    arrival?: string;
    departure?: string;
    masterId?: number | string;
    comments?: string;
  };
  message?: {
    id?: number | string;
    source?: 'guest' | 'host' | 'system' | 'internalNote';
    message?: string;
    time?: string;
  };
}

interface AutoReplyLogEntry {
  id: string;
  beds24MessageId: number;
  beds24SentMessageId: number | null;
  bookingId: number;
  reservationNumber: string;
  category: string;
  confidence: number;
  language: string;
  action: 'sent' | 'sent-with-task' | 'skipped-other' | 'skipped-rate-limit' | 'skipped-no-template' | 'errored';
  sentText: string | null;
  detail?: string;
  decidedAt: string;
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function POST(req: NextRequest) {
  let payload: Beds24MessagePayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid-json' }, { status: 200 });
  }

  const msg = payload.message;
  const booking = payload.booking;

  // Only process guest messages — ignore host replies, system events,
  // and booking-only payloads (those go to /api/webhook/new-booking).
  if (!msg || msg.source !== 'guest' || !msg.message?.trim()) {
    return NextResponse.json({ ok: true, reason: 'not-guest-message' });
  }
  if (!booking?.id) {
    return NextResponse.json({ ok: true, reason: 'no-booking' });
  }

  // Snapshot the fields the after-block needs — `req` is unsafe to use post-response.
  const messageId = Number(msg.id);
  const messageText = String(msg.message);
  const bookingId = Number(booking.id ?? booking.bookId);

  if (!Number.isFinite(messageId) || !Number.isFinite(bookingId)) {
    return NextResponse.json({ ok: true, reason: 'malformed-ids' });
  }

  // Heavy work runs after we return 200 to Beds24
  after(async () => {
    try {
      await processGuestMessage({
        bookingId,
        messageId,
        messageText,
        booking,
      });
    } catch (err) {
      console.error('[auto-reply webhook] after() handler failed:', err);
    }
  });

  return NextResponse.json({ ok: true });
}

interface ProcessArgs {
  bookingId: number;
  messageId: number;
  messageText: string;
  booking: NonNullable<Beds24MessagePayload['booking']>;
}

async function processGuestMessage(args: ProcessArgs): Promise<void> {
  const { bookingId, messageId, messageText, booking } = args;
  const redis = getRedis();
  const reservationNumber = `BH-${bookingId}`;

  // ── Step 1: dedupe ─────────────────────────────────────────────────────────
  if (redis) {
    const already = await redis.sismember(PROCESSED_KEY, String(messageId));
    if (already) {
      console.log(`[auto-reply] msg ${messageId} already processed — skipping`);
      return;
    }
    // Mark as processed eagerly so a retry from Beds24 doesn't double-send
    await redis.sadd(PROCESSED_KEY, String(messageId));
  }

  // ── Step 2: detect category ────────────────────────────────────────────────
  const detection = await detectAutoReplyCategory(messageText);
  console.log(
    `[auto-reply] msg ${messageId} (booking ${bookingId}) → category=${detection.category} conf=${detection.confidence.toFixed(2)} lang=${detection.language}`,
  );

  if (detection.category === 'other' || detection.confidence < CONFIDENCE_THRESHOLD) {
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'skipped-other',
      sentText: null,
      detail: `confidence ${detection.confidence.toFixed(2)} below threshold or category=other`,
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  // ── Step 3: rate limit ─────────────────────────────────────────────────────
  if (redis) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterKey = `${RATE_LIMIT_PREFIX}:${bookingId}:${day}`;
    const count = Number((await redis.get(counterKey)) ?? 0);
    if (count >= MAX_AUTO_REPLIES_PER_BOOKING_PER_DAY) {
      console.log(`[auto-reply] booking ${bookingId} hit daily cap (${count}) — skipping`);
      await appendLog(redis, {
        id: makeLogId(),
        beds24MessageId: messageId,
        beds24SentMessageId: null,
        bookingId,
        reservationNumber,
        category: detection.category,
        confidence: detection.confidence,
        language: detection.language,
        action: 'skipped-rate-limit',
        sentText: null,
        detail: `${count} auto-replies already sent for this booking today`,
        decidedAt: new Date().toISOString(),
      });
      return;
    }
  }

  // ── Step 4: build reservation context for templates ───────────────────────
  const reservation = await buildReservationContext(redis, bookingId, booking);
  if (!reservation) {
    console.warn(`[auto-reply] no reservation context for booking ${bookingId} — skipping`);
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'errored',
      sentText: null,
      detail: 'reservation context unavailable',
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  // ── Step 5: build the template ─────────────────────────────────────────────
  const allReservations = await loadAllReservations(redis);
  const parking = computeParking(allReservations.length > 0 ? allReservations : [reservation]);
  const built = buildTemplate(detection.category, reservation, parking);
  if (!built) {
    console.log(`[auto-reply] no template for ${detection.category} on ${reservation.room} — skipping`);
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'skipped-no-template',
      sentText: null,
      detail: `category ${detection.category} not applicable for room ${reservation.room}`,
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  // ── Step 6: render + delay + send ──────────────────────────────────────────
  const finalText = await renderAutoReply(built, reservation.firstName, detection.language);

  // 10-second "natural feel" pause so the auto-reply doesn't betray itself
  // as a bot. Inside an `after()` block so we don't hold up the webhook response.
  await sleep(NATURAL_FEEL_DELAY_MS);

  let sentMessageId: number | null = null;
  try {
    const sendResult = await sendBeds24Message(bookingId, finalText);
    sentMessageId = sendResult.messageId;
  } catch (err) {
    console.error(`[auto-reply] send failed for booking ${bookingId}:`, err);
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'errored',
      sentText: finalText,
      detail: err instanceof Error ? err.message : String(err),
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  // ── Step 7: rate-limit counter + task creation for early/late ──────────────
  let action: AutoReplyLogEntry['action'] = 'sent';
  if (redis) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterKey = `${RATE_LIMIT_PREFIX}:${bookingId}:${day}`;
    await redis.incr(counterKey);
    await redis.expire(counterKey, 48 * 60 * 60); // 48h auto-cleanup

    if (detection.category === 'early-checkin' || detection.category === 'late-checkout') {
      await appendIssueToReservation(
        redis,
        reservationNumber,
        detection.category,
        messageText,
        reservation,
      );
      action = 'sent-with-task';
    }
  }

  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: messageId,
    beds24SentMessageId: sentMessageId,
    bookingId,
    reservationNumber,
    category: detection.category,
    confidence: detection.confidence,
    language: detection.language,
    action,
    sentText: finalText,
    decidedAt: new Date().toISOString(),
  });
  console.log(`[auto-reply] sent ${detection.category} reply to booking ${bookingId}`);
}

// ─── Reservation context helpers ─────────────────────────────────────────────

/**
 * Build a minimal Reservation shape for template purposes from the cached
 * Beds24 booking + local-state overrides. Avoids re-running the full
 * bookings/route.ts pipeline (mergeGroupedBookings + mapToReservation etc.)
 * — we only need firstName, room, linkedRooms, parkingOverride.
 *
 * `linkedRooms` is best-effort: we look up siblings via masterId in the
 * cache. Multi-unit packages via the [GROUP:xxx] comment marker fall
 * through to single-room handling — the wifi reply will then only list
 * the primary room. That's an acceptable v1 trade-off.
 */
async function buildReservationContext(
  redis: Redis | null,
  bookingId: number,
  webhookBooking: NonNullable<Beds24MessagePayload['booking']>,
): Promise<Reservation | null> {
  type CachedBooking = {
    id?: number;
    roomId?: number;
    masterId?: number | null;
    firstName?: string;
    lastName?: string;
    arrival?: string;
    departure?: string;
    comments?: string;
  };

  let cached: Record<string, CachedBooking> = {};
  if (redis) {
    cached = (await redis.get<Record<string, CachedBooking>>(BOOKINGS_CACHE_KEY)) ?? {};
  }

  // Prefer cached booking (it has fields the webhook payload might omit) —
  // fall back to webhook payload data if the cache hasn't ingested this booking yet.
  const cachedThis = cached[String(bookingId)];
  const b = cachedThis ?? (webhookBooking as CachedBooking);

  const primaryRoomId = Number(b.roomId);
  const primaryRoom = UNIT_MAP[primaryRoomId];
  if (!primaryRoom) {
    // Virtual-room booking with no physical roomId assigned yet — skip
    return null;
  }

  // Discover sibling rooms in the SAME group (masterId match) — covers
  // virtual-room sub-allocations (Twin Apartments K.202+K.203 etc.)
  const linkedRooms: string[] = [];
  if (b.masterId) {
    const masterId = Number(b.masterId);
    for (const other of Object.values(cached)) {
      if (other.id === bookingId) continue;
      if (other.masterId === masterId) {
        const r = UNIT_MAP[Number(other.roomId)];
        if (r && r !== primaryRoom && !linkedRooms.includes(r)) {
          linkedRooms.push(r);
        }
      }
    }
  }

  // Apply local-state overrides (parkingOverride)
  let parkingOverride: string | undefined;
  if (redis) {
    const overrides = (await redis.get<Record<string, { parkingOverride?: string }>>(LOCAL_STATE_KEY)) ?? {};
    parkingOverride = overrides[`BH-${bookingId}`]?.parkingOverride;
  }

  // Build a minimal Reservation just for what the templates need.
  // Fields not used by buildTemplate are left as sensible defaults.
  return {
    reservationNumber: `BH-${bookingId}`,
    isBlackout: false,
    firstName: b.firstName ?? webhookBooking.firstName ?? '',
    lastName: b.lastName ?? webhookBooking.lastName ?? '',
    channel: 'Direct',
    room: primaryRoom,
    linkedRooms: linkedRooms.length > 0 ? linkedRooms : undefined,
    checkInDate: b.arrival ?? webhookBooking.arrival ?? '',
    checkOutDate: b.departure ?? webhookBooking.departure ?? '',
    reservationDate: '',
    bookingTimestamp: '',
    numberOfNights: 0,
    numberOfGuests: 0,
    email: '',
    phone: '',
    price: 0,
    nationality: '',
    cleaningStatus: 'Pending',
    paymentStatus: 'Unpaid',
    amountPaid: 0,
    commissionAmount: 0,
    paymentChargeAmount: 0,
    additionalEmail: '',
    paymentStatusOverride: null,
    notes: '',
    manualFlagOverrides: {},
    ratingStatus: 'none',
    invoiceData: null,
    invoiceStatus: 'Not Issued',
    parkingOverride,
  };
}

/**
 * Load all cached bookings as minimal Reservation[] for computeParking().
 * We need every active reservation so the parking auto-assignment
 * accounts for overlapping bookings (assigned space might be occupied).
 */
async function loadAllReservations(redis: Redis | null): Promise<Reservation[]> {
  if (!redis) return [];
  type CachedBooking = {
    id?: number;
    roomId?: number;
    masterId?: number | null;
    firstName?: string;
    lastName?: string;
    arrival?: string;
    departure?: string;
    status?: string;
  };
  const cached = (await redis.get<Record<string, CachedBooking>>(BOOKINGS_CACHE_KEY)) ?? {};
  const overrides = (await redis.get<Record<string, { parkingOverride?: string }>>(LOCAL_STATE_KEY)) ?? {};

  const out: Reservation[] = [];
  for (const b of Object.values(cached)) {
    if (b.status === 'cancelled' || b.status === 'canceled') continue;
    if (!b.id || !b.roomId || !b.arrival || !b.departure) continue;
    const room = UNIT_MAP[Number(b.roomId)];
    if (!room) continue;
    out.push({
      reservationNumber: `BH-${b.id}`,
      isBlackout: false,
      firstName: b.firstName ?? '',
      lastName: b.lastName ?? '',
      channel: 'Direct',
      room,
      checkInDate: b.arrival,
      checkOutDate: b.departure,
      reservationDate: '',
      bookingTimestamp: '',
      numberOfNights: 0,
      numberOfGuests: 0,
      email: '',
      phone: '',
      price: 0,
      nationality: '',
      cleaningStatus: 'Pending',
      paymentStatus: 'Unpaid',
      amountPaid: 0,
      commissionAmount: 0,
      paymentChargeAmount: 0,
      additionalEmail: '',
      paymentStatusOverride: null,
      notes: '',
      manualFlagOverrides: {},
      ratingStatus: 'none',
      invoiceData: null,
      invoiceStatus: 'Not Issued',
      parkingOverride: overrides[`BH-${b.id}`]?.parkingOverride,
    });
  }
  return out;
}

// ─── Task creation (early-checkin / late-checkout) ───────────────────────────

async function appendIssueToReservation(
  redis: Redis,
  reservationNumber: string,
  category: 'early-checkin' | 'late-checkout',
  originalMessage: string,
  reservation: Reservation,
): Promise<void> {
  const overrides = (await redis.get<Record<string, { issues?: Issue[] }>>(LOCAL_STATE_KEY)) ?? {};
  const current = overrides[reservationNumber] ?? {};
  const issues: Issue[] = Array.isArray(current.issues) ? current.issues : [];

  // Actionable date: day before arrival (for early check-in) or day
  // before departure (for late checkout). Falls back to today if the
  // reservation has no dates (shouldn't happen but defensive).
  const refDate = category === 'early-checkin'
    ? reservation.checkInDate
    : reservation.checkOutDate;
  const actionableDate = refDate
    ? dayBefore(refDate)
    : new Date().toISOString().slice(0, 10);

  const text =
    category === 'early-checkin'
      ? `Early check-in requested: "${trimQuote(originalMessage)}"`
      : `Late checkout requested: "${trimQuote(originalMessage)}"`;

  const newIssue: Issue = {
    id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: 'problem', // user requested red task
    text,
    actionableDate,
    resolved: false,
    createdAt: new Date().toISOString(),
  };

  overrides[reservationNumber] = {
    ...current,
    issues: [...issues, newIssue],
  };
  await redis.set(LOCAL_STATE_KEY, overrides);
}

function dayBefore(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function trimQuote(s: string): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? clean.slice(0, 117) + '…' : clean;
}

// ─── Audit log ───────────────────────────────────────────────────────────────

async function appendLog(redis: Redis | null, entry: AutoReplyLogEntry): Promise<void> {
  if (!redis) return;
  const existing = (await redis.get<AutoReplyLogEntry[]>(LOG_KEY)) ?? [];
  // Keep most recent 500 entries to bound memory
  const next = [...existing, entry].slice(-500);
  await redis.set(LOG_KEY, next);
}

function makeLogId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}
