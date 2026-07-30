import { NextRequest, NextResponse } from "next/server";
import type { Reservation, RateType } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import { detectRateType, isRateTypeInScope } from "@/utils/rateType";
import { autoRatePerks, effectiveRatePerks } from "@/utils/ratePerks";
import type { PerkOverrides, RatePerks } from "@/utils/ratePerks";
import { fetchReviews, fetchRawReviews, reviewsFromDate, mergeReviews, type ReviewFetchOptions } from "@/utils/beds24Reviews";
import { notifyNewReviews } from "@/utils/reviewAlerts";
import type { GuestRating } from "@/types/reservation";
import { getRedis, fetchAllBookings, mergeGroupedBookings, mapToReservation, attachNonArrivalOverlay, mapChannel, mapRoom, infoItemsText, BEDS24_API_BASE, RESERVATION_OVERRIDES_KEY, APP_PHONE_MARKER, type Beds24Booking } from "@/utils/beds24Reservations";

const ADDITIONAL_PAYMENTS_KEY = "baker:additional-payments";

// Synced guest reviews (Booking.com / Airbnb) cache, keyed by booking channel
// reference (apiReference). This window also gates how promptly a new review can
// alert Telegram: getReviews() only re-fetches (and thus runs notifyNewReviews)
// once it expires, so keep it short enough that new reviews surface quickly.
const REVIEWS_CACHE_KEY = "baker:beds24-reviews-cache";
const REVIEWS_CACHE_MAX_AGE_MS = 30 * 60 * 1000; // 30 min
const REVIEWS_PROPERTY_ID = 311322; // Baker House Apartments (single-property account)
type ReviewsCache = { fetchedAt: number; byRef: Record<string, GuestRating> };

/** Inputs the review endpoints require: propertyId + a `from` date (Booking.com)
 *  and the room ids to sweep (Airbnb). `from` is a short rolling window so the
 *  Booking.com endpoint's 100-row (oldest-first) cap never hides the newest
 *  reviews — older ones are retained via the merged cache in getReviews(). */
function reviewFetchOptions(): ReviewFetchOptions {
  return {
    propertyId: REVIEWS_PROPERTY_ID,
    roomIds: PHYSICAL_ROOM_IDS,
    from: reviewsFromDate(),
  };
}

/**
 * Return synced reviews keyed by booking apiReference, refreshing from Beds24 only
 * when the Redis cache is missing or older than REVIEWS_CACHE_MAX_AGE_MS. A fetch
 * failure falls back to the stale cache (or empty) so reviews never break the sync.
 */
async function getReviews(token: string): Promise<Record<string, GuestRating>> {
  const redis = getRedis();
  let cached: ReviewsCache | null = null;
  if (redis) cached = await redis.get<ReviewsCache>(REVIEWS_CACHE_KEY);

  const fresh = cached && Date.now() - cached.fetchedAt < REVIEWS_CACHE_MAX_AGE_MS;
  if (fresh) return cached!.byRef;

  try {
    const fetched = await fetchReviews(token, reviewFetchOptions());
    // The fetch only sees a recent rolling window (Beds24's Booking.com endpoint
    // caps at 100 oldest-first), so merge into the cache to retain older reviews
    // captured by earlier windows — union by apiReference.
    const byRef = mergeReviews(cached?.byRef, fetched);
    if (redis) {
      await redis.set(REVIEWS_CACHE_KEY, { fetchedAt: Date.now(), byRef });
      // Fire Telegram for any new/changed reviews in this fresh pull so alerts
      // aren't gated behind the daily cron. Same shared dedupe (notified map) +
      // lock, so no duplicates across the cron and concurrent dashboard loads.
      // Never let an alert failure break the bookings response.
      try {
        await notifyNewReviews(redis, fetched);
      } catch (err) {
        console.error("[bookings] review alert failed:", err);
      }
    }
    return byRef;
  } catch (err) {
    console.error("[bookings] review fetch failed:", err);
    return cached?.byRef ?? {};
  }
}


/**
 * Roll up paid Stripe fees from AdditionalPayments into reservation.paymentChargeAmount.
 * For OTA bookings (Booking.com / Airbnb) the channel commission comes from Beds24's
 * top-level `commission` field and lands in commissionAmount — paymentChargeAmount
 * stays 0. For direct (Stripe-paid) bookings, the per-payment Stripe processing fee
 * is captured from the BalanceTransaction by the Stripe webhook and aggregated here
 * so every consumer (Transactions, Performance, Statements) reads a single number.
 */
