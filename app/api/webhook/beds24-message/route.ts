/**
 * POST /api/webhook/beds24-message
 *
 * Single entry point for the Beds24 Inventory Webhook. Beds24's
 * Marketplace → Webhooks UI fires a MINIMAL payload on any room change:
 *
 *   { "roomId": "123456", "propId": "12345", "ownerId": "1234", "action": "SYNC_ROOM" }
 *
 * No booking object, no message object — just a "something changed for
 * this room" signal. We therefore run PULL-STYLE: receive the ping →
 * fetch fresh data from Beds24 → process new items.
 *
 * On every fire we:
 *   1. Fetch unread guest messages for the property (Beds24
 *      /bookings/messages?filter=unread&source=guest&maxAge=1).
 *   2. For each message not yet in `baker:auto-reply:processed`, run
 *      the categorise → 10s delay → send pipeline.
 *   3. Fetch the latest bookings from our Redis cache, find any with
 *      bookingTime within the last 30 min that aren't already in
 *      `notified:booking:*`, and fire the Telegram new-booking
 *      notification (subsumes the old /api/webhook/new-booking route).
 *
 * To avoid hammering Beds24 when Beds24 itself fires the webhook in
 * bursts (price + inventory changes can fan out to many SYNC_ROOM
 * events in a second), we debounce on `baker:auto-reply:last-poll`
 * with a 15-second window.
 *
 * Setup: Beds24 control panel → Settings → Marketplace → Webhooks →
 * Inventory Webhooks. Enter this URL once and enable every PHYSICAL
 * room (not the virtual selling rooms 648816 / 679714). Bypasses
 * NextAuth via `api/webhook` being in proxy.ts's matcher exclusion.
 */

import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import { Redis } from '@upstash/redis';
import type { Reservation, Issue, Room, InvoiceData } from '@/types/reservation';
import type { InvoiceRequest } from '@/types/invoiceRequest';
import { getAccessToken } from '@/utils/beds24Auth';
import { sendBeds24Message } from '@/utils/beds24Messages';
import {
  detectAutoReplyCategory,
  type AutoReplyCategory,
} from '@/utils/messageAutoReplyDetector';
import {
  buildTemplate,
  renderAutoReply,
} from '@/utils/messageAutoReplyTemplates';
import { isInvoiceRequest } from '@/utils/invoiceRequestParser';
import {
  extractInvoiceFields,
  mergeInvoiceFields,
  missingMandatoryFields,
  type ExtractedInvoiceFields,
} from '@/utils/invoiceFieldExtractor';
import {
  renderMissingFieldsReply,
  renderInvoiceConfirmation,
  type InvoiceMandatory,
} from '@/utils/invoiceReplyTemplates';
import { computeParking } from '@/utils/parkingUtils';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const POLL_DEBOUNCE_MS = 15_000; // 15s — collapses bursts of SYNC_ROOM events
/**
 * Short-TTL "we're polling now" lock used purely for debouncing bursts.
 * Expires fast so a crashed handler doesn't permanently block future polls.
 */
const DEBOUNCE_KEY = 'baker:auto-reply:debounce-until';
/**
 * Persistent diagnostic key — last time a webhook successfully kicked off
 * the after() block. Surfaced on /auto-reply-log as "Last webhook poll"
 * so the operator can tell whether Beds24 is firing the trigger at all.
 * No TTL — we want to keep the most recent value indefinitely.
 */
const LAST_POLL_KEY = 'baker:auto-reply:last-poll';
const INVOICE_REQUESTS_KEY = 'baker:invoice-requests';

// Invoice flow: how long to wait between the initial ask and the
// (single) reminder. Per operator policy: remind once after 24 hours
// then stop — it's the guest's request, not ours.
const INVOICE_REMINDER_AFTER_MS = 24 * 60 * 60 * 1000;
const INVOICE_MAX_ASKS = 2; // initial ask + one 24h reminder

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

// New-booking notification — extended map including virtual rooms so the
// Telegram label is human-friendly for direct-web bookings that land on
// the VR before Beds24 allocates the physical sub-room.
const ROOM_LABEL_MAP: Record<string, string> = {
  '656437': 'K.201',
  '648596': 'K.202',
  '648772': 'K.203',
  '674672': 'O.308',
  '648816': 'K.202 / K.203', // 1KK Deluxe Twin VR
  '679703': 'K.102',
  '679704': 'K.103',
  '679705': 'K.106',
  '679714': 'K.102 / K.103 / K.106', // 1KK Urban Studios VR
};

