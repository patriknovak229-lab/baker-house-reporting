/**
 * Side effects for the post-booking contact question (see utils/guestContact):
 *
 *   tryCaptureContactReply — realtime, from the Beds24 message webhook: a guest
 *     answers our question → save phone / car / plate, write the phone into the
 *     Beds24 booking, and thank them. Messages with anything else in them still
 *     go on to the normal reply pipeline (the data is saved either way).
 *   runContactPass — every ~15 min from the same webhook poll (Vercel crons here
 *     run once a day, so the invoice reminders live there too): catch replies
 *     the realtime path missed, send the ONE follow-up when an answer is still
 *     missing, Telegram the ops group when a guest arrives today/tomorrow with
 *     no phone, and copy phones typed into the drawer into Beds24.
 *
 * Bookkeeping (captured / reminded / alerted / synced) lives in short-lived
 * Redis keys, NOT in reservation overrides: the drawer re-posts a reservation's
 * whole override object, so a stale tab could wipe a "reminded" marker and
 * cause a second reminder. Only the guest's actual answers go into overrides.
 */

import type { Redis } from '@upstash/redis';
import type { ParkingUse } from '@/types/reservation';
import { getAccessToken } from '@/utils/beds24Auth';
import { sendBeds24Message } from '@/utils/beds24Messages';
import {
  fetchRecentConversation,
  fetchRecentMessagesByBooking,
  type ConversationMessage,
} from '@/utils/beds24Conversation';
import { mapRoom } from '@/utils/beds24Reservations';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { readAllAutoReplyLog, writeAllAutoReplyLog } from '@/utils/autoReplyLogStore';
import { markAutoSent } from '@/utils/operatorActivity';
import { escapeHtml, sendTelegram } from '@/utils/telegram';
import { toE164 } from '@/utils/phone';
import { extractGuestContact, type ExtractedContact } from '@/utils/guestContactExtractor';
import {
  contactLang,
  contactNeeds,
  findContactAsk,
  guestRepliesAfter,
  isGuestMessagingHour,
  noPhoneAlertDue,
  normalizePlate,
  pragueDate,
  pragueTime,
  reminderDueAt,
  renderReminder,
  renderThanks,
} from '@/utils/guestContact';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';
const BOOKINGS_CACHE_KEY = 'baker:beds24-bookings-cache';

const PASS_LOCK_KEY = 'baker:contact-req:pass';
const PASS_INTERVAL_SECONDS = 15 * 60;
const capturedKey = (messageId: number) => `baker:contact-req:captured:${messageId}`;
const remindedKey = (bookingId: number) => `baker:contact-req:reminded:${bookingId}`;
const noPhoneKey = (bookingId: number) => `baker:contact-req:no-phone:${bookingId}`;
const phoneSyncedKey = (bookingId: number) => `baker:contact-req:phone-synced:${bookingId}`;
const noAskKey = (bookingId: number) => `baker:contact-req:no-ask:${bookingId}`;
const DAY_S = 24 * 60 * 60;

/** Bookings made before this can't have had the question (the auto actions went live 2026-10-23;
 *  a one-off catch-up run may reach a few weeks back). */
const ASKED_BOOKINGS_FROM = '2026-09-20T00:00:00Z';
/** The realtime path gets first go at a fresh reply (it can also say thanks). */
const BACKLOG_MIN_AGE_MS = 30 * 60 * 1000;

// Per-pass caps — keep a pass well inside the webhook's 60 s budget.
const MAX_EXTRACTIONS = 3;
const MAX_REMINDERS = 5;
const MAX_THREAD_FETCHES = 5;
const MAX_PHONE_SYNCS = 5;
const PASS_TIME_BUDGET_MS = 40_000;

/** The raw Beds24 booking as cached by utils/beds24Reservations. */
interface CachedBooking {
  id: number;
  masterId?: number | null;
  roomId?: number;
  status?: string;
  apiSource?: string;
  arrival?: string;
  departure?: string;
  bookingTime?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  mobile?: string;
  lang?: string;
  country?: string | null;
  country2?: string | null;
}

interface OverrideFields {
  phone?: string;
  parkingUse?: ParkingUse | null;
  parkingOverride?: string;
  [key: string]: unknown;
}

/**
 * Production only. Local dev and preview deployments share the production
 * Redis + overrides but have no Beds24 token, so a pass there would claim the
 * "reminded" / "alerted" markers, fail to send, and suppress the real thing.
 */
function automationEnabled(): boolean {
  return process.env.VERCEL_ENV === 'production';
}

function isMaster(b: CachedBooking): boolean {
  return b.masterId == null || b.masterId === b.id;
}

