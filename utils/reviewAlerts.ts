import type { Redis } from "@upstash/redis";
import type { GuestRating } from "@/types/reservation";
import { sendTelegram, escapeHtml } from "@/utils/telegram";
import { mapRoom } from "@/utils/rooms";

// Shared guest-review Telegram alerting, used by BOTH the daily cron
// (app/api/cron/check-reviews) and the dashboard fetch path (getReviews in
// app/api/bookings) so a new review pings the group as soon as it first reaches
// us — not only when the cron happens to run.

const REVIEWS_NOTIFIED_KEY = "baker:telegram:reviews-notified";
const BOOKINGS_CACHE_KEY = "baker:beds24-bookings-cache";
// Short-lived lock so concurrent callers (two dashboard loads, or a load racing
// the cron) can't double-send before the notified map is written. Auto-expires.
const NOTIFY_LOCK_KEY = "baker:telegram:reviews-lock";
const NOTIFY_LOCK_TTL_S = 120;

/** apiReference → score already announced (score stored so a re-review re-fires). */
type NotifiedMap = Record<string, number>;

/** Minimal slice of the cached Beds24 booking we need for the message. */
interface CachedBooking {
  apiReference?: string;
  firstName?: string;
  lastName?: string;
  roomId?: number;
  arrival?: string;
  departure?: string;
}

export type NotifyResult =
  | { skipped: string }
  | { seeded: number; notified: 0 }
  | { fresh: number; notified: number };

function friendlyDate(iso?: string): string | null {
  if (!iso || iso.length < 10) return null;
  const d = new Date(iso.slice(0, 10) + "T12:00:00");
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const MAX_REVIEW_TEXT = 320;

function buildMessage(ref: string, rating: GuestRating, booking?: CachedBooking): string {
  const channelLabel = String(rating.channel ?? rating.source);
  const scoreLine = `⭐ <b>New guest review — ${rating.score}/${rating.scale}</b> (${escapeHtml(channelLabel)})`;

  const lines: string[] = [scoreLine];

  const guest = booking
    ? `${booking.firstName ?? ""} ${booking.lastName ?? ""}`.trim()
    : "";
  const room = booking?.roomId != null ? mapRoom(booking.roomId) : "";
  if (guest || room) {
    lines.push(escapeHtml([guest, room].filter(Boolean).join(" · ")));
  }

  const arr = friendlyDate(booking?.arrival);
  const dep = friendlyDate(booking?.departure);
  if (arr && dep) lines.push(`Stay: ${arr} → ${dep}`);

  if (!booking) lines.push(`Ref: ${escapeHtml(ref)} <i>(no matching reservation in cache)</i>`);

  if (rating.reviewText) {
    let text = rating.reviewText.trim();
    if (text.length > MAX_REVIEW_TEXT) text = text.slice(0, MAX_REVIEW_TEXT).trimEnd() + "…";
    lines.push(`\n“${escapeHtml(text)}”`);
  }

  return lines.join("\n");
}

/**
 * Diff a freshly-fetched review map against the notified map and send a Telegram
 * for each NEW or score-changed review, with the reservation details attached.
 *
 * - Dedupe map `baker:telegram:reviews-notified` (apiReference → score; a changed
 *   score re-fires). A ref is marked notified only after its send succeeds so
 *   failures retry on the next call.
 * - First run ever seeds the map SILENTLY so the existing backlog isn't blasted.
 * - A short Redis lock serializes callers so the cron and dashboard loads can't
 *   double-send the same review.
 *
 * Pass the FRESH fetch (the recent rolling window), not the merged cache, so only
 * genuinely recent reviews are considered.
 */
export async function notifyNewReviews(
  redis: Redis,
  byRef: Record<string, GuestRating>,
): Promise<NotifyResult> {
  // Empty almost always means a transient fetch failure — never seed/alert off it.
  if (Object.keys(byRef).length === 0) return { skipped: "no reviews" };

  const gotLock = await redis.set(NOTIFY_LOCK_KEY, Date.now(), {
    nx: true,
    ex: NOTIFY_LOCK_TTL_S,
  });
  if (!gotLock) return { skipped: "locked" };

  try {
    const notified = await redis.get<NotifiedMap>(REVIEWS_NOTIFIED_KEY);

    // First run ever: seed silently so we don't announce the whole backlog.
    if (notified == null) {
      const seed: NotifiedMap = {};
      for (const [ref, r] of Object.entries(byRef)) seed[ref] = r.score;
      await redis.set(REVIEWS_NOTIFIED_KEY, seed);
      return { seeded: Object.keys(seed).length, notified: 0 };
    }

    // New or score-changed reviews.
    const fresh: { ref: string; rating: GuestRating }[] = [];
    for (const [ref, r] of Object.entries(byRef)) {
      if (notified[ref] === undefined || notified[ref] !== r.score) {
        fresh.push({ ref, rating: r });
      }
    }
    if (fresh.length === 0) return { fresh: 0, notified: 0 };

    // Resolve reservation details from the bookings cache (keyed by apiReference).
    const bookings = (await redis.get<CachedBooking[]>(BOOKINGS_CACHE_KEY)) ?? [];
    const byApiRef = new Map<string, CachedBooking>();
    for (const b of bookings) {
      if (b.apiReference) byApiRef.set(String(b.apiReference), b);
    }

    const nextNotified: NotifiedMap = { ...notified };
    let sent = 0;
    for (const { ref, rating } of fresh) {
      const ok = await sendTelegram(buildMessage(ref, rating, byApiRef.get(ref)));
      if (ok) {
        nextNotified[ref] = rating.score; // only mark once delivered → failures retry
        sent += 1;
      }
    }
    await redis.set(REVIEWS_NOTIFIED_KEY, nextNotified);
    return { fresh: fresh.length, notified: sent };
  } finally {
    await redis.del(NOTIFY_LOCK_KEY);
  }
}