const NEW_BOOKING_WINDOW_MS = 30 * 60 * 1000;       // 30 min — anything older is a modification
const NOTIFIED_TTL_SECONDS = 2 * 60 * 60;            // 2 h — Redis dedupe TTL for new-booking Telegram

/** Minimal Beds24 Inventory Webhook payload. Documented under
 *  Settings → Marketplace → Webhooks: `{"roomId":"X","propId":"X","ownerId":"X","action":"SYNC_ROOM"}`.
 *  No booking or message data — those are pulled from Beds24 on demand. */
interface Beds24InventoryWebhookPayload {
  roomId?: string | number;
  propId?: string | number;
  ownerId?: string | number;
  action?: string;
}

/** Shape we use internally for a fetched unread guest message. */
interface UnreadGuestMessage {
  id: number;
  bookingId: number;
  message: string;
  time: string;
}

/** Shape of a cached Beds24 booking entry (subset we need here). */
interface CachedBooking {
  id?: number;
  bookId?: number;
  roomId?: number;
  masterId?: number | null;
  firstName?: string;
  lastName?: string;
  arrival?: string;
  departure?: string;
  comments?: string;
  numAdult?: number | string;
  numChild?: number | string;
  price?: number | string;
  apiSource?: string;
  status?: string;
  bookingTime?: string;
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
  // Optional secret check — set WEBHOOK_SECRET in env to lock this down
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.nextUrl.searchParams.get('secret');
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let payload: Beds24InventoryWebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'invalid-json' }, { status: 200 });
  }

  // Beds24 only sends `action: "SYNC_ROOM"` events here. Anything else
  // gets a friendly 200 so Beds24 doesn't retry indefinitely.
  if (payload.action !== 'SYNC_ROOM') {
    return NextResponse.json({ ok: true, reason: 'unknown-action', action: payload.action });
  }

  const redis = getRedis();

  // ── Debounce ──
  if (redis) {
    const now = Date.now();
    const debounceUntil = await redis.get<number>(DEBOUNCE_KEY);
    if (debounceUntil && now < debounceUntil) {
      return NextResponse.json({ ok: true, reason: 'debounced' });
    }
    await redis.set(DEBOUNCE_KEY, now + POLL_DEBOUNCE_MS, { ex: 60 });
    await redis.set(LAST_POLL_KEY, now); // persistent — no TTL
  }

  // Heavy work runs after we return 200 to Beds24
  after(async () => {
    try {
      // Run both flows in parallel — message auto-reply is the
      // headline feature; Telegram new-booking notification piggybacks
      // on the same trigger.
      await Promise.all([
        pollAndProcessUnreadMessages(redis),
        pollAndNotifyNewBookings(redis),
      ]);
    } catch (err) {
      console.error('[auto-reply webhook] after() handler failed:', err);
    }
  });

  return NextResponse.json({ ok: true, branch: 'sync-room-poll' });
}

// ─── Pull-style: unread guest messages ───────────────────────────────────────

/**
 * Fetch every currently-unread guest message from Beds24 and run the
 * auto-reply pipeline on any we haven't already processed. Dedupe via
 * the `baker:auto-reply:processed` Redis Set ensures each message gets
 * handled exactly once even when SYNC_ROOM fires repeatedly.
 */
async function pollAndProcessUnreadMessages(redis: Redis | null): Promise<void> {
  // Pass 1 — chase any 24-hour invoice reminders. Independent of any
  // incoming message; runs on every webhook fire so reminders are sent
  // promptly without needing a separate cron slot.
  if (redis) {
    try {
      await sendDueInvoiceReminders(redis);
    } catch (err) {
      console.error('[auto-reply] invoice reminder pass failed:', err);
    }
  }

  const messages = await fetchUnreadGuestMessages();
  if (messages.length === 0) return;

  // Pass 2 — process new messages. Serially so the 10-second human-feel
  // delay doesn't compound into ten simultaneous replies on a chatty
  // conversation.
  for (const m of messages) {
    // Dedupe — shared between invoice + regular auto-reply paths so a
    // message that triggers the invoice flow doesn't ALSO trigger the
    // regular auto-reply later in the same poll.
    if (redis) {
      const already = await redis.sismember(PROCESSED_KEY, String(m.id));
      if (already) continue;
      await redis.sadd(PROCESSED_KEY, String(m.id));
    }

    try {
      const handled = await tryInvoiceFlow({
        redis,
        bookingId: m.bookingId,
        messageId: m.id,
        messageText: m.message,
      });
      if (handled) continue;

      await processGuestMessage({
        bookingId: m.bookingId,
        messageId: m.id,
        messageText: m.message,
        skipDedupe: true, // already deduped above
      });
    } catch (err) {
      console.error(`[auto-reply] processing failed for msg ${m.id}:`, err);
    }
  }
}