async function aggregateStripeFees(reservations: Reservation[]): Promise<Reservation[]> {
  const redis = getRedis();
  if (!redis) return reservations;

  const allPayments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];
  const feeByRes = new Map<string, number>();
  for (const ap of allPayments) {
    // Include paid / partially-refunded / refunded — the Stripe fee was
    // incurred at charge time and stays with the operator even after a
    // refund (Stripe doesn't return the processing fee on refund).
    const counted =
      ap.status === "paid" ||
      ap.status === "partially-refunded" ||
      ap.status === "refunded";
    if (!counted || typeof ap.stripeFeeCzk !== "number") continue;
    feeByRes.set(ap.reservationNumber, (feeByRes.get(ap.reservationNumber) ?? 0) + ap.stripeFeeCzk);
  }

  if (feeByRes.size === 0) return reservations;

  return reservations.map((r) => {
    const fee = feeByRes.get(r.reservationNumber);
    if (!fee) return r;
    return { ...r, paymentChargeAmount: r.paymentChargeAmount + fee };
  });
}

const RATE_TYPES_KEY = "baker:reservation-rate-types";
const RATE_PERKS_KEY = "baker:reservation-rate-perks";

/**
 * Publish each reservation's EFFECTIVE rate + EFFECTIVE perks to shared Redis
 * maps keyed by reservationNumber. The cleaning app consumes the perks map
 * (`baker:reservation-rate-perks`) directly — reporting owns the rate → perk
 * mapping and the operator overrides, so cleaning just reflects the result.
 *
 * Recomputed on every sync from the current booking set, so a cancelled /
 * re-rated / modified reservation self-corrects (it drops out or updates here).
 * Read-only side effect — never affects the API response.
 */
async function persistRateTypeMap(reservations: Reservation[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const overrides =
    (await redis.get<
      Record<string, { rateTypeOverride?: RateType | null; perkOverrides?: PerkOverrides }>
    >(RESERVATION_OVERRIDES_KEY)) ?? {};
  const rateMap: Record<string, RateType> = {};
  const perkMap: Record<string, RatePerks> = {};
  for (const r of reservations) {
    if (r.isCancelled) continue;
    const ov = overrides[r.reservationNumber];
    const eff = ov?.rateTypeOverride ?? r.rateType ?? null;
    if (eff) rateMap[r.reservationNumber] = eff;
    // Effective perks = rate-derived auto value, then operator override wins.
    // Pass reservationDate so the Standard rate's perk date-gate applies.
    const perks = effectiveRatePerks(autoRatePerks(eff, r.reservationDate), ov?.perkOverrides);
    if (perks.earlyCheckIn || perks.lateCheckout || perks.specialTreatment != null) {
      perkMap[r.reservationNumber] = perks;
    }
  }
  await Promise.all([redis.set(RATE_TYPES_KEY, rateMap), redis.set(RATE_PERKS_KEY, perkMap)]);
}





/**
 * Detect reservations that occupy the same physical room with overlapping
 * date ranges and tag each side with the other's reservation numbers.
 *
 * Why this exists: when a guest cancels and re-books, the cancellation is
 * supposed to land in the cache (Pass 2 in fetchAllBookings explicitly
 * includes status=cancelled). If for any reason a cancellation slips past
 * — Beds24 outage, network glitch mid-sync, cache key in a weird state —
 * we'd end up with two "confirmed" reservations on the same room+dates.
 * The operator should never have to spot that visually; this surfaces it.
 *
 * Blackouts are skipped — they're intentionally placed to block dates
 * around a real reservation and routinely "overlap" with the booking
 * they're protecting.
 *
 * Date logic: ranges [aIn, aOut) and [bIn, bOut) overlap iff
 *   aIn < bOut && bIn < aOut
 * (checkout-day departures don't count as occupation — a Saturday
 * departure and a Saturday arrival on the same room is normal turnover).
 *
 * Room comparison considers BOTH the primary `room` and `linkedRooms`
 * (multi-unit package bookings) — a Twin Apartments booking covers
 * K.202 AND K.203, so an overlap with either physical room counts.
 */
function tagOverlappingReservations(reservations: Reservation[]): Reservation[] {
  // Build (reservation, rooms) tuples once
  type Item = { res: Reservation; rooms: Set<string>; inMs: number; outMs: number };
  const items: Item[] = reservations
    .filter((r) => !r.isBlackout && !r.isCancelled && r.checkInDate && r.checkOutDate)
    .map((r) => {
      const rooms = new Set<string>();
      if (r.room) rooms.add(r.room);
      for (const lr of r.linkedRooms ?? []) rooms.add(lr);
      return {
        res: r,
        rooms,
        inMs: new Date(r.checkInDate + "T00:00:00Z").getTime(),
        outMs: new Date(r.checkOutDate + "T00:00:00Z").getTime(),
      };
    })
    .filter((i) => Number.isFinite(i.inMs) && Number.isFinite(i.outMs) && i.outMs > i.inMs);

  // Accumulate overlap relationships
  const overlaps = new Map<string, Set<string>>();
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];
      // Quick date filter
      if (!(a.inMs < b.outMs && b.inMs < a.outMs)) continue;
      // Room overlap
      let shared = false;
      for (const r of a.rooms) {
        if (b.rooms.has(r)) { shared = true; break; }
      }
      if (!shared) continue;
      const aNum = a.res.reservationNumber;
      const bNum = b.res.reservationNumber;
      if (!aNum || !bNum) continue;
      if (!overlaps.has(aNum)) overlaps.set(aNum, new Set());
      if (!overlaps.has(bNum)) overlaps.set(bNum, new Set());
      overlaps.get(aNum)!.add(bNum);
      overlaps.get(bNum)!.add(aNum);
    }
  }

  if (overlaps.size === 0) return reservations;
  return reservations.map((r) => {
    const others = overlaps.get(r.reservationNumber);
    if (!others || others.size === 0) return r;
    return { ...r, overlapWith: [...others].sort() };
  });
}


