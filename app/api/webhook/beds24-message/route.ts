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
  type ParkingIntent,
} from '@/utils/messageAutoReplyDetector';
import {
  buildTemplate,
  renderAutoReply,
} from '@/utils/messageAutoReplyTemplates';
import { draftAutoReply } from '@/utils/messageAutoReplyDrafter';
import { isInvoiceRequest } from '@/utils/invoiceRequestParser';
import {
  extractInvoiceFields,
  mergeInvoiceFields,
  missingMandatoryFields,
  sanitizeInvoiceEmail,
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
 * New-booking poll debounce. Slightly longer than the auto-reply
 * debounce because new-booking detection doesn't need millisecond
 * resolution — a 20s window costs the operator at most ~20s extra
 * Telegram latency in exchange for ~80% fewer Beds24 calls during
 * Beds24's frequent SYNC_ROOM bursts from channel price re-syncs
 * (which are most SYNC_ROOM events and return zero new bookings).
 */
const NEW_BOOKING_DEBOUNCE_MS = 20_000;
/**
 * Short-TTL "we're polling now" lock used purely for debouncing bursts.
 * Expires fast so a crashed handler doesn't permanently block future polls.
 */
const DEBOUNCE_KEY = 'baker:auto-reply:debounce-until';
/**
 * Independent debounce key for the new-booking notification flow.
 * Kept separate from DEBOUNCE_KEY so the two flows don't gate each
 * other — auto-reply debounce status shouldn't block Telegram, and
 * a fresh new-booking poll shouldn't reset the auto-reply window.
 */
const NEW_BOOKING_DEBOUNCE_KEY = 'baker:new-booking:debounce-until';
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

/**
 * One-shot per-booking per-category lock. Set after a successful auto-send
 * for a given (bookingId, category) pair; while it's set, follow-up
 * messages on that same category get routed to the operator-approval
 * queue (pending-drafts) instead of auto-sending again. 14-day TTL so a
 * fresh stay reuses the same booking without inheriting the lock from a
 * previous reservation under that id (Beds24 ids are unique, but the
 * TTL is a belt-and-braces hygiene measure).
 */
const CATEGORY_SENT_PREFIX = 'baker:auto-reply:category-sent'; // :{bookingId}:{category}
const CATEGORY_LOCK_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Pending drafts hash — messages for which the AI drafted a reply that
 * needs operator approval before sending. Field = beds24 messageId,
 * value = JSON of PendingDraft. Hashes don't support per-field TTL on
 * Upstash; we clean up on read (entries older than 14 days are HDEL'd).
 */
const PENDING_DRAFTS_KEY = 'baker:auto-reply:pending-drafts';
/**
 * Unread `other`-category messages awaiting operator handling. Same
 * shape considerations as pending-drafts. Cleanup of stale (>14d)
 * entries happens on read in /api/messages/unread.
 */
const PENDING_OTHERS_KEY = 'baker:auto-reply:pending-others';

const MAX_AUTO_REPLIES_PER_BOOKING_PER_DAY = 3;
const CONFIDENCE_THRESHOLD = 0.8;
const NATURAL_FEEL_DELAY_MS = 10_000;

/**
 * Categories currently in REVIEW-ONLY mode. Instead of auto-sending, the
 * fully-rendered reply (correct sub-case + translated) is queued for
 * operator approval in `pending-drafts` — the same queue the operator
 * already approves/edits/dismisses from. Lets us trial new reply logic
 * safely before letting it auto-send.
 *
 * TEST started 2026-06-08 — parking sub-intent replies. Remove 'parking'
 * from this set once the 1–2 week review trial is done to resume auto-send.
 */
const REVIEW_ONLY_CATEGORIES = new Set<AutoReplyCategory>(['parking']);

/**
 * How recent an unread guest message must be for the pipeline to process it.
 * Kept in sync with ACTIVE_WINDOW_MS (120 min) in /api/messages/unread: that
 * route both SHOWS unread messages for 120 min and nudges this webhook every
 * ~30s while the dashboard is open. A tighter window here created a dead zone
 * (15–120 min) where a message stayed visible and kept nudging the pipeline
 * but was never actually picked up. Messages older than this are left for the
 * operator; the 24h Beds24 maxAge + per-message dedupe stop us re-replying to
 * anything already handled.
 */
const UNREAD_FRESHNESS_MS = 120 * 60 * 1000; // 120 min — matches the operator panel

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

// New-booking notification — extended map including virtual rooms.
// For VRs we use the room-TYPE label (not the slash-joined physical list)
// because Beds24 doesn't auto-split VR bookings across nights — they sit
// on the VR until manually allocated. The Telegram should reflect that
// the operator booked an "Urban 1KK" and not pretend a specific physical
// room (K.102/K.103/K.106) has been assigned yet.
const ROOM_LABEL_MAP: Record<string, string> = {
  '656437': 'K.201',
  '648596': 'K.202',
  '648772': 'K.203',
  '674672': 'O.308',
  '648816': '1KK Deluxe Twin', // Twin VR — physical sub allocated later
  '679703': 'K.102',
  '679704': 'K.103',
  '679705': 'K.106',
  '679714': '1KK Urban Studios', // Urban VR — manual allocation required
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
  action:
    | 'sent'
    | 'sent-with-task'
    | 'skipped-other'        // legacy; superseded by 'queued-other'
    | 'skipped-rate-limit'
    | 'skipped-no-template'
    | 'queued-draft'         // category matched, but lock was set → drafted for operator approval
    | 'queued-other'         // category=other or low confidence → queued for operator handling
    | 'approved'             // operator approved a pending draft and it was sent
    | 'edited-approved'      // operator edited then approved a pending draft
    | 'dismissed'            // operator dismissed a pending draft / other entry
    | 'errored';
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

  // ── New-booking Telegram path ──
  // Runs in its OWN debounce window (NEW_BOOKING_DEBOUNCE_KEY), separate
  // from the auto-reply path so the two flows don't gate each other.
  // The new-booking-specific debounce is necessary because Beds24 fires
  // SYNC_ROOM in bursts for every price-list re-sync, availability tweak,
  // and channel update — most of which return zero new bookings but each
  // costs a Beds24 API credit. A 20s window collapses those bursts
  // without harming operator-perceived latency.
  //
  // Per-booking dedupe (`notified:booking:{id}`, 2h TTL) still prevents
  // duplicate Telegrams if multiple SYNC_ROOMs slip past the debounce.
  after(async () => {
    try {
      if (redis) {
        const now = Date.now();
        const until = await redis.get<number>(NEW_BOOKING_DEBOUNCE_KEY);
        if (until && now < until) return;
        await redis.set(NEW_BOOKING_DEBOUNCE_KEY, now + NEW_BOOKING_DEBOUNCE_MS, { ex: 60 });
      }
      await pollAndNotifyNewBookings(redis);
    } catch (err) {
      console.error('[beds24 webhook] new-booking poll failed:', err);
    }
  });

  // ── Auto-reply debounce ──
  // The auto-reply pipeline is expensive (Claude Haiku call per message,
  // Beds24 fetch, 10s natural-feel sleep). Collapsing SYNC_ROOM bursts
  // into one pass per 15s avoids hammering Beds24 and Anthropic during
  // price-update storms.
  if (redis) {
    const now = Date.now();
    const debounceUntil = await redis.get<number>(DEBOUNCE_KEY);
    if (debounceUntil && now < debounceUntil) {
      return NextResponse.json({ ok: true, reason: 'debounced-auto-reply' });
    }
    await redis.set(DEBOUNCE_KEY, now + POLL_DEBOUNCE_MS, { ex: 60 });
    await redis.set(LAST_POLL_KEY, now); // persistent — no TTL
  }

  after(async () => {
    try {
      await pollAndProcessUnreadMessages(redis);
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

  const freshnessCutoff = Date.now() - UNREAD_FRESHNESS_MS;
  const out: UnreadGuestMessage[] = [];
  for (const m of raw) {
    const id = Number(m.id);
    const bookingId = Number(m.bookingId);
    const message = typeof m.message === 'string' ? m.message : '';
    const time = typeof m.time === 'string' ? m.time : '';
    if (!Number.isFinite(id) || !Number.isFinite(bookingId)) continue;
    if (!message.trim()) continue;
    // Drop messages older than the freshness window so a re-fire on a
    // long-stale unread doesn't reply hours after the fact. Window matches
    // the operator panel's 120-min visibility so nothing shown as actionable
    // unread is silently skipped here.
    if (time) {
      const t = new Date(time).getTime();
      if (Number.isFinite(t) && t < freshnessCutoff) continue;
    }
    out.push({ id, bookingId, message, time });
  }
  return out;
}

// ─── Pull-style: new bookings Telegram notification ──────────────────────────

/**
 * Fetch recently-modified bookings DIRECTLY from Beds24 and fire a
 * Telegram notification for any that are brand-new (bookingTime within
 * the last 30 min) and not already notified.
 *
 * We deliberately do NOT read `baker:beds24-bookings-cache` here. That
 * cache only refreshes when an operator opens the dashboard — so a
 * booking landing outside operator hours would never appear in the
 * cache, and the Telegram would never fire until somebody loaded the
 * app. Hitting Beds24 directly removes that dependency: Telegram now
 * arrives within seconds regardless of dashboard activity.
 *
 * Cost: one extra Beds24 `/bookings?modifiedFrom=...` call per webhook
 * fire (typically <500ms, returns at most a handful of recently-modified
 * bookings). The per-booking `notified:booking:*` lock prevents duplicate
 * sends across overlapping polls.
 */
async function pollAndNotifyNewBookings(redis: Redis | null): Promise<void> {
  // Redis is needed for the per-booking dedupe lock further down the
  // pipeline. Without it we'd risk re-sending the same Telegram on every
  // SYNC_ROOM fire, so just bail.
  if (!redis) return;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[new-booking poll] Beds24 token fetch failed:', err);
    return;
  }

  // 5-minute lookback is wider than (debounce ✕ retry-burst) + Vercel
  // cold-start budget, so a SYNC_ROOM landing slightly late still picks
  // up the booking. Per-booking dedupe handles the resulting overlap.
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const params = new URLSearchParams();
  params.set('modifiedFrom', since);
  // Only statuses we'd actually notify on — keeps the payload small and
  // avoids parsing cancelled/black bookings just to discard them.
  params.append('status', 'confirmed');
  params.append('status', 'new');

  let fetched: CachedBooking[];
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, {
      headers: { token },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        `[new-booking poll] Beds24 ${res.status}: ${text.slice(0, 200)}`,
      );
      return;
    }
    const json = await res.json();
    fetched = Array.isArray(json) ? json : (json.data ?? []);
  } catch (err) {
    console.error('[new-booking poll] Beds24 fetch failed:', err);
    return;
  }

  const now = Date.now();
  for (const b of fetched) {
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
  // the invoice path), treat it as "other" and queue for the operator
  // rather than passing an unsupported category to buildTemplate.
  if (
    detection.category === 'other' ||
    detection.category === 'invoice-request' ||
    detection.confidence < CONFIDENCE_THRESHOLD
  ) {
    // Queue for the operator's "Unread messages" panel. We still try to
    // draft a candidate reply so the operator doesn't type from scratch
    // — but it's best-effort; empty draft is fine.
    let draftText = '';
    try {
      const draftReservation = await buildReservationContext(redis, bookingId, booking);
      if (draftReservation) {
        const result = await draftAutoReply({
          guestMessage: messageText,
          category: detection.category,
          language: detection.language,
          reservation: draftReservation,
        });
        // The drafter returns the literal "SKIP" when it doesn't have
        // enough grounding to write something useful. Treat that as
        // "no draft" so the operator gets a clean slate.
        draftText = result.draftText === 'SKIP' ? '' : result.draftText;
      }
    } catch (err) {
      console.warn(`[auto-reply] draft for other-message ${messageId} failed:`, err);
    }

    if (redis) {
      await persistPendingOther(redis, {
        beds24MessageId: messageId,
        bookingId,
        reservationNumber,
        guestMessageText: messageText,
        guestMessageTime: new Date().toISOString(),
        draftText,
        confidence: detection.confidence,
        language: detection.language,
        createdAt: new Date().toISOString(),
      });
    }

    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'queued-other',
      sentText: null,
      detail:
        detection.category === 'other'
          ? 'classified as other — queued for operator'
          : `confidence ${detection.confidence.toFixed(2)} below threshold — queued for operator`,
      decidedAt: new Date().toISOString(),
    });
    return;
  }

  // ── Review-only gate (test phase) ──────────────────────────────────────────
  // For categories under trial, never auto-send: render the EXACT reply that
  // would have gone out (correct sub-case + translated) and queue it for
  // operator approval (pending-drafts) instead. Bypasses the one-shot lock and
  // daily rate limit so every message surfaces a fresh, correctly-classified
  // draft. Remove the category from REVIEW_ONLY_CATEGORIES to resume auto-send.
  if (REVIEW_ONLY_CATEGORIES.has(detection.category)) {
    const reviewReservation = await buildReservationContext(redis, bookingId, booking);
    if (!reviewReservation) {
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
        detail: 'reservation context unavailable (review mode)',
        decidedAt: new Date().toISOString(),
      });
      return;
    }
    const reviewAll = await loadAllReservations(redis);
    const reviewParking = computeParking(reviewAll.length > 0 ? reviewAll : [reviewReservation]);
    const reviewBuilt = buildTemplate(
      detection.category,
      reviewReservation,
      reviewParking,
      detection.parkingIntent,
    );
    if (!reviewBuilt) {
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
        detail: `no template for ${detection.category} on room ${reviewReservation.room} (review mode)`,
        decidedAt: new Date().toISOString(),
      });
      return;
    }
    const reviewText = await renderAutoReply(
      reviewBuilt,
      reviewReservation.firstName,
      detection.language,
    );
    if (redis) {
      await persistPendingDraft(redis, {
        beds24MessageId: messageId,
        bookingId,
        reservationNumber,
        guestMessageText: messageText,
        guestMessageTime: new Date().toISOString(),
        category: detection.category,
        confidence: detection.confidence,
        language: detection.language,
        draftText: reviewText,
        parkingIntent: detection.parkingIntent,
        createdAt: new Date().toISOString(),
      });
    }
    await appendLog(redis, {
      id: makeLogId(),
      beds24MessageId: messageId,
      beds24SentMessageId: null,
      bookingId,
      reservationNumber,
      category: detection.category,
      confidence: detection.confidence,
      language: detection.language,
      action: 'queued-draft',
      sentText: null,
      detail: `review mode (${detection.category}${detection.parkingIntent ? `/${detection.parkingIntent}` : ''}) — rendered reply queued for operator approval`,
      decidedAt: new Date().toISOString(),
    });
    console.log(
      `[auto-reply] review mode — queued ${detection.category}/${detection.parkingIntent ?? '-'} draft for booking ${bookingId}`,
    );
    return;
  }

  // ── One-shot per-category lock check ───────────────────────────────────────
  // Even if this is a recognised, high-confidence category, only the FIRST
  // such question per booking auto-sends. Subsequent messages on the same
  // category get drafted for operator approval — protects against the
  // canned reply firing on every follow-up. For parking the lock is keyed per
  // sub-intent, so answering "where's my spot?" doesn't suppress a later
  // "can I charge my EV?".
  if (redis) {
    const locked = await isCategoryLocked(redis, bookingId, detection.category, detection.parkingIntent);
    if (locked) {
      // Build reservation context so the drafter has guest name + room.
      // If it fails (cache miss) we still queue the message with empty
      // draft — operator sees the question and types the reply.
      let draftText = '';
      const draftReservation = await buildReservationContext(redis, bookingId, booking);
      if (draftReservation) {
        try {
          const result = await draftAutoReply({
            guestMessage: messageText,
            category: detection.category,
            language: detection.language,
            reservation: draftReservation,
          });
          draftText = result.draftText === 'SKIP' ? '' : result.draftText;
        } catch (err) {
          console.warn(`[auto-reply] draft for follow-up ${messageId} failed:`, err);
        }
      }

      await persistPendingDraft(redis, {
        beds24MessageId: messageId,
        bookingId,
        reservationNumber,
        guestMessageText: messageText,
        guestMessageTime: new Date().toISOString(),
        category: detection.category,
        confidence: detection.confidence,
        language: detection.language,
        draftText,
        createdAt: new Date().toISOString(),
      });

      await appendLog(redis, {
        id: makeLogId(),
        beds24MessageId: messageId,
        beds24SentMessageId: null,
        bookingId,
        reservationNumber,
        category: detection.category,
        confidence: detection.confidence,
        language: detection.language,
        action: 'queued-draft',
        sentText: null,
        detail: `category ${detection.category} already auto-replied for this booking — drafted for operator`,
        decidedAt: new Date().toISOString(),
      });
      console.log(
        `[auto-reply] booking ${bookingId} ${detection.category} already auto-replied — drafted follow-up for operator`,
      );
      return;
    }
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
  const built = buildTemplate(detection.category, reservation, parking, detection.parkingIntent);
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

  // ── Step 7: rate-limit counter + per-category lock + task creation ─────────
  let action: AutoReplyLogEntry['action'] = 'sent';
  if (redis) {
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const counterKey = `${RATE_LIMIT_PREFIX}:${bookingId}:${day}`;
    await redis.incr(counterKey);
    await redis.expire(counterKey, 48 * 60 * 60); // 48h auto-cleanup

    // Set the one-shot per-category lock so any follow-up message in this
    // category for this booking goes through the operator approval queue
    // rather than auto-sending again. Keyed per parking sub-intent so each
    // distinct parking question can still auto-reply once.
    await lockCategory(redis, bookingId, detection.category, detection.parkingIntent);

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

  // Apply local-state overrides (parkingOverride + additionalEmail).
  // additionalEmail is needed by autoCompleteInvoiceRequest as a fallback
  // when the chat extraction couldn't pull an email.
  let parkingOverride: string | undefined;
  let additionalEmail = '';
  if (redis) {
    const overrides =
      (await redis.get<Record<string, { parkingOverride?: string; additionalEmail?: string }>>(LOCAL_STATE_KEY)) ?? {};
    const own = overrides[`BH-${bookingId}`];
    parkingOverride = own?.parkingOverride;
    additionalEmail = own?.additionalEmail ?? '';
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
    additionalEmail,
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

// ─── Pending drafts & pending others (operator approval queue) ───────────────

/**
 * A message that the auto-reply pipeline classified into a known category
 * BUT did NOT auto-send — because the per-booking per-category one-shot
 * lock had already fired. The drafter wrote a candidate reply; the
 * operator approves, edits, or dismisses from the unread-messages panel.
 */
export interface PendingDraft {
  beds24MessageId: number;
  bookingId: number;
  reservationNumber: string;
  guestMessageText: string;
  guestMessageTime: string;
  category: AutoReplyCategory;
  /** Parking sub-intent when category==='parking' — surfaced for the operator
   *  and for audit. Undefined for every other category. */
  parkingIntent?: ParkingIntent;
  confidence: number;
  language: string;
  draftText: string;
  /** ISO timestamp when the draft was created (used for stale cleanup). */
  createdAt: string;
}

/**
 * An unread guest message that classified as `other` (or below the
 * confidence threshold). The operator handles these manually — we still
 * draft a candidate reply when possible, but it's optional context for
 * the operator, not a queued auto-send.
 */
export interface PendingOther {
  beds24MessageId: number;
  bookingId: number;
  reservationNumber: string;
  guestMessageText: string;
  guestMessageTime: string;
  /** AI's best-effort draft for the operator to use as a starting point.
   *  Empty string when the drafter declined (e.g. SKIP) or errored. */
  draftText: string;
  confidence: number;
  language: string;
  createdAt: string;
}

// Optional `subKey` namespaces the lock below the category — used to key
// the parking lock per sub-intent so each distinct parking question can
// still auto-reply once.
function categoryLockKey(
  bookingId: number,
  category: AutoReplyCategory,
  subKey?: string,
): string {
  const base = `${CATEGORY_SENT_PREFIX}:${bookingId}:${category}`;
  return subKey ? `${base}:${subKey}` : base;
}

async function isCategoryLocked(
  redis: Redis,
  bookingId: number,
  category: AutoReplyCategory,
  subKey?: string,
): Promise<boolean> {
  const v = await redis.get(categoryLockKey(bookingId, category, subKey));
  return v !== null && v !== undefined;
}

async function lockCategory(
  redis: Redis,
  bookingId: number,
  category: AutoReplyCategory,
  subKey?: string,
): Promise<void> {
  await redis.set(categoryLockKey(bookingId, category, subKey), Date.now(), {
    ex: CATEGORY_LOCK_TTL_SECONDS,
  });
}

async function persistPendingDraft(redis: Redis, entry: PendingDraft): Promise<void> {
  await redis.hset(PENDING_DRAFTS_KEY, {
    [String(entry.beds24MessageId)]: JSON.stringify(entry),
  });
}

async function persistPendingOther(redis: Redis, entry: PendingOther): Promise<void> {
  await redis.hset(PENDING_OTHERS_KEY, {
    [String(entry.beds24MessageId)]: JSON.stringify(entry),
  });
}

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
    // Invoice already auto-completed (or operator-accepted). If the guest
    // is just reassuring / clarifying ("issue it for 1 person", "thanks,
    // looking forward"), AI-draft a short acknowledgement and AUTO-SEND
    // it. The drafter's `invoice-followup` mode is held to a higher bar:
    // any substantive change (cancel, different company, different email,
    // dispute) returns SKIP and falls through to the operator queue.
    const handled = await tryInvoiceFollowUpAutoSend({
      redis,
      bookingId,
      messageId,
      messageText,
      completed,
    });
    return handled;
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

interface InvoiceFollowUpArgs {
  redis: Redis;
  bookingId: number;
  messageId: number;
  messageText: string;
  completed: InvoiceRequest;
}

/**
 * Decide whether to AUTO-SEND an AI-drafted reply to an invoice follow-up
 * message. Returns `true` when handled (auto-sent OR explicitly decided
 * to ignore), `false` to fall through to the regular operator queue.
 *
 * Returns `false` (= fall through) when:
 *   - Message doesn't look invoice-related (low confidence + no keyword
 *     hit) → it's probably about something else, regular pipeline picks
 *     it up.
 *   - Drafter returns SKIP → guest is asking for a substantive change
 *     the operator must handle.
 *   - Reservation context can't be built (cache miss) → operator handles.
 *   - sendBeds24Message throws → log the error, fall through so the
 *     operator at least sees the message in the queue.
 */
async function tryInvoiceFollowUpAutoSend(args: InvoiceFollowUpArgs): Promise<boolean> {
  const { redis, bookingId, messageId, messageText, completed } = args;

  // First: does this message even look invoice-related? Avoid drafting
  // for every random message on a booking that happens to have a
  // completed invoice request.
  const detection = await detectAutoReplyCategory(messageText);
  const looksInvoiceRelated =
    isInvoiceRequest(messageText) ||
    (detection.category === 'invoice-request' && detection.confidence >= 0.8);
  if (!looksInvoiceRelated) {
    return false;
  }

  // Build reservation context for the drafter (guest name + room).
  const reservation = await buildReservationContext(redis, bookingId);
  if (!reservation) {
    return false;
  }

  // Draft a candidate reply. Mode='invoice-followup' tells the drafter
  // to SKIP anything substantive.
  let draft;
  try {
    draft = await draftAutoReply({
      guestMessage: messageText,
      category: 'invoice-request',
      language: detection.language,
      reservation,
      mode: 'invoice-followup',
    });
  } catch (err) {
    console.error(`[invoice follow-up] drafter failed for ${bookingId}:`, err);
    return false;
  }

  const trimmed = (draft.draftText ?? '').trim();
  if (!trimmed || trimmed === 'SKIP') {
    // Substantive change OR no useful draft — operator handles via queue.
    return false;
  }

  // Auto-send with the standard "— Zuzana" sign-off + 10s natural-feel
  // delay so it doesn't feel bot-instantaneous.
  const replyText = `${trimmed}\n\n— Zuzana`;
  await sleep(NATURAL_FEEL_DELAY_MS);

  let sentMessageId: number | null = null;
  try {
    const result = await sendBeds24Message(bookingId, replyText);
    sentMessageId = result.messageId;
  } catch (err) {
    console.error(`[invoice follow-up] auto-send failed for ${bookingId}:`, err);
    // Don't mark as handled — let the operator queue pick it up so the
    // guest still gets a response.
    return false;
  }

  await appendLog(redis, {
    id: makeLogId(),
    beds24MessageId: messageId,
    beds24SentMessageId: sentMessageId,
    bookingId,
    reservationNumber: completed.reservationNumber,
    category: 'invoice-request',
    confidence: detection.confidence,
    language: detection.language,
    action: 'sent',
    sentText: replyText,
    detail: 'invoice follow-up auto-sent via AI drafter',
    decidedAt: new Date().toISOString(),
  });
  console.log(
    `[invoice follow-up] booking ${bookingId} — AI follow-up auto-sent`,
  );
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
    (await redis.get<Record<string, { invoiceData?: InvoiceData; issues?: Issue[]; additionalEmail?: string }>>(LOCAL_STATE_KEY)) ?? {};
  const current = overrides[request.reservationNumber] ?? {};

  // Don't clobber any pre-existing invoiceData the operator may have set
  const existing = current.invoiceData ?? {
    companyName: '',
    companyAddress: '',
    ico: '',
    vatNumber: '',
    billingEmail: '',
  };
  // Fall back to additionalEmail from the reservation when the chat
  // extraction didn't pull an email (e.g. guest provided company/ICO but
  // assumed we already have their email on file). Same OTA-conduit
  // rejection applies so we never write back @guest.booking.com etc.
  const fallbackEmail = sanitizeInvoiceEmail(reservation?.additionalEmail);
  const newInvoiceData: InvoiceData = {
    companyName: existing.companyName || request.companyName || '',
    companyAddress: existing.companyAddress || request.companyAddress || '',
    ico: existing.ico || request.ico || '',
    vatNumber: existing.vatNumber || request.dic || '',
    billingEmail: existing.billingEmail || request.email || fallbackEmail || '',
  };

  // Also backfill the guest's "Guest Email" (additionalEmail) when it's
  // empty. The invoice extraction is often the only time we capture a
  // real (non-OTA-conduit) guest email, so reuse it for the reservation's
  // contact email too — but never clobber an address the operator/guest
  // already provided.
  const existingGuestEmail = (current.additionalEmail ?? reservation?.additionalEmail ?? '').trim();
  const guestEmailBackfill = sanitizeInvoiceEmail(newInvoiceData.billingEmail);
  const additionalEmailPatch =
    !existingGuestEmail && guestEmailBackfill
      ? { additionalEmail: guestEmailBackfill }
      : {};

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
    ...additionalEmailPatch,
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

  // IMPORTANT: must be `await`, not fire-and-forget. Vercel's
  // `after()` only extends function lifetime for promises it can see
  // awaited — an orphaned `void sendTelegram(...)` gets killed mid-flight
  // when the surrounding async function returns, before the fetch to
  // api.telegram.org completes, and silently drops the Telegram (the
  // dedupe lock is already set, so retries skip too). A 1-3s wait here
  // is well under our 60s maxDuration, so the original concern about
  // stretching the function isn't worth the silent-drop risk.
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