async function fetchUnreadGuestMessages(): Promise<UnreadGuestMessage[]> {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[auto-reply] Beds24 token fetch failed:', err);
    return [];
  }

  // maxAge=1 → past 24h; source=guest → only guest messages.
  // We then narrow further in-process: keep only messages from the last
  // 15 min so a long-stale unread isn't auto-replied days later.
  const params = new URLSearchParams({
    filter: 'unread',
    maxAge: '1',
    source: 'guest',
  });

  let res: Response;
  try {
    res = await fetch(`${BEDS24_API_BASE}/bookings/messages?${params}`, {
      headers: { token },
      cache: 'no-store',
    });
  } catch (err) {
    console.error('[auto-reply] Beds24 messages fetch failed:', err);
    return [];
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[auto-reply] Beds24 messages ${res.status}: ${text.slice(0, 200)}`);
    return [];
  }

  const json = await res.json().catch(() => null);
  const raw: Array<Record<string, unknown>> =
    Array.isArray(json) ? json : (Array.isArray((json as { data?: unknown[] })?.data) ? (json as { data: Record<string, unknown>[] }).data : []);

  const fifteenMinAgo = Date.now() - 15 * 60 * 1000;
  const out: UnreadGuestMessage[] = [];
  for (const m of raw) {
    const id = Number(m.id);
    const bookingId = Number(m.bookingId);
    const message = typeof m.message === 'string' ? m.message : '';
    const time = typeof m.time === 'string' ? m.time : '';
    if (!Number.isFinite(id) || !Number.isFinite(bookingId)) continue;
    if (!message.trim()) continue;
    // Drop messages older than 15 min so a re-fire on a long-stale
    // unread doesn't mass-reply hours after the fact.
    if (time) {
      const t = new Date(time).getTime();
      if (Number.isFinite(t) && t < fifteenMinAgo) continue;
    }
    out.push({ id, bookingId, message, time });
  }
  return out;
}

// ─── Pull-style: new bookings Telegram notification ──────────────────────────

/**
 * Scan the bookings cache for any reservation whose `bookingTime` is
 * within the last 30 min AND that hasn't already been notified. Sends
 * Telegram for each. This replaces the old direct-payload mechanism in
 * /api/webhook/new-booking — same dedupe (Redis `notified:booking:*`),
 * same filtering rules, just driven by a poll instead of the payload.
 */
async function pollAndNotifyNewBookings(redis: Redis | null): Promise<void> {
  if (!redis) return;
  const cached =
    (await redis.get<Record<string, CachedBooking>>(BOOKINGS_CACHE_KEY)) ?? {};
  const now = Date.now();

  for (const b of Object.values(cached)) {
    if (!b.bookingTime) continue;
    const age = now - new Date(b.bookingTime).getTime();
    if (age > NEW_BOOKING_WINDOW_MS || age < 0) continue;
    try {
      await maybeNotifyNewBooking(b);
    } catch (err) {
      console.error(`[beds24 webhook] notify failed for booking ${b.id}:`, err);
    }
  }
}

interface ProcessArgs {
  bookingId: number;
  messageId: number;
  messageText: string;
  /** Optional: payload-provided booking. Pull-style flow leaves this undefined
   *  and the reservation context is loaded from Redis cache instead. */
  booking?: CachedBooking;
  /** When true, skip the dedupe step inside this function — the caller has
   *  already added the message id to `baker:auto-reply:processed`. Used by
   *  the polling loop where dedupe happens at the top so it's shared with
   *  the invoice flow. */
  skipDedupe?: boolean;
}

async function processGuestMessage(args: ProcessArgs): Promise<void> {
  const { bookingId, messageId, messageText, booking, skipDedupe } = args;
  const redis = getRedis();
  const reservationNumber = `BH-${bookingId}`;

  // ── Step 1: dedupe (skipped when the caller already deduped) ───────────────
  if (redis && !skipDedupe) {
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

  // invoice-request shouldn't reach this function — tryInvoiceFlow above
  // handles it — but if it does (e.g. confidence below threshold for
  // the invoice path), treat it as "other" and skip rather than passing
  // an unsupported category to buildTemplate.
  if (
    detection.category === 'other' ||
    detection.category === 'invoice-request' ||
    detection.confidence < CONFIDENCE_THRESHOLD
  ) {
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
  /** Optional payload-provided booking — pull-style doesn't carry one, in
   *  which case all context is read from the bookings cache. */
  webhookBooking?: CachedBooking,
): Promise<Reservation | null> {
  let cached: Record<string, CachedBooking> = {};
  if (redis) {
    cached = (await redis.get<Record<string, CachedBooking>>(BOOKINGS_CACHE_KEY)) ?? {};
  }

  // Prefer cached booking (it has fields the webhook payload might omit) —
  // fall back to webhook payload data if the cache hasn't ingested this booking yet.
  const cachedThis = cached[String(bookingId)];
  const b: CachedBooking | undefined = cachedThis ?? webhookBooking;
  if (!b) {
    // Pull-style trigger AND cache miss → can't render templates safely
    return null;
  }

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
    firstName: b.firstName ?? webhookBooking?.firstName ?? '',
    lastName: b.lastName ?? webhookBooking?.lastName ?? '',
    channel: 'Direct',
    room: primaryRoom,
    linkedRooms: linkedRooms.length > 0 ? linkedRooms : undefined,
    checkInDate: b.arrival ?? webhookBooking?.arrival ?? '',
    checkOutDate: b.departure ?? webhookBooking?.departure ?? '',
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

  // Actionable date: the actual day of the event — arrival day for
  // early check-in, departure day for late checkout. That's when the
  // operator needs to decide and act, so that's when the task surfaces
  // in the dashboard's "next 7 days" banner.
  const actionableDate =
    (category === 'early-checkin' ? reservation.checkInDate : reservation.checkOutDate) ||
    new Date().toISOString().slice(0, 10);

  // Phrased explicitly as a REQUEST so it's clear nothing has been
  // auto-approved — the operator decides whether to accommodate. The
  // category gets its own visual lane (teal for early, orange for late),
  // distinct from the red "problem" lane which is reserved for actual
  // host-side issues.
  const text =
    category === 'early-checkin'
      ? `REQUEST · early check-in — guest wrote: "${trimQuote(originalMessage)}". Auto-reply offered keys from 12:00 + notify when ready. Operator to confirm timing on the day.`
      : `REQUEST · late checkout — guest wrote: "${trimQuote(originalMessage)}". Auto-reply said we'll confirm. Operator to decide on the day.`;

  const issueCategory: Issue['category'] =
    category === 'early-checkin' ? 'earlyCheckin' : 'lateCheckout';

  const newIssue: Issue = {
    id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: issueCategory,
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

// ─── Multi-turn invoice request flow ─────────────────────────────────────────

interface InvoiceFlowArgs {
  redis: Redis | null;
  bookingId: number;
  messageId: number;
  messageText: string;
}

/**
 * Dispatch the message to the invoice flow IF it belongs there. Returns
 * true when the invoice flow handled the message (the regular auto-reply
 * pipeline should then be skipped). Returns false to let the regular
 * pipeline take over.
 *
 * Decision tree:
 *   1. If this booking has a `pending` invoice request (legacy operator-
 *      driven flow), don't touch it — operator is handling.
 *   2. If `awaiting-info` exists → treat this message as a follow-up,
 *      extract fields, merge, decide auto-complete or wait.
 *   3. Else: check keyword path (existing Booking.com template detector)
 *      and LLM categorisation. If either fires → it's a NEW invoice
 *      request.
 *   4. Otherwise return false — regular pipeline handles it.
 */
async function tryInvoiceFlow(args: InvoiceFlowArgs): Promise<boolean> {
  const { redis, bookingId, messageId, messageText } = args;
  if (!redis) return false;

  const all = (await redis.get<InvoiceRequest[]>(INVOICE_REQUESTS_KEY)) ?? [];
  const forThisBooking = all.filter(
    (r) => r.reservationNumber === `BH-${bookingId}`,
  );

  // Existing pending request (legacy keyword path created it before this
  // webhook ran) → operator is in control. Don't fire auto-flow.
  const pending = forThisBooking.find((r) => r.status === 'pending');
  if (pending) return false;

  // Existing accepted/auto-completed → already done, nothing more to do here.
  // BUT we still classify this message as invoice-related so the regular
  // pipeline doesn't kick in with the wrong template (e.g. categoriser
  // returning 'other' on a "thanks!" follow-up).
  const completed = forThisBooking.find(
    (r) => r.status === 'accepted' || r.status === 'auto-completed',
  );

  const awaiting = forThisBooking.find((r) => r.status === 'awaiting-info');

  // Follow-up path — already in awaiting-info
  if (awaiting) {
    await handleInvoiceFollowUp({
      redis,
      messageId,
      messageText,
      request: awaiting,
      allRequests: all,
    });
    return true;
  }

  if (completed) {
    // The conversation has moved on; no further auto-action.
    return false;
  }

  // No existing record — is THIS message a new invoice request?
  // Two parallel detection paths run in any order.
  const keywordHit = isInvoiceRequest(messageText);
  let detected = keywordHit;
  let language = '';
  if (!detected) {
    const detection = await detectAutoReplyCategory(messageText);
    if (detection.category === 'invoice-request' && detection.confidence >= 0.8) {
      detected = true;
      language = detection.language;
    }
  }
  if (!detected) return false;

  await handleNewInvoiceRequest({
    redis,
    bookingId,
    messageId,
    messageText,
    language,
    allRequests: all,
  });
  return true;
}

interface NewRequestArgs {
  redis: Redis;
  bookingId: number;
  messageId: number;
  messageText: string;
  language: string;
  allRequests: InvoiceRequest[];
}

async function handleNewInvoiceRequest(args: NewRequestArgs): Promise<void> {
  const { redis, bookingId, messageId, messageText, language, allRequests } = args;
  const reservationNumber = `BH-${bookingId}`;

  // Extract whatever the guest provided in the initial message.
  const extracted = await extractInvoiceFields(messageText);
  // Detect language if extractor didn't surface one — small extra Haiku
  // call kept consistent with the regular pipeline's behaviour. Only
  // run when keyword path detected (language not yet known).
  let lang = language;
  if (!lang) {
    const d = await detectAutoReplyCategory(messageText);
    lang = d.language;
  }

  const request: InvoiceRequest = {
    id: `ir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    reservationNumber,
    beds24MessageId: messageId,
    rawMessage: messageText.slice(0, 4000),
    companyName: extracted.companyName,
    companyAddress: extracted.companyAddress,
    ico: extracted.ico,
    dic: extracted.dic,
    email: extracted.email,
    detectedAt: new Date().toISOString(),
    status: 'awaiting-info',
    asksCount: 0,
    lastExtractedFromAt: new Date().toISOString(),
  };

  const missing = missingMandatoryFields(extracted);
  if (missing.length === 0) {
    // Lucky path — initial message had everything we need. Skip ask, go
    // straight to auto-complete.
    await autoCompleteInvoiceRequest({
      redis,
      request: { ...request, status: 'auto-completed' },
      language: lang,
      allRequests,
    });
    return;
  }

  // Missing mandatory fields — send the ask, persist as awaiting-info.
  const reservation = await buildReservationContext(redis, bookingId);
  const firstName = reservation?.firstName ?? '';
  const replyText = await renderMissingFieldsReply(firstName, missing, lang);

  await sleep(10_000); // natural-feel delay
  let sentMessageId: number | null = null;
  try {
    const result = await sendBeds24Message(bookingId, replyText);
    sentMessageId = result.messageId;
  } catch (err) {
    console.error(`[invoice flow] missing-fields send failed for booking ${bookingId}:`, err);
  }

  const finalRequest: InvoiceRequest = {
    ...request,
    asksCount: 1,
    lastAskedAt: new Date().toISOString(),
  };
  await persistInvoiceRequests(redis, [...allRequests, finalRequest]);
  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: messageId,
    beds24SentMessageId: sentMessageId,
    bookingId,
    reservationNumber,
    category: 'invoice-request',
    confidence: 1,
    language: lang,
    action: 'sent',
    sentText: replyText,
    detail: `awaiting-info; missing: ${missing.join(', ')}`,
    decidedAt: new Date().toISOString(),
  });
  console.log(`[invoice flow] booking ${bookingId}: asked for ${missing.join(', ')}`);
}

interface FollowUpArgs {
  redis: Redis;
  messageId: number;
  messageText: string;
  request: InvoiceRequest;
  allRequests: InvoiceRequest[];
}

async function handleInvoiceFollowUp(args: FollowUpArgs): Promise<void> {
  const { redis, messageId, messageText, request, allRequests } = args;
  const bookingId = Number(request.reservationNumber.replace(/^BH-/, ''));

  // Re-extract from this new message
  const extracted = await extractInvoiceFields(messageText);
  const prior: ExtractedInvoiceFields = {
    companyName: request.companyName,
    companyAddress: request.companyAddress ?? null,
    ico: request.ico,
    dic: request.dic,
    email: request.email,
  };
  const merged = mergeInvoiceFields(prior, extracted);
  const missing = missingMandatoryFields(merged);

  const updatedRequest: InvoiceRequest = {
    ...request,
    companyName: merged.companyName,
    companyAddress: merged.companyAddress,
    ico: merged.ico,
    dic: merged.dic,
    email: merged.email,
    lastExtractedFromAt: new Date().toISOString(),
  };

  if (missing.length === 0) {
    // We have everything — auto-complete.
    await autoCompleteInvoiceRequest({
      redis,
      request: { ...updatedRequest, status: 'auto-completed' },
      language: '', // detector will infer for confirmation message
      allRequests,
    });
    return;
  }

  // Still missing — DO NOT send another ask here (the 24h reminder pass
  // handles the single follow-up). Just persist the merged fields and
  // log so we have a paper trail.
  await persistInvoiceRequests(redis, replaceInvoiceRequest(allRequests, updatedRequest));
  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: messageId,
    beds24SentMessageId: null,
    bookingId,
    reservationNumber: request.reservationNumber,
    category: 'invoice-request',
    confidence: 1,
    language: '',
    action: 'skipped-rate-limit', // closest existing action label
    sentText: null,
    detail: `partial info received, still missing: ${missing.join(', ')}`,
    decidedAt: new Date().toISOString(),
  });
}

interface AutoCompleteArgs {
  redis: Redis;
  request: InvoiceRequest;
  language: string;
  allRequests: InvoiceRequest[];
}

async function autoCompleteInvoiceRequest(args: AutoCompleteArgs): Promise<void> {
  const { redis, request, language, allRequests } = args;
  const bookingId = Number(request.reservationNumber.replace(/^BH-/, ''));

  // Look up reservation for checkout date + first name
  const reservation = await buildReservationContext(redis, bookingId);
  const checkoutDate = reservation?.checkOutDate ?? '';
  const firstName = reservation?.firstName ?? '';

  // Detect language from the most recent message if caller didn't pass it
  let lang = language;
  if (!lang) {
    const d = await detectAutoReplyCategory(request.rawMessage);
    lang = d.language;
  }

  // Persist invoiceData + create the red Send-invoice Issue via local-state.
  // Both end up in the same Redis blob so we do one read-modify-write.
  const overrides =
    (await redis.get<Record<string, { invoiceData?: InvoiceData; issues?: Issue[] }>>(LOCAL_STATE_KEY)) ?? {};
  const current = overrides[request.reservationNumber] ?? {};

  // Don't clobber any pre-existing invoiceData the operator may have set
  const existing = current.invoiceData ?? {
    companyName: '',
    companyAddress: '',
    ico: '',
    vatNumber: '',
    billingEmail: '',
  };
  const newInvoiceData: InvoiceData = {
    companyName: existing.companyName || request.companyName || '',
    companyAddress: existing.companyAddress || request.companyAddress || '',
    ico: existing.ico || request.ico || '',
    vatNumber: existing.vatNumber || request.dic || '',
    billingEmail: existing.billingEmail || request.email || '',
  };

  // Issue (red task per operator) actionable on checkout day
  const issues: Issue[] = Array.isArray(current.issues) ? current.issues : [];
  const newIssue: Issue = {
    id: `auto-invoice-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    category: 'invoice',
    text: newInvoiceData.companyName
      ? `Send invoice — ${newInvoiceData.companyName}${newInvoiceData.vatNumber ? ` (DIČ ${newInvoiceData.vatNumber})` : ''}`
      : 'Send invoice — guest requested',
    actionableDate: checkoutDate || new Date().toISOString().slice(0, 10),
    resolved: false,
    createdAt: new Date().toISOString(),
  };

  overrides[request.reservationNumber] = {
    ...current,
    invoiceData: newInvoiceData,
    issues: [...issues, newIssue],
  };
  await redis.set(LOCAL_STATE_KEY, overrides);

  // Mark the request auto-completed + persist
  const completedRequest: InvoiceRequest = {
    ...request,
    status: 'auto-completed',
    processedAt: new Date().toISOString(),
  };
  await persistInvoiceRequests(
    redis,
    replaceOrAppendInvoiceRequest(allRequests, completedRequest),
  );

  // Send confirmation reply
  const replyText = await renderInvoiceConfirmation(
    firstName,
    newInvoiceData.billingEmail,
    checkoutDate,
    lang,
  );
  await sleep(10_000);
  let sentMessageId: number | null = null;
  try {
    const result = await sendBeds24Message(bookingId, replyText);
    sentMessageId = result.messageId;
  } catch (err) {
    console.error(`[invoice flow] confirmation send failed for booking ${bookingId}:`, err);
  }

  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: request.beds24MessageId,
    beds24SentMessageId: sentMessageId,
    bookingId,
    reservationNumber: request.reservationNumber,
    category: 'invoice-request',
    confidence: 1,
    language: lang,
    action: 'sent-with-task',
    sentText: replyText,
    detail: `auto-completed; invoiceData + issue created for checkout ${checkoutDate}`,
    decidedAt: new Date().toISOString(),
  });
  console.log(`[invoice flow] booking ${bookingId}: auto-completed, invoice task created`);
}

