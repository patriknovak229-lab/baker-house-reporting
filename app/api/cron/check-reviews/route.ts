import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { requireRole } from "@/utils/authGuard";
import { getAccessToken } from "@/utils/beds24Auth";
import { fetchReviews, reviewsFromDate, mergeReviews } from "@/utils/beds24Reviews";
import { notifyNewReviews } from "@/utils/reviewAlerts";
import { AIRBNB_REVIEW_ROOM_IDS, REVIEWS_PROPERTY_ID } from "@/utils/rooms";
import type { GuestRating } from "@/types/reservation";

// Beds24 review pagination (Booking.com) + one Airbnb call per physical room can
// take a while — give it Vercel Pro headroom, same as the platform-prices cron.
export const maxDuration = 300;

const REVIEWS_CACHE_KEY = "baker:beds24-reviews-cache";

type ReviewsCache = { fetchedAt: number; byRef: Record<string, GuestRating> };

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/**
 * POST /api/cron/check-reviews
 *
 * Daily safety-net cron. Pulls guest reviews from Beds24 (Booking.com + Airbnb),
 * refreshes the shared reviews cache, then hands off to notifyNewReviews() which
 * diffs against the notified map and sends a Telegram per new/changed review.
 *
 * The dashboard fetch path (getReviews in app/api/bookings) calls the same
 * notifier, so alerts normally fire as soon as a review reaches the app; this
 * cron just guarantees coverage even if nobody opens the dashboard.
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
    roomIds: AIRBNB_REVIEW_ROOM_IDS,
    from: reviewsFromDate(),
  });

  // Empty almost always means a transient fetch failure (an active property has
  // ~90 reviews). Don't clobber the cache or seed off an empty set — bail.
  if (Object.keys(byRef).length === 0) {
    return NextResponse.json({ ok: true, skipped: "no reviews returned" });
  }

  // Refresh the shared cache so the dashboard's lazy getReviews() benefits too.
  // Merge (union by apiReference) so this recent-window fetch never drops older
  // reviews captured by earlier runs. notifyNewReviews still diffs the fresh
  // window, so only genuinely recent reviews trigger alerts.
  const prevCache = await redis.get<ReviewsCache>(REVIEWS_CACHE_KEY);
  const reviewsCache: ReviewsCache = { fetchedAt: Date.now(), byRef: mergeReviews(prevCache?.byRef, byRef) };
  await redis.set(REVIEWS_CACHE_KEY, reviewsCache);

  const result = await notifyNewReviews(redis, byRef);
  return NextResponse.json({ ok: true, ...result });
}