function isLive(b: CachedBooking, today: string): boolean {
  const s = (b.status ?? '').toLowerCase();
  if (s === 'cancelled' || s === 'canceled' || s === 'black') return false;
  return Boolean(b.arrival && b.departure && b.departure > today);
}

function needsFor(b: CachedBooking, own: OverrideFields | undefined) {
  return contactNeeds({
    beds24Phone: b.phone ?? '',
    beds24Mobile: b.mobile ?? '',
    overridePhone: own?.phone,
    parkingUse: own?.parkingUse,
    parkingOverride: own?.parkingOverride,
  });
}

async function loadBookings(redis: Redis): Promise<Record<string, CachedBooking>> {
  return (await redis.get<Record<string, CachedBooking>>(BOOKINGS_CACHE_KEY)) ?? {};
}

/**
 * Read bookings straight from Beds24. The Redis cache only refreshes when
 * someone loads the dashboard, but guests often answer within a minute of
 * booking (BH-95199521 replied after 44 s) — before the booking is cached.
 * Read-only; returns [] on any failure.
 */
async function fetchBookingsFromBeds24(ids: number[]): Promise<CachedBooking[]> {
  if (ids.length === 0) return [];
  try {
    const token = await getAccessToken();
    const params = new URLSearchParams();
    for (const id of ids.slice(0, 20)) params.append('id', String(id));
    for (const st of ['confirmed', 'new', 'request']) params.append('status', st);
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: 'no-store' });
    if (!res.ok) {
      console.error(`[guest-contact] Beds24 booking read ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const json: unknown = await res.json();
    const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : [];
    return (rows as CachedBooking[]).filter((b) => b && Number.isFinite(Number(b.id)));
  } catch (err) {
    console.error('[guest-contact] Beds24 booking read failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Bookings that got our question in the last few days but aren't in the cache yet. */
export function uncachedAskedBookingIds(
  recent: Map<number, ConversationMessage[]>,
  cached: Record<string, unknown>,
): number[] {
  const ids: number[] = [];
  for (const [bookingId, thread] of recent) {
    if (cached[String(bookingId)]) continue;
    if (findContactAsk(thread)) ids.push(bookingId);
  }
  return ids;
}

// ─── Saving ───────────────────────────────────────────────────────────────────

interface Saved {
  phone?: string;
  parking?: ParkingUse;
}

/**
 * Turn an extraction into what we'd store, given what's still missing. A guest
 * may update their own earlier car answer; an operator-set one always wins, and
 * a phone already on file is never overwritten.
 */
export function planSave(
  extracted: ExtractedContact,
  needs: { phone: boolean; parking: boolean },
  existingParking: ParkingUse | null | undefined,
  now: Date,
): Saved {
  const out: Saved = {};
  if (needs.phone && extracted.phone) {
    const e164 = toE164(extracted.phone);
    if (e164) out.phone = e164;
  }
  const plate = normalizePlate(extracted.plate);
  const car = extracted.car ?? (plate ? 'yes' : null);
  const mayWriteParking = needs.parking || existingParking?.source === 'guest';
  if (car && mayWriteParking) {
    out.parking = {
      status: car === 'yes' ? 'car' : 'no-car',
      ...(car === 'yes' && plate ? { plate } : {}),
      source: 'guest',
      updatedAt: now.toISOString(),
    };
  }
  return out;
}

/** Read-modify-write one reservation's overrides, re-checking against the fresh copy. */
async function saveToOverrides(reservationNumber: string, plan: Saved): Promise<Saved> {
  if (!plan.phone && !plan.parking) return {};
  const map = await readAllReservationOverrides<OverrideFields>();
  const cur: OverrideFields = { ...(map[reservationNumber] ?? {}) };
  const applied: Saved = {};
  if (plan.phone && !cur.phone?.trim()) {
    cur.phone = plan.phone;
    applied.phone = plan.phone;
  }
  if (plan.parking && (!cur.parkingUse || cur.parkingUse.source === 'guest')) {
    cur.parkingUse = plan.parking;
    applied.parking = plan.parking;
  }
  if (!applied.phone && !applied.parking) return {};
  map[reservationNumber] = cur;
  await writeAllReservationOverrides(map);
  return applied;
}

/**
 * Write the guest's phone into the Beds24 booking so Beds24's own SMS auto
 * actions can reach them. Fills `mobile` too when it's empty (Booking.com
 * bookings arrive with both blank). Throws on failure.
 */
export async function writeBeds24Phone(
  bookingId: number,
  phone: string,
  opts: { alsoMobile: boolean; token?: string },
): Promise<void> {
  const token = opts.token ?? (await getAccessToken());
  const row: Record<string, unknown> = { id: bookingId, phone };
  if (opts.alsoMobile) row.mobile = phone;
  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify([row]),
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${text.slice(0, 200)}`);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON 2xx — treat as success */
  }
  const rows = Array.isArray(json) ? json : Array.isArray((json as { data?: unknown })?.data) ? (json as { data: unknown[] }).data : [];
  const failed = (rows as Array<{ success?: boolean }>).find((r) => r && r.success === false);
  if (failed) throw new Error(`Beds24 rejected the phone update: ${JSON.stringify(failed).slice(0, 200)}`);
}