// ─── POST handler — create a manual direct booking ───────────────────────────
export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Auth error" }, { status: 500 });
  }

  const body = await req.json();
  const {
    units,                    // new shape: [{ roomId, roomQty, price }, ...]
    roomId, roomQty, price,   // legacy single-row shape (back-compat)
    arrival, departure, numAdult, numChild,
    firstName, lastName, email, phone, notes,
  } = body as {
    units?: { roomId: number; roomQty?: number; price?: number }[];
    roomId?: number;
    roomQty?: number;
    price?: number;
    arrival?: string;
    departure?: string;
    numAdult?: number;
    numChild?: number;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    notes?: string;
  };

  if (!arrival || !departure || !firstName) {
    return NextResponse.json({ error: "arrival, departure and firstName are required" }, { status: 400 });
  }

  // Normalise input — accept both new units[] shape and legacy single-row.
  const unitRows = Array.isArray(units) && units.length > 0
    ? units.map((u) => ({
        roomId:  Number(u.roomId),
        roomQty: Math.max(1, Number(u.roomQty ?? 1)),
        price:   Number(u.price ?? 0),
      }))
    : roomId
      ? [{ roomId: Number(roomId), roomQty: Math.max(1, Number(roomQty ?? 1)), price: Number(price ?? 0) }]
      : [];

  if (unitRows.length === 0) {
    return NextResponse.json({ error: "At least one unit row is required" }, { status: 400 });
  }

  // Multi-row bookings get a [GROUP:xxx] marker so mergeGroupedBookings can
  // re-assemble them into a single visual reservation on GET. Single-row
  // bookings skip the marker (no grouping needed).
  const groupId = unitRows.length > 1
    ? `pkg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    : null;
  const groupMarker = groupId ? `[GROUP:${groupId}]` : '';

  function buildComments(): string {
    const parts = [APP_PHONE_MARKER];
    if (groupMarker) parts.push(groupMarker);
    if (notes && notes.trim()) parts.push(notes.trim());
    return parts.join('\n');
  }

  const bookings = unitRows.map((row) => ({
    roomId: row.roomId,
    status: "confirmed",
    arrival,
    departure,
    numAdult: numAdult ?? 1,
    numChild: numChild ?? 0,
    firstName,
    lastName: lastName ?? "",
    email: email ?? "",
    phone: phone ?? "",
    referer: "PhoneDirect",
    apiSource: "Direct",
    comments: buildComments(),
    price: row.price > 0 ? row.price : 0,
    // For VR rows with roomQty > 1, Beds24 auto-allocates to multiple physical
    // subs. The field is harmless when omitted but explicit when set.
    ...(row.roomQty > 1 ? { roomQty: row.roomQty } : {}),
    invoiceItems: row.price > 0
      ? [{ type: "charge", subType: 1, description: "Accommodation", qty: 1, amount: row.price }]
      : [],
  }));

  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: "POST",
    headers: { token, "Content-Type": "application/json" },
    body: JSON.stringify(bookings),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: res.status });
  }

  const json = await res.json();

  // Extract created booking IDs from Beds24's response. Shape varies:
  //   [{ id, new, info }]                      ← bare array
  //   { success: true, data: [{ id, ... }] }   ← wrapped
  function extractAllIds(d: unknown): (string | number)[] {
    const ids: (string | number)[] = [];
    const walk = (v: unknown) => {
      if (!v) return;
      if (Array.isArray(v)) { for (const item of v) walk(item); return; }
      if (typeof v === 'object') {
        const obj = v as Record<string, unknown>;
        if (typeof obj.id === 'string' || typeof obj.id === 'number') ids.push(obj.id);
        if (obj.data !== undefined) walk(obj.data);
        // Beds24 sometimes nests created records under "new"
        if (obj.new !== undefined) walk(obj.new);
      }
    };
    walk(d);
    return ids;
  }
  const allIds = extractAllIds(json);
  const firstId = allIds[0];
  const reservationNumber = firstId !== undefined ? `BH-${firstId}` : undefined;

  return NextResponse.json({
    ok: true,
    data: json,
    reservationNumber,           // canonical (first booking's number)
    reservationNumbers: allIds.map((id) => `BH-${id}`),
    groupId,
  });
}

// ─── GET handler — fetch all bookings ────────────────────────────────────────
export async function GET(req: NextRequest) {
  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Auth error";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  try {
    // ?fullSync=true → bypass the Redis delta cache and re-fetch the full
    // 2-year window from Beds24. Use this when the cache is suspected to
    // be out of sync (rare — the 24-h max-age safety net should catch most
    // drift automatically).
    const fullSync = req.nextUrl.searchParams.get("fullSync") === "true";
    const raw = await fetchAllBookings(token, { fullSync });

    // ?raw=true → return raw Beds24 response for debugging
    if (req.nextUrl.searchParams.get("raw") === "true") {
      return NextResponse.json(raw);
    }

    // ?rawReviews=true → dump the raw, unparsed review payloads from both
    // Beds24 review endpoints. Use this to confirm the real field names before
    // trusting the defensive parser in utils/beds24Reviews.ts.
    if (req.nextUrl.searchParams.get("rawReviews") === "true") {
      return NextResponse.json(await fetchRawReviews(token, reviewFetchOptions()));
    }

    // ?debugId=<id> → return raw fields for a single booking (masterid diagnosis)
    const debugId = req.nextUrl.searchParams.get("debugId");
    if (debugId) {
      const booking = raw.find((b) => b.id === Number(debugId));
      return NextResponse.json(booking ?? { error: `Booking ${debugId} not found in fetched set` });
    }

    // ?debugRates=true → dump the rate-plan signal fields + detected type for
    // current+future OTA bookings, so the detector patterns can be calibrated
    // against real data. See utils/rateType.ts (CALIBRATION NEEDED).
    if (req.nextUrl.searchParams.get("debugRates") === "true") {
      const today = new Date().toISOString().slice(0, 10);
      const rows = mergeGroupedBookings(
        raw.filter((b) => b.status !== "cancelled" && b.status !== "canceled"),
      )
        .map((b) => ({ b, channel: mapChannel(b.apiSource, b.referer, b.comments ?? "") }))
        .filter(({ b, channel }) =>
          isRateTypeInScope(
            { channel, reservationDate: (b.bookingTime ?? "").slice(0, 10), checkOutDate: b.departure ?? "" },
            today,
          ),
        )
        .map(({ b, channel }) => ({
          reservationNumber: `BH-${b.id}`,
          channel,
          booked: (b.bookingTime ?? "").slice(0, 10),
          checkIn: b.arrival,
          checkOut: b.departure,
          detected: detectRateType({
            channel,
            signals: [b.rateDescription, b.apiReference, infoItemsText(b.infoItems)],
          }),
          rateDescription: b.rateDescription ?? null,
          apiReference: b.apiReference ?? null,
          apiSource: b.apiSource ?? null,
          referer: b.referer ?? null,
          infoItems: b.infoItems ?? null,
        }));
      return NextResponse.json({ count: rows.length, today, rows });
    }

    // Active bookings keep the existing grouping (VR ↔ physical, Booking.com
    // multi-unit). Cancelled bookings are admitted too — shown in Transactions
    // with a Cancelled flag, but excluded from the Active view and from
    // revenue/occupancy/commission (see grossProfit + OccupancyCalendar). They
    // are mapped individually: grouping is a live-inventory concern that doesn't
    // apply to a cancellation.
    const isCancelledStatus = (b: Beds24Booking) =>
      b.status === "cancelled" || b.status === "canceled";
    const grouped = mergeGroupedBookings(raw.filter((b) => !isCancelledStatus(b)));
    const mapped = grouped.map(mapToReservation);
    const cancelledMapped = raw.filter(isCancelledStatus).map(mapToReservation);

    // Attach synced guest reviews (Booking.com / Airbnb). Reviews key off the
    // channel reference (Beds24 `apiReference`), not the booking id. `grouped`
    // is parallel to `mapped`, so we read each booking's apiReference by index.
    // Cancelled bookings don't carry reviews.
    const reviews = await getReviews(token);
    const activeWithReviews = mapped.map((r, i) => {
      const ref = grouped[i].apiReference;
      const rating = ref ? reviews[String(ref)] : undefined;
      return rating ? { ...r, syncedRating: rating } : r;
    });
    const reservations = [...activeWithReviews, ...cancelledMapped];

    const withStripeFees = await aggregateStripeFees(reservations);
    const withOverlapFlags = tagOverlappingReservations(withStripeFees);
    const withNonArrival = await attachNonArrivalOverlay(withOverlapFlags);

    // Publish effective rate types for the cleaning app (rate-based perks).
    await persistRateTypeMap(withNonArrival).catch((err) =>
      console.error("[bookings] rate-type map persist failed:", err),
    );

    // ── Inventory-calendar blackout overrides ──
    // Blackouts created in Beds24's UI live on a separate endpoint
    // (POST /inventory/rooms/calendar with override="blackout"); they are
    // invisible to GET /bookings. Fetch them here and merge as synthetic
    // Reservation rows so the calendar + reservation list see them too.
    const overrideBlackouts = await fetchOverrideBlackouts(token).catch((err) => {
      console.error('[bookings] inventory-override fetch failed:', err);
      return [] as Reservation[];
    });

    return NextResponse.json([...withNonArrival, ...overrideBlackouts]);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ─── Inventory-calendar blackout overrides ───────────────────────────────────
//
// Beds24's UI creates blackouts as inventory overrides, not as bookings.
// They live at `GET /inventory/rooms/calendar?includeOverride=true`. We
// fetch them per physical room over a wide window and convert each
// override=blackout range into a synthetic Reservation row.

/** Physical rooms only — overrides are always set on physical inventory. */
const PHYSICAL_ROOM_IDS: number[] = [
  656437, // K.201
  648596, // K.202
  648772, // K.203
  674672, // O.308
  679703, // K.102
  679704, // K.103
  679705, // K.106
];

interface Beds24CalendarEntry {
  from?: string;
  to?: string;
  override?: string;
}

/**
 * Walk a Beds24 calendar response and pull out every blackout-override
 * range. The response shape varies (sometimes `{ data: [{ calendar: [...] }] }`,
 * sometimes a bare `[{ calendar: [...] }]`, sometimes per-day entries with
 * just `date`, sometimes range entries with `from`/`to`), so we recurse
 * permissively the same way price-check does. Adjacent same-room days get
 * coalesced into one range below.
 */
function extractBlackoutRanges(payload: unknown): Beds24CalendarEntry[] {
  const raw: Beds24CalendarEntry[] = [];
  const walk = (v: unknown): void => {
    if (!v) return;
    if (Array.isArray(v)) { for (const item of v) walk(item); return; }
    if (typeof v !== 'object') return;
    const obj = v as Record<string, unknown>;
    const override = typeof obj.override === 'string' ? obj.override : undefined;
    if (override === 'blackout') {
      // Range shape: { from, to, override }
      const from = typeof obj.from === 'string' ? obj.from : undefined;
      const to = typeof obj.to === 'string' ? obj.to : undefined;
      if (from && to && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
        raw.push({ from, to, override });
      } else {
        // Per-day shape: { date, override } — treat as single-day range
        const date = typeof obj.date === 'string' ? obj.date : undefined;
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
          raw.push({ from: date, to: date, override });
        }
      }
    }
    for (const key of Object.keys(obj)) walk(obj[key]);
  };
  walk(payload);

  // Coalesce contiguous days into ranges so a 7-day blackout shows up as
  // one synthetic Reservation row rather than seven daily entries. Sort by
  // `from`, then walk forward merging anything whose `from` is the day
  // after the previous entry's `to`.
  if (raw.length <= 1) return raw;
  const sorted = [...raw].sort((a, b) => (a.from ?? '').localeCompare(b.from ?? ''));
  const merged: Beds24CalendarEntry[] = [];
  for (const entry of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.to && entry.from) {
      const expectedNext = nextDay(last.to);
      if (entry.from === expectedNext || entry.from <= last.to) {
        // Contiguous or overlapping — extend the range
        if (entry.to && entry.to > (last.to ?? '')) last.to = entry.to;
        continue;
      }
    }
    merged.push({ ...entry });
  }
  return merged;
}

/** Add one day to a YYYY-MM-DD string. */
function nextDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Redis cache for the override-blackout fetch — 7 Beds24 calls per
 * `/api/bookings` GET adds up fast (especially with multi-operator
 * dashboards + auto-reply self-nudges every 30s, which hit Beds24's
 * credit-bucket rate limit). Blackouts change rarely so a 5-minute
 * cache is essentially invisible to operators; the POST/DELETE
 * endpoints in /api/bookings/blackout invalidate this key so manual
 * blackout changes propagate immediately.
 */
const OVERRIDE_BLACKOUTS_CACHE_KEY = 'baker:override-blackouts-cache';
const OVERRIDE_BLACKOUTS_TTL_SECONDS = 5 * 60;

async function fetchOverrideBlackouts(token: string): Promise<Reservation[]> {
  // ── Redis cache lookup ──
  const redis = getRedis();
  if (redis) {
    const cached = await redis.get<Reservation[]>(OVERRIDE_BLACKOUTS_CACHE_KEY);
    if (cached) return cached;
  }

  // Match the bookings cache window — 1 year back, 1 year forward — so
  // historical overrides for performance/occupancy stats stay visible.
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 1);
  const startDate = from.toISOString().slice(0, 10);
  const endDate = to.toISOString().slice(0, 10);

  const results: Reservation[] = [];
  // One request per room — Beds24's calendar GET doesn't accept multiple
  // roomIds in a single query (per Swagger). Run in parallel.
  await Promise.all(PHYSICAL_ROOM_IDS.map(async (roomId) => {
    const params = new URLSearchParams({
      roomId: String(roomId),
      startDate,
      endDate,
      includeOverride: 'true',
    });
    const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar?${params}`, {
      headers: { token },
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[bookings] calendar(${roomId}) ${res.status}: ${text.slice(0, 200)}`);
      return;
    }
    const json = await res.json().catch(() => null);
    const ranges = extractBlackoutRanges(json);
    const roomName = mapRoom(roomId);
    for (const r of ranges) {
      if (!r.from || !r.to) continue;
      // Convert Beds24's inclusive `to` back to our checkout-morning convention.
      const checkOutDate = nextDay(r.to);
      const nights =
        Math.round((new Date(checkOutDate + 'T00:00:00Z').getTime() - new Date(r.from + 'T00:00:00Z').getTime()) / 86_400_000);
      results.push({
        reservationNumber: `OV-${roomId}-${r.from}-${r.to}`,
        isBlackout: true,
        firstName: 'Blackout',
        lastName: '',
        channel: 'Direct',
        room: roomName,
        checkInDate: r.from,
        checkOutDate,
        reservationDate: '',
        bookingTimestamp: '',
        numberOfNights: nights,
        numberOfGuests: 0,
        email: '',
        phone: '',
        price: 0,
        nationality: '',
        cleaningStatus: 'Completed',
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
      });
    }
  }));

  // Write through to cache for subsequent /api/bookings GETs.
  if (redis) {
    await redis.set(OVERRIDE_BLACKOUTS_CACHE_KEY, results, {
      ex: OVERRIDE_BLACKOUTS_TTL_SECONDS,
    });
  }
  return results;
}
