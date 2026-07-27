import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { requireRole } from "@/utils/authGuard";
import { getAccessToken } from "@/utils/beds24Auth";
import { fetchReviews, reviewsFromDate, mergeReviews } from "@/utils/beds24Reviews";
import { sendTelegram, escapeHtml } from "@/utils/telegram";
import { mapRoom, PHYSICAL_ROOM_IDS, REVIEWS_PROPERTY_ID } from "@/utils/rooms";
import type { GuestRating } from "@/types/reservation";

// Beds24 review pagination (Booking.com) + one Airbnb call per physical room can
// take a while — give it Vercel Pro headroom, same as the platform-prices cron.
export const maxDuration = 300;

const REVIEWS_CACHE_KEY = "baker:beds24-reviews-cache";
const REVIEWS_NOTIFIED_KEY = "baker:telegram:reviews-notified";
const BOOKINGS_CACHE_KEY = "baker:beds24-bookings-cache";

type ReviewsCache = { fetchedAt: number; byRef: Record<string, GuestRating> };
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

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

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
 * POST /api/cron/check-reviews
 *
 * Daily cron. Pulls guest reviews from Beds24 in the background (Booking.com +
 * Airbnb), diffs against what we've already announced, and sends a Telegram for
 * each NEW or score-changed review with the reservation details attached.
 *
 * - Fires once per review (dedupe map `baker:telegram:reviews-notified`,
 *   keyed apiReference → score; a changed score re-fires).
 * - First run seeds the map SILENTLY so the existing review backlog isn't blasted.
 * - Refreshes the shared reviews cache so the dashboard benefits from this pull.
 * - A ref is only marked notified once its Telegram send succeeds → failures retry.
 *
 * Auth: Vercel cron requests carry "x-vercel-cron: 1"; manual triggers need admin/super.
 */
export async function POST(req: NextRequest) {
  const isCron = req.headers.get("x-vercel-cron") === "1";
  if (!isCron) {
    const authResult = await requireRole(["admin", "super"]);
    if ("error" in authResult) return authResult.error;
  }

  const redis = getRedis();
  const token = await getAccessToken();

  const byRef = await fetchReviews(token, {
    propertyId: REVIEWS_PROPERTY_ID,
    roomIds: PHYSICAL_ROOM_IDS,
    from: reviewsFromDate(),
  });

  // Empty almost always means a transient fetch failure (an active property has
  // ~90 reviews). Don't clobber the cache or seed off an empty set — bail.
  if (Object.keys(byRef).length === 0) {
    return NextResponse.json({ ok: true, skipped: "no reviews returned" });
  }

  // Refresh the shared cache so the dashboard's lazy getReviews() benefits too.
  // Merge (union by apiReference) so this recent-window fetch never drops older
  // reviews captured by earlier runs. The new/changed diff below still runs
  // against the fresh window, so only genuinely recent reviews trigger alerts.
  const prevCache = await redis.get<ReviewsCache>(REVIEWS_CACHE_KEY);
  const reviewsCache: ReviewsCache = { fetchedAt: Date.now(), byRef: mergeReviews(prevCache?.byRef, byRef) };
  await redis.set(REVIEWS_CACHE_KEY, reviewsCache);

  const notified = await redis.get<NotifiedMap>(REVIEWS_NOTIFIED_KEY);

  // First run ever: seed silently so we don't announce the whole backlog.
  if (notified == null) {
    const seed: NotifiedMap = {};
    for (const [ref, r] of Object.entries(byRef)) seed[ref] = r.score;
    await redis.set(REVIEWS_NOTIFIED_KEY, seed);
    return NextResponse.json({ ok: true, seeded: Object.keys(seed).length, notified: 0 });
  }

  // New or score-changed reviews.
  const fresh: { ref: string; rating: GuestRating }[] = [];
  for (const [ref, r] of Object.entries(byRef)) {
    if (notified[ref] === undefined || notified[ref] !== r.score) {
      fresh.push({ ref, rating: r });
    }
  }
  if (fresh.length === 0) {
    return NextResponse.json({ ok: true, checked: Object.keys(byRef).length, notified: 0 });
  }

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
      nextNotified[ref] = rating.score; // only mark once delivered → failures retry next run
      sent += 1;
    }
  }
  await redis.set(REVIEWS_NOTIFIED_KEY, nextNotified);

  return NextResponse.json({ ok: true, fresh: fresh.length, notified: sent });
}