async function pushPhoneToBeds24(redis: Redis, b: CachedBooking, phone: string): Promise<void> {
  try {
    await writeBeds24Phone(b.id, phone, { alsoMobile: !b.mobile?.trim() });
    await redis.set(phoneSyncedKey(b.id), phone, { ex: DAY_S });
  } catch (err) {
    console.error(`[guest-contact] Beds24 phone write failed for ${b.id}:`, err instanceof Error ? err.message : err);
    // Back off for a few hours rather than retrying every pass.
    await redis.set(phoneSyncedKey(b.id), 'failed', { ex: 6 * 60 * 60 }).catch(() => {});
  }
}

/** Extract → save → Beds24. Returns what was actually stored + the extraction. */
async function captureReply(
  redis: Redis,
  b: CachedBooking,
  own: OverrideFields | undefined,
  messageText: string,
  now: Date,
): Promise<{ applied: Saved; extracted: ExtractedContact }> {
  const needs = needsFor(b, own);
  const extracted = await extractGuestContact({
    message: messageText,
    askedPhone: needs.phone,
    guestCountry: (b.country2 || b.country || '').toUpperCase() || undefined,
  });
  const plan = planSave(extracted, needs, own?.parkingUse, now);
  const applied = await saveToOverrides(`BH-${b.id}`, plan);
  if (applied.phone) await pushPhoneToBeds24(redis, b, applied.phone);
  if (applied.phone || applied.parking) {
    console.log(
      `[guest-contact] BH-${b.id}: saved${applied.phone ? ' phone' : ''}${applied.parking ? ` parking=${applied.parking.status}` : ''}`,
    );
  }
  return { applied, extracted };
}

// ─── Audit log (same store + shape as the auto-reply pipeline) ────────────────

async function logSent(args: {
  bookingId: number;
  guestMessageId: number;
  sentMessageId: number | null;
  language: string;
  text: string | null;
  guestMessage?: string;
  action: 'sent' | 'errored';
  detail: string;
}): Promise<void> {
  try {
    const existing = await readAllAutoReplyLog<{ id: string }>();
    const entry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      beds24MessageId: args.guestMessageId,
      beds24SentMessageId: args.sentMessageId,
      bookingId: args.bookingId,
      reservationNumber: `BH-${args.bookingId}`,
      category: 'contact-details',
      confidence: 1,
      language: args.language,
      action: args.action,
      sentText: args.text,
      ...(args.guestMessage ? { guestMessage: args.guestMessage } : {}),
      detail: args.detail,
      decidedAt: new Date().toISOString(),
    };
    await writeAllAutoReplyLog([...existing, entry].slice(-500));
  } catch (err) {
    console.warn('[guest-contact] audit log write failed:', err instanceof Error ? err.message : err);
  }
}

async function sendAuto(redis: Redis, bookingId: number, text: string) {
  const result = await sendBeds24Message(bookingId, text);
  await markAutoSent(redis, result.messageId);
  return result;
}

// ─── Realtime: a guest message just arrived ───────────────────────────────────

/**
 * Returns true when the message was ONLY an answer to our question and we've
 * thanked the guest — the caller then skips the rest of the reply pipeline.
 * Returns false otherwise (not an answer, nothing usable, or more in the
 * message than the answer) — any answers found are saved regardless.
 */