/**
 * Scan all awaiting-info invoice requests for any whose initial ask was
 * sent more than 24 hours ago and have only had one ask. Send the
 * single reminder, bump asksCount. After this, the request stays at
 * status='awaiting-info' indefinitely — operator handles in the drawer
 * if the guest never replies. Per operator policy: no further nudges.
 */
async function sendDueInvoiceReminders(redis: Redis): Promise<void> {
  const all = (await redis.get<InvoiceRequest[]>(INVOICE_REQUESTS_KEY)) ?? [];
  const now = Date.now();
  const due = all.filter(
    (r) =>
      r.status === 'awaiting-info' &&
      (r.asksCount ?? 0) < INVOICE_MAX_ASKS &&
      r.lastAskedAt &&
      now - new Date(r.lastAskedAt).getTime() >= INVOICE_REMINDER_AFTER_MS,
  );
  if (due.length === 0) return;

  const updated = [...all];
  for (const r of due) {
    const bookingId = Number(r.reservationNumber.replace(/^BH-/, ''));
    const reservation = await buildReservationContext(redis, bookingId);
    const firstName = reservation?.firstName ?? '';
    // Re-derive missing fields from current request state
    const fields: ExtractedInvoiceFields = {
      companyName: r.companyName,
      companyAddress: r.companyAddress ?? null,
      ico: r.ico,
      dic: r.dic,
      email: r.email,
    };
    const missing = missingMandatoryFields(fields);
    if (missing.length === 0) {
      // Edge case: status drifted out of sync — request says
      // awaiting-info but actually has all fields. Auto-complete now.
      await autoCompleteInvoiceRequest({
        redis,
        request: { ...r, status: 'auto-completed' },
        language: '',
        allRequests: updated,
      });
      continue;
    }

    // Detect language from the most recent raw message
    const detection = await detectAutoReplyCategory(r.rawMessage);
    const replyText = await renderMissingFieldsReply(firstName, missing, detection.language);

    await sleep(10_000);
    let sentMessageId: number | null = null;
    try {
      const result = await sendBeds24Message(bookingId, replyText);
      sentMessageId = result.messageId;
    } catch (err) {
      console.error(`[invoice flow] reminder send failed for booking ${bookingId}:`, err);
    }

    // Update the request in place
    const idx = updated.findIndex((x) => x.id === r.id);
    if (idx >= 0) {
      updated[idx] = {
        ...updated[idx],
        asksCount: (updated[idx].asksCount ?? 0) + 1,
        lastAskedAt: new Date().toISOString(),
      };
    }

    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: r.beds24MessageId,
      beds24SentMessageId: sentMessageId,
      bookingId,
      reservationNumber: r.reservationNumber,
      category: 'invoice-request',
      confidence: 1,
      language: detection.language,
      action: 'sent',
      sentText: replyText,
      detail: `24h reminder #${(r.asksCount ?? 0) + 1}; still missing: ${missing.join(', ')}`,
      decidedAt: new Date().toISOString(),
    });
  }
  await persistInvoiceRequests(redis, updated);
}

