import type { GuestRating } from "@/types/reservation";

// Pulls guest reviews from Beds24's channel review endpoints and reduces them to
// a per-booking GuestRating, keyed by the booking's channel reference
// (Beds24 `apiReference`) — NOT the Beds24 booking id. Beds24 V2 exposes:
//   • GET /channels/booking/reviews?propertyId&from — Booking.com (Alpha, /10)
//   • GET /channels/airbnb/reviews?roomId           — Airbnb (Beta, /5)
// There is no Google reviews endpoint — Google ratings are manual-only.
//
// Schema + matching were confirmed against the live API (2026-06):
//   - Booking.com: review.reservation_id  === beds24 booking.apiReference
//                  score at scoring.review_score (out of 10)
//   - Airbnb:      review.reservation_confirmation_code === booking.apiReference
//                  score at overall_rating (out of 5); reviewer_role === "guest"
// Both endpoints page at 100 results via pages.nextPageLink.

const BEDS24_API_BASE = "https://beds24.com/api/v2";

export interface ReviewFetchOptions {
  propertyId: number;
  roomIds: number[];
  /** Booking.com `from` date (YYYY-MM-DD) — required by that endpoint. */
  from: string;
}

type Beds24Page = {
  data?: unknown[];
  pages?: { nextPageExists?: boolean; nextPageLink?: string | null };
};

/** Follow Beds24 pagination (pages.nextPageLink) and concatenate every page's data. */
async function fetchAllPages(url: string, token: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let next: string | null = url;
  for (let guard = 0; next && guard < 50; guard += 1) {
    const res: Response = await fetch(next, { headers: { token }, cache: "no-store" });
    if (!res.ok) break; // beta/disabled/not-permitted — keep whatever we have
    const json = (await res.json()) as Beds24Page;
    if (Array.isArray(json.data)) out.push(...(json.data as Record<string, unknown>[]));
    next = json.pages?.nextPageExists ? json.pages?.nextPageLink ?? null : null;
  }
  return out;
}

function dateOnly(v: unknown): string | undefined {
  return typeof v === "string" && v.length >= 10 ? v.slice(0, 10) : undefined;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Fetch + parse reviews from both channels into a map keyed by `apiReference`.
 * Each channel is fetched independently so a failing/disabled endpoint (Airbnb
 * is beta) never breaks the other or the wider bookings sync.
 */
export async function fetchReviews(
  token: string,
  opts: ReviewFetchOptions,
): Promise<Record<string, GuestRating>> {
  const byRef: Record<string, GuestRating> = {};

  // ── Booking.com (one call, paginated) ──
  try {
    const url = `${BEDS24_API_BASE}/channels/booking/reviews?propertyId=${opts.propertyId}&from=${opts.from}`;
    for (const r of await fetchAllPages(url, token)) {
      const ref = r.reservation_id != null ? String(r.reservation_id) : null;
      const scoring = (r.scoring ?? {}) as Record<string, unknown>;
      const score = num(scoring.review_score);
      if (!ref || score === null) continue;
      const content = (r.content ?? {}) as Record<string, unknown>;
      const text =
        (typeof content.positive === "string" && content.positive) ||
        (typeof content.headline === "string" && content.headline) ||
        undefined;
      byRef[ref] = {
        score,
        scale: 10,
        source: "booking",
        channel: "Booking.com",
        reviewText: text || undefined,
        reviewDate: dateOnly(r.created_timestamp),
      };
    }
  } catch {
    /* ignore — keep whatever else succeeded */
  }

  // ── Airbnb (one call per room, paginated) ──
  try {
    await Promise.all(
      opts.roomIds.map(async (roomId) => {
        const url = `${BEDS24_API_BASE}/channels/airbnb/reviews?roomId=${roomId}`;
        for (const r of await fetchAllPages(url, token)) {
          if (r.reviewer_role && r.reviewer_role !== "guest") continue; // only guest→host reviews
          const ref =
            r.reservation_confirmation_code != null
              ? String(r.reservation_confirmation_code)
              : null;
          const score = num(r.overall_rating);
          if (!ref || score === null) continue;
          byRef[ref] = {
            score,
            scale: 5,
            source: "airbnb",
            channel: "Airbnb",
            reviewText: typeof r.public_review === "string" ? r.public_review : undefined,
            reviewDate: dateOnly(r.submitted_at ?? r.first_completed_at),
          };
        }
      }),
    );
  } catch {
    /* ignore */
  }

  return byRef;
}

/** Raw, unparsed payloads from both endpoints — used by ?rawReviews=true for debugging. */
export async function fetchRawReviews(
  token: string,
  opts: ReviewFetchOptions,
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  const call = async (path: string) => {
    try {
      const res = await fetch(`${BEDS24_API_BASE}${path}`, { headers: { token }, cache: "no-store" });
      const body = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body };
    } catch (err) {
      return { ok: false, body: err instanceof Error ? err.message : String(err) };
    }
  };

  out.booking = await call(`/channels/booking/reviews?propertyId=${opts.propertyId}&from=${opts.from}`);
  out.airbnb = {};
  for (const roomId of opts.roomIds) {
    (out.airbnb as Record<string, unknown>)[roomId] = await call(
      `/channels/airbnb/reviews?roomId=${roomId}`,
    );
  }
  return out;
}