export async function tryCaptureContactReply(args: {
  redis: Redis | null;
  bookingId: number;
  messageId: number;
  messageText: string;
  /** Detected language of the message (ISO 639-1), for the thank-you. */
  language: string;
  urgent: boolean;
}): Promise<boolean> {
  const { redis, bookingId, messageId, messageText } = args;
  if (!redis || !automationEnabled()) return false;
  const now = new Date();

  const bookings = await loadBookings(redis);
  // A reply right after booking usually beats the cache refresh — read it live.
  const b = bookings[String(bookingId)] ?? (await fetchBookingsFromBeds24([bookingId]))[0];
  if (!b || !isLive(b, pragueDate(now))) return false;
  const overrides = await readAllReservationOverrides<OverrideFields>();
  const own = overrides[`BH-${bookingId}`];
  const needs = needsFor(b, own);
  if (!needs.phone && !needs.parking) return false;

  const thread = await fetchRecentConversation(bookingId, 30);
  const askedAt = findContactAsk(thread);
  if (!askedAt) return false;
  const msgTime = thread.find((m) => m.id === messageId)?.time ?? now.toISOString();
  if (Date.parse(msgTime) <= Date.parse(askedAt)) return false;

  const claimed = await redis.set(capturedKey(messageId), '1', { nx: true, ex: 60 * DAY_S });
  if (!claimed) return false;

  const { applied, extracted } = await captureReply(redis, b, own, messageText, now);
  if (!applied.phone && !applied.parking) return false;
  if (args.urgent || !extracted.onlyContactInfo) return false;

  const lang = contactLang(args.language || b.lang);
  const text = renderThanks({ lang, phone: applied.phone, parking: applied.parking });
  if (!text) return false;
  try {
    const result = await sendAuto(redis, bookingId, text);
    await logSent({
      bookingId,
      guestMessageId: messageId,
      sentMessageId: result.messageId,
      language: lang,
      text,
      guestMessage: messageText,
      action: 'sent',
      detail: 'contact details saved from the reply — thank-you sent',
    });
    return true;
  } catch (err) {
    console.error(`[guest-contact] thank-you send failed for ${bookingId}:`, err);
    await logSent({
      bookingId,
      guestMessageId: messageId,
      sentMessageId: null,
      language: lang,
      text: null,
      guestMessage: messageText,
      action: 'errored',
      detail: `contact details saved; thank-you failed (${err instanceof Error ? err.message : String(err)}) — queued for operator`,
    });
    return false;
  }
}

// ─── Background pass ──────────────────────────────────────────────────────────