// ─── Invoice-request Redis helpers ───────────────────────────────────────────

async function persistInvoiceRequests(
  redis: Redis,
  requests: InvoiceRequest[],
): Promise<void> {
  await redis.set(INVOICE_REQUESTS_KEY, requests);
}

/** Update an existing request in-place by id. Adds it if not present. */
function replaceOrAppendInvoiceRequest(
  list: InvoiceRequest[],
  updated: InvoiceRequest,
): InvoiceRequest[] {
  const idx = list.findIndex((r) => r.id === updated.id);
  if (idx < 0) return [...list, updated];
  const out = [...list];
  out[idx] = updated;
  return out;
}

/** Update an existing request in-place by id. Returns unchanged list if not found. */
function replaceInvoiceRequest(
  list: InvoiceRequest[],
  updated: InvoiceRequest,
): InvoiceRequest[] {
  const idx = list.findIndex((r) => r.id === updated.id);
  if (idx < 0) return list;
  const out = [...list];
  out[idx] = updated;
  return out;
}

// ─── New-booking Telegram notification (ported from /api/webhook/new-booking) ─

/**
 * Send a Telegram notification when this payload represents a brand-new
 * confirmed booking (not a modification, cancellation, sub-allocation,
 * or owner blackout). Dedupes by booking id via Redis so Beds24 retries
 * never spam the operator chat.
 */