/** Runs at most once per 15 min (Redis lock); safe to call on every webhook poll. */
export async function runContactPass(redis: Redis | null, now = new Date()): Promise<void> {
  if (!redis || !automationEnabled()) return;
  const got = await redis.set(PASS_LOCK_KEY, now.toISOString(), { nx: true, ex: PASS_INTERVAL_SECONDS });
  if (!got) return;
  const started = Date.now();
  const overBudget = () => Date.now() - started > PASS_TIME_BUDGET_MS;

  const today = pragueDate(now);
  const cached = await loadBookings(redis);
  const recent = await fetchRecentMessagesByBooking(7);
  // New bookings that already got our question may not be cached yet (the cache
  // only refreshes when the dashboard loads) — read those from Beds24 directly.
  const fresh = await fetchBookingsFromBeds24(uncachedAskedBookingIds(recent, cached));
  const bookings = [...Object.values(cached), ...fresh].filter((b) => isMaster(b) && isLive(b, today));
  let overrides = await readAllReservationOverrides<OverrideFields>();

  let extractions = 0;
  let reminders = 0;
  let threadFetches = 0;
  let phoneSyncs = 0;
  const noPhone: CachedBooking[] = [];

  // Copy a phone typed into the drawer (or captured earlier) into Beds24.
  for (const b of bookings) {
    if (phoneSyncs >= MAX_PHONE_SYNCS) break;
    const own = overrides[`BH-${b.id}`];
    if (!own?.phone?.trim() || b.phone?.trim() || b.mobile?.trim()) continue;
    if (await redis.get(phoneSyncedKey(b.id))) continue;
    phoneSyncs++;
    await pushPhoneToBeds24(redis, b, toE164(own.phone) ?? own.phone.trim());
  }

  const needy = bookings.filter((b) => {
    const n = needsFor(b, overrides[`BH-${b.id}`]);
    return n.phone || n.parking;
  });

  for (const b of needy) {
    if (overBudget()) break;
    let own = overrides[`BH-${b.id}`];
    let needs = needsFor(b, own);

    // Find our question. The bulk read covers the last 7 days; an older booking
    // whose reminder is due gets its own thread read.
    let thread: ConversationMessage[] = recent.get(b.id) ?? [];
    let askedAt = findContactAsk(thread);
    const askable = (b.apiSource === 'Booking.com' || b.apiSource === 'Airbnb') && (b.bookingTime ?? '') >= ASKED_BOOKINGS_FROM;
    if (!askedAt && askable && b.bookingTime && b.arrival && threadFetches < MAX_THREAD_FETCHES) {
      const provisional = reminderDueAt({ bookingTime: b.bookingTime, arrival: b.arrival, askedAt: b.bookingTime });
      if (provisional && provisional <= now && !(await redis.get(remindedKey(b.id))) && !(await redis.get(noAskKey(b.id)))) {
        threadFetches++;
        thread = await fetchRecentConversation(b.id, 50);
        askedAt = findContactAsk(thread);
        if (!askedAt) await redis.set(noAskKey(b.id), '1', { ex: DAY_S });
      }
    }

    if (askedAt) {
      // Replies the realtime path didn't handle (sent before this feature
      // shipped, or a webhook that never fired). Saved silently — no thank-you.
      const replies = guestRepliesAfter(thread, askedAt);
      for (const r of replies) {
        if (extractions >= MAX_EXTRACTIONS || overBudget()) break;
        if (r.id == null || now.getTime() - Date.parse(r.time) < BACKLOG_MIN_AGE_MS) continue;
        const claimed = await redis.set(capturedKey(r.id), '1', { nx: true, ex: 60 * DAY_S });
        if (!claimed) continue;
        extractions++;
        const { applied } = await captureReply(redis, b, own, r.text, now);
        if (applied.phone || applied.parking) {
          overrides = await readAllReservationOverrides<OverrideFields>();
          own = overrides[`BH-${b.id}`];
          needs = needsFor(b, own);
        }
      }

      // The one follow-up. The car question is only repeated if the guest hasn't
      // written back at all — a reply that skipped it isn't worth nagging about.
      const askPhone = needs.phone;
      const askCar = needs.parking && replies.length === 0;
      const due = b.bookingTime && b.arrival ? reminderDueAt({ bookingTime: b.bookingTime, arrival: b.arrival, askedAt }) : null;
      if (
        (askPhone || askCar) &&
        due &&
        due <= now &&
        reminders < MAX_REMINDERS &&
        isGuestMessagingHour(now) &&
        now < pragueTime(b.arrival!, 15)
      ) {
        // Claim BEFORE sending: a failed send is never retried, so a bug can't spam a guest.
        const claimed = await redis.set(remindedKey(b.id), now.toISOString(), { nx: true, ex: 120 * DAY_S });
        if (claimed) {
          reminders++;
          const lang = contactLang(b.lang);
          const text = renderReminder({ lang, firstName: b.firstName ?? '', askPhone, askCar });
          if (text) {
            try {
              const result = await sendAuto(redis, b.id, text);
              await logSent({
                bookingId: b.id,
                guestMessageId: 0,
                sentMessageId: result.messageId,
                language: lang,
                text,
                action: 'sent',
                detail: `contact reminder — asked for ${[askPhone && 'phone', askCar && 'car'].filter(Boolean).join(' + ')}`,
              });
            } catch (err) {
              console.error(`[guest-contact] reminder send failed for ${b.id}:`, err);
              await logSent({
                bookingId: b.id,
                guestMessageId: 0,
                sentMessageId: null,
                language: lang,
                text: null,
                action: 'errored',
                detail: `contact reminder failed (${err instanceof Error ? err.message : String(err)}) — not retried`,
              });
            }
          }
        }
      }
    }

    if (needs.phone && b.arrival && b.departure && noPhoneAlertDue({ arrival: b.arrival, departure: b.departure, askedAt, now })) {
      const claimed = await redis.set(noPhoneKey(b.id), now.toISOString(), { nx: true, ex: 14 * DAY_S });
      if (claimed) noPhone.push(b);
    }
  }

  if (noPhone.length > 0) {
    const lines = noPhone
      .sort((a, z) => (a.arrival ?? '').localeCompare(z.arrival ?? ''))
      .map((b) => {
        const name = escapeHtml([b.firstName, b.lastName].filter(Boolean).join(' ') || `#${b.id}`);
        const when = b.arrival === today ? 'today' : 'tomorrow';
        return `• ${name} · ${escapeHtml(mapRoom(Number(b.roomId)))} · arrives ${when} · ${escapeHtml(b.apiSource || 'Direct')} · BH-${b.id}`;
      });
    await sendTelegram(
      [
        `📵 <b>No guest phone — arriving soon</b>`,
        ...lines,
        '',
        'Booking.com: extranet → reservation → "Show phone number", then paste it into the drawer (Phone ✏️). It reaches Beds24 within 15 min.',
      ].join('\n'),
    );
  }

  console.log(
    `[guest-contact] pass: ${bookings.length} live (${fresh.length} read from Beds24), ${extractions} extracted, ${reminders} reminders, ${noPhone.length} no-phone alerts, ${phoneSyncs} phone syncs, ${threadFetches} thread reads`,
  );
}