async function maybeNotifyNewBooking(
  booking: CachedBooking,
): Promise<void> {
  // Cancellations + blackouts: not notified
  if (booking.status === 'cancelled' || booking.status === 'canceled') return;
  if (booking.status === 'black') return;

  // Sub-bookings of a virtual master always carry price=0; the master
  // holds the real price and is notified separately. Prevents duplicate
  // notifications for Twin Apartments / Urban Studios package bookings.
  if (Number(booking.price ?? 0) === 0) return;

  // Modifications: bookingTime older than 30 min = pre-existing booking
  // got changed (status flip, message, etc.). Not a new arrival.
  if (booking.bookingTime) {
    const age = Date.now() - new Date(booking.bookingTime).getTime();
    if (age > NEW_BOOKING_WINDOW_MS) return;
  }

  const roomKey = String(booking.roomId ?? '');
  const room = ROOM_LABEL_MAP[roomKey];
  if (!room) return; // virtual or unmapped room

  // Redis dedupe: one Telegram per booking id, regardless of how many
  // webhook retries fire.
  const bookingId = String(booking.id ?? '');
  const redis = getRedis();
  if (bookingId && redis) {
    const redisKey = `notified:booking:${bookingId}`;
    const already = await redis.get(redisKey);
    if (already) return;
    // Mark BEFORE sending so parallel webhook fires don't race
    await redis.set(redisKey, '1', { ex: NOTIFIED_TTL_SECONDS });
  }

  const firstName = booking.firstName ?? '';
  const lastName = booking.lastName ?? '';
  const guests =
    (Number(booking.numAdult ?? 0) + Number(booking.numChild ?? 0)) || '—';
  const nights =
    booking.arrival && booking.departure
      ? Math.round(
          (new Date(booking.departure).getTime() -
            new Date(booking.arrival).getTime()) /
            86_400_000,
        )
      : '—';
  const channel = booking.apiSource || 'Direct';
  const price = booking.price
    ? `${Number(booking.price).toLocaleString('cs-CZ')} Kč`
    : '—';

  const text = [
    `🏠 <b>New Booking — ${room}</b>`,
    `👤 ${firstName} ${lastName}`.trim() || '👤 —',
    `📅 ${formatDate(booking.arrival ?? '')} → ${formatDate(booking.departure ?? '')} (${nights} nights)`,
    `👥 ${guests} guests`,
    `📣 ${channel}`,
    `💰 ${price}`,
  ].join('\n');

  await sendTelegram(text);
}

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('[beds24 webhook] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[beds24 webhook] Telegram error:', text);
  }
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}
