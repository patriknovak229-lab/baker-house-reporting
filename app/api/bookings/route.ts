import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import type { Reservation, Channel, Room, CleaningStatus, PaymentStatus, RateType, NonArrival } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import { detectRateType, isRateTypeInScope } from "@/utils/rateType";
import { autoRatePerks, effectiveRatePerks } from "@/utils/ratePerks";
import type { PerkOverrides, RatePerks } from "@/utils/ratePerks";
import { deriveNationality, countryFromCodeOrLang } from "@/utils/nationalityUtils";
import { fetchReviews, fetchRawReviews, type ReviewFetchOptions } from "@/utils/beds24Reviews";
import type { GuestRating } from "@/types/reservation";

const BEDS24_API_BASE = "https://beds24.com/api/v2";
const ADDITIONAL_PAYMENTS_KEY = "baker:additional-payments";

// Synced guest reviews (Booking.com / Airbnb) cache. Reviews are low-volume and
// change slowly, so we re-fetch from Beds24 at most once per this window rather
// than on every bookings sync. Keyed by booking channel reference (apiReference).
const REVIEWS_CACHE_KEY = "baker:beds24-reviews-cache";
const REVIEWS_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 h
const REVIEWS_PROPERTY_ID = 311322; // Baker House Apartments (single-property account)
type ReviewsCache = { fetchedAt: number; byRef: Record<string, GuestRating> };

/** Inputs the review endpoints require: propertyId + a `from` date (Booking.com)
 *  and the room ids to sweep (Airbnb). `from` looks back 2 years for past stays. */
function reviewFetchOptions(): ReviewFetchOptions {
  const from = new Date();
  from.setUTCFullYear(from.getUTCFullYear() - 2);
  return {
    propertyId: REVIEWS_PROPERTY_ID,
    roomIds: PHYSICAL_ROOM_IDS,
    from: from.toISOString().slice(0, 10),
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
    const byRef = await fetchReviews(token, reviewFetchOptions());
    if (redis) await redis.set(REVIEWS_CACHE_KEY, { fetchedAt: Date.now(), byRef });
    return byRef;
  } catch (err) {
    console.error("[bookings] review fetch failed:", err);
    return cached?.byRef ?? {};
  }
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
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

const RESERVATION_OVERRIDES_KEY = "baker:reservation-overrides";
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
    const perks = effectiveRatePerks(autoRatePerks(eff), ov?.perkOverrides);
    if (perks.earlyCheckIn || perks.lateCheckout || perks.specialTreatment != null) {
      perkMap[r.reservationNumber] = perks;
    }
  }
  await Promise.all([redis.set(RATE_TYPES_KEY, rateMap), redis.set(RATE_PERKS_KEY, perkMap)]);
}

/**
 * Fold the non-arrival overlay (flag + editable net price) from
 * `baker:reservation-overrides` onto reservations server-side, so every
 * consumer — Transactions, Performance, Commission, the calendar — sees the
 * same non-arrival state without each having to merge local overrides itself.
 * The Transactions client still layers the full override set on top (identical
 * values), keeping optimistic UI updates instant.
 */
async function attachNonArrivalOverlay(reservations: Reservation[]): Promise<Reservation[]> {
  const redis = getRedis();
  if (!redis) return reservations;
  const overrides =
    (await redis.get<
      Record<string, { nonArrival?: NonArrival | null; nonArrivalNetPriceCzk?: number | null }>
    >(RESERVATION_OVERRIDES_KEY)) ?? {};
  if (Object.keys(overrides).length === 0) return reservations;
  return reservations.map((r) => {
    const ov = overrides[r.reservationNumber];
    if (!ov?.nonArrival) return r;
    return {
      ...r,
      nonArrival: ov.nonArrival,
      nonArrivalNetPriceCzk: ov.nonArrivalNetPriceCzk ?? ov.nonArrival.originalPriceCzk,
    };
  });
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
// Derived from raw response inspection. Confirm in Beds24 → Properties → Rooms.
const UNIT_MAP: Record<number, Room> = {
  // Deluxe — existing
  656437: "K.201",
  648596: "K.202",
  648772: "K.203",
  674672: "O.308",
  // Urban — new (1KK Urban Studios, opening in ~1 week)
  679703: "K.102",
  679704: "K.103",
  679705: "K.106",
  // Note: 679714 is the "1KK Urban Studios" virtual/selling room — not a
  // physical unit. Beds24 auto-allocates VR bookings to one of the three
  // physical sub-rooms (same pattern as 648816 → K.202/K.203), so the VR
  // itself is intentionally NOT in UNIT_MAP — sub-bookings are.
};

// ─── Channel mapping ───────────────────────────────────────────────────────────
// Confirmed via debug dump of BH-86527838:
//   - apiSource = "Booking.com" / "Airbnb" — OTAs
//   - apiSource = "Direct" + referer = "API" — booking POSTed via Beds24 V2 API.
//     Beds24 forces referer to "API" for all V2 POSTs regardless of what the
//     client supplied — so we can't rely on referer="PhoneDirect" surviving
//     for our app's manual phone bookings.
//   - apiSource = "Direct" + referer = "" (blank) — manually entered in the
//     Beds24 UI (legacy)
//
// Two API origins exist:
//   a) our /api/bookings POST (manual phone bookings) — operator creates from
//      the dashboard. We tag these with APP_PHONE_MARKER in `comments` so they
//      survive Beds24's referer override.
//   b) rental site bakerhouseapartments.cz — anything else with referer="API"
const APP_PHONE_MARKER = "[Created via Reporting App — Phone]";

function mapChannel(apiSource = "", referer = "", comments = ""): Channel {
  if (apiSource === "Booking.com") return "Booking.com";
  if (apiSource === "Airbnb") return "Airbnb";

  // Marker in comments wins over Beds24's overridden referer
  if (comments.includes(APP_PHONE_MARKER)) return "Direct-Phone";

  const ref = referer.toLowerCase();
  if (ref.includes("phone")) return "Direct-Phone";   // legacy fallback
  if (ref.includes("web"))   return "Direct-Web";     // explicit web tag

  // Beds24 V2 API submissions land here with referer="API" (literal). The
  // rental site is the dominant such origin once our own app's bookings
  // have been filtered out via the comment marker above.
  if (ref === "api") return "Direct-Web";

  return "Direct";
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
/**
 * Virtual-room (room TYPE) labels. Beds24 keeps a booking on a VR roomId
 * until a physical room is assigned. Per operator policy these are NOT
 * auto-split across nights — the booking stays on the VR until manually
 * allocated. We surface this state explicitly to the operator rather than
 * silently picking a random physical room.
 */
const VR_ROOM_LABELS: Record<number, string> = {
  679714: "1KK Urban Studios",
  648816: "1KK Deluxe Studios",
};

/**
 * Map a Beds24 roomId to its display name.
 *
 * - Physical roomId → physical room name (K.201, K.102, etc.)
 * - VR roomId (no physical allocation yet) → room TYPE label (e.g. "1KK Urban Studios"),
 *   paired with `isUnallocatedVR: true` on the resulting Reservation so the
 *   table + task bar can flag it.
 * - Anything else → "Unknown room {id}" — better to scream than silently
 *   misattribute (previous code fell back to literal "K.202", which made
 *   unallocated bookings appear as that room — see commit history).
 */
function mapRoom(roomId: number): Room {
  if (UNIT_MAP[roomId]) return UNIT_MAP[roomId];
  if (VR_ROOM_LABELS[roomId]) return VR_ROOM_LABELS[roomId];
  return `Unknown room ${roomId}`;
}

/** Is this a VR roomId (no physical allocation yet)? */
function isVirtualRoomId(roomId: number): boolean {
  return VR_ROOM_LABELS[roomId] != null;
}

// ─── Cleaning status (date-based until cleaning app is wired) ──────────────────
function deriveCleaningStatus(departure: string): CleaningStatus {
  const today = new Date().toISOString().slice(0, 10);
  return departure < today ? "Completed" : "Pending";
}

// ─── Payment status — derived from Beds24 deposit field ───────────────────────
// deposit reflects what has been recorded as received in Beds24 (e.g. bank transfer marked paid).
// PRE-PAID in comments = OTA handled payment; Airbnb always pays out to host.
function derivePayment(b: Beds24Booking): { paymentStatus: PaymentStatus; amountPaid: number } {
  const price = b.price ?? 0;
  const deposit = b.deposit ?? 0;

  // OTA pre-paid: full amount collected by the channel
  if (b.comments?.includes("PRE-PAID")) return { paymentStatus: "Paid", amountPaid: price };
  // Airbnb: payout handled by Airbnb
  if (b.apiSource === "Airbnb") return { paymentStatus: "Paid", amountPaid: price };
  // Direct / other: use deposit field recorded in Beds24
  if (deposit >= price && price > 0) return { paymentStatus: "Paid", amountPaid: deposit };
  if (deposit > 0) return { paymentStatus: "Partially Paid", amountPaid: deposit };
  return { paymentStatus: "Unpaid", amountPaid: 0 };
}

// ─── Beds24 V2 booking shape (confirmed from raw response) ────────────────────
interface Beds24Booking {
  id: number;
  roomId: number;
  masterId?: number | null; // set on sub-bookings allocated from a virtual/package room; null on the master itself
  arrival: string;        // YYYY-MM-DD (check-in)
  departure: string;      // YYYY-MM-DD (check-out)
  numAdult: number;
  numChild: number;
  price: number;          // total in CZK
  deposit: number;        // amount received/recorded in Beds24 (bank transfer, etc.)
  commission: number;     // total channel fees in CZK (OTA commission + payment charge combined)
  rateDescription: string; // human-readable rate breakdown; contains fee split for Booking.com/Airbnb
  apiReference?: string;   // channel's own reference; may carry the rate-plan name (rate detection signal)
  infoItems?: Array<Record<string, unknown>>; // channel key/value extras (rate plan, meal plan, …) — requires includeInfoItems=true
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  mobile?: string;           // secondary phone (Beds24)
  country: string | null;    // ISO 2-letter, often lowercase — the field Direct/API (rental-site) bookings populate
  country2: string | null;   // ISO 2-letter — the field most OTA bookings populate
  lang?: string;             // guest language e.g. "cs" — last-resort nationality signal
  apiSource: string;      // "Booking.com" | "Airbnb" | "API" (V2 POST) | "Direct" (Beds24 UI) | ""
  referer: string;        // e.g. "PhoneDirect" (our app), "DirectWeb" (rental site), or empty
  bookingTime: string;    // ISO timestamp — when the booking was created
  modifiedTime?: string;  // ISO timestamp — when Beds24 last changed any field
  status: string;         // "new" | "confirmed" | "cancelled"
  comments: string;       // contains "PRE-PAID" for prepaid reservations
}

// ─── Channel fee breakdown ───────────────────────────────────────────────────
// Beds24's top-level `commission` field is the authoritative total of
// everything kept by the channel — for Booking.com that includes both the
// OTA commission and the Payment Charge; for Airbnb it's the Host Fee. We
// previously parsed rateDescription to split the two, but that field has a
// character limit and gets truncated on long stays — making the split
// unreliable. Operator confirmed the granularity isn't needed: a single
// total is sufficient. Stripe fees on direct bookings still flow through
// paymentChargeAmount via the AdditionalPayment roll-up.
function parseCommissionBreakdown(
  _rateDescription: string,
  totalCommission: number
): { commissionAmount: number; paymentChargeAmount: number } {
  return { commissionAmount: totalCommission, paymentChargeAmount: 0 };
}

// ─── Manual group overrides ───────────────────────────────────────────────────
// For bookings that were manually copied into Beds24 without auto-allocation,
// masterid is not set. Hard-wire them here so they merge correctly.
// Format: masterId → [siblingId, ...] — master's price/guest data is used;
// all bookings in the group contribute their physical room to linkedRooms.
const MANUAL_GROUPS: Record<number, number[]> = {
  84883846: [84885667], // Twin Apartments — manually copied Apr 2026
};

// ─── Merge package/virtual room bookings ─────────────────────────────────────
// When a booking arrives on a virtual room (e.g. "Twin Apartments" = K.202+K.203),
// Beds24 creates sub-bookings for each physical room, each referencing the original
// via `masterid`. We merge them into one reservation to avoid double-counting.
//
// Three cases handled:
// 0. Manual group overrides (MANUAL_GROUPS) — no masterid in Beds24, hard-wired here.
// 1. Master booking (virtual room) present + sub-bookings → use master for price/guest,
//    subs for physical room names.
// 2. Master booking filtered out (cancelled/virtual) but subs share a masterid →
//    use first sub for price/guest, combine all physical room names.
function mergeGroupedBookings(all: Beds24Booking[]): Beds24Booking[] {
  // ── Case 0: apply manual group overrides first ──────────────────────────────
  const manualConsumedIds = new Set<number>();
  const manualResults: Beds24Booking[] = [];

  for (const [masterIdStr, siblingIds] of Object.entries(MANUAL_GROUPS)) {
    const masterId = Number(masterIdStr);
    const masterBooking = all.find((b) => b.id === masterId);
    const siblings = siblingIds
      .map((id) => all.find((b) => b.id === id))
      .filter((b): b is Beds24Booking => b != null);

    if (!masterBooking || siblings.length === 0) continue;

    const allInGroup = [masterBooking, ...siblings];
    const physicalRooms = allInGroup
      .map((b) => UNIT_MAP[b.roomId])
      .filter((r): r is string => r != null);

    allInGroup.forEach((b) => manualConsumedIds.add(b.id));

    if (physicalRooms.length > 0) {
      const merged = { ...masterBooking };
      (merged as Beds24Booking & { _linkedRooms: string[] })._linkedRooms = physicalRooms;
      // Booking.com multi-unit via manual group: sum prices (same logic as auto-merge)
      if (merged.apiSource === 'Booking.com') {
        merged.price   = (merged.price   ?? 0) + siblings.reduce((s, r) => s + (r.price   ?? 0), 0);
        merged.deposit = (merged.deposit ?? 0) + siblings.reduce((s, r) => s + (r.deposit ?? 0), 0);
        const commBreakdown = [merged, ...siblings].reduce(
          (acc, r) => {
            const bd = parseCommissionBreakdown(r.rateDescription ?? '', r.commission ?? 0);
            return {
              commissionAmount:    acc.commissionAmount    + bd.commissionAmount,
              paymentChargeAmount: acc.paymentChargeAmount + bd.paymentChargeAmount,
            };
          },
          { commissionAmount: 0, paymentChargeAmount: 0 },
        );
        (merged as Beds24Booking & { _commissionBreakdown?: { commissionAmount: number; paymentChargeAmount: number } })
          ._commissionBreakdown = commBreakdown;
      }
      manualResults.push(merged);
    } else {
      manualResults.push(masterBooking);
    }
  }

  // Filter out manually consumed bookings before standard merge logic
  const remaining = all.filter((b) => !manualConsumedIds.has(b.id));

  // Group sub-bookings by their masterid.
  // Beds24 sometimes sets masterid = b.id on the master booking itself (self-reference)
  // to indicate "this IS the master". Exclude those — they're masters, not subs.
  const subsByMaster = new Map<number, Beds24Booking[]>();
  for (const b of remaining) {
    if (b.masterId != null && b.masterId !== b.id) {
      const group = subsByMaster.get(b.masterId) ?? [];
      group.push(b);
      subsByMaster.set(b.masterId, group);
    }
  }

  if (subsByMaster.size === 0) return [...manualResults, ...remaining]; // fast path

  const result: Beds24Booking[] = [];
  const consumedIds = new Set<number>();

  for (const b of remaining) {
    if (consumedIds.has(b.id)) continue;

    // Sub-booking: will be handled when its master is encountered (or below)
    // Self-referencing masterid (masterid === b.id) means this IS the master — don't skip it
    if (b.masterId != null && b.masterId !== b.id) continue;

    const subs = subsByMaster.get(b.id);
    if (subs && subs.length > 0) {
      // Master booking with sub-bookings — merge.
      // Include the master's own room if it maps to a known physical room
      // (happens when Beds24 uses a physical room booking as master instead of a
      // separate virtual-room booking). Virtual-room masters won't be in UNIT_MAP
      // so UNIT_MAP[b.roomId] returns undefined and is filtered out — safe either way.
      const physicalRooms = [
        UNIT_MAP[b.roomId],
        ...subs.map((s) => UNIT_MAP[s.roomId]),
      ].filter((r): r is string => r != null);

      consumedIds.add(b.id);
      subs.forEach((s) => consumedIds.add(s.id));

      if (physicalRooms.length === 0) {
        result.push(b); // all subs are virtual/unknown — keep master as-is
      } else {
        // Attach merged room info as extra fields (read in mapToReservation)
        (b as Beds24Booking & { _linkedRooms: string[] })._linkedRooms = physicalRooms;
        // Booking.com multi-unit: guest buys N identical rooms, each with its own price.
        // Sum price/commission/deposit across master + all subs so totals are correct.
        // Airbnb twin/package: master already carries the full combined price — leave as-is.
        if (b.apiSource === 'Booking.com') {
          b.price   = (b.price   ?? 0) + subs.reduce((s, r) => s + (r.price   ?? 0), 0);
          b.deposit = (b.deposit ?? 0) + subs.reduce((s, r) => s + (r.deposit ?? 0), 0);
          // Parse commission breakdown from each booking's rateDescription individually,
          // then sum the components. We cannot just sum b.commission because mapToReservation
          // calls parseCommissionBreakdown(rateDescription) which only sees the master's text.
          const commBreakdown = [b, ...subs].reduce(
            (acc, r) => {
              const bd = parseCommissionBreakdown(r.rateDescription ?? '', r.commission ?? 0);
              return {
                commissionAmount:     acc.commissionAmount     + bd.commissionAmount,
                paymentChargeAmount:  acc.paymentChargeAmount  + bd.paymentChargeAmount,
              };
            },
            { commissionAmount: 0, paymentChargeAmount: 0 },
          );
          (b as Beds24Booking & { _commissionBreakdown?: { commissionAmount: number; paymentChargeAmount: number } })
            ._commissionBreakdown = commBreakdown;
        }
        result.push(b);
      }
    } else {
      result.push(b);
    }
  }

  // Case 2: sub-bookings whose master was not in the fetched set (e.g. cancelled virtual booking)
  const orphanGroups = new Map<number, Beds24Booking[]>();
  for (const b of remaining) {
    if (b.masterId != null && !consumedIds.has(b.id)) {
      const group = orphanGroups.get(b.masterId) ?? [];
      group.push(b);
      orphanGroups.set(b.masterId, group);
    }
  }

  for (const subs of orphanGroups.values()) {
    const physicalRooms = subs
      .map((s) => UNIT_MAP[s.roomId])
      .filter((r): r is string => r != null);

    if (physicalRooms.length === 0) {
      // All unknown rooms — add each as standalone
      subs.forEach((s) => result.push(s));
      continue;
    }

    // Use first sub as the base; override room with combined name
    const base = { ...subs[0] };
    (base as Beds24Booking & { _linkedRooms: string[] })._linkedRooms = physicalRooms;
    // Booking.com multi-unit: sum prices across all subs (same logic as Case 1)
    if (base.apiSource === 'Booking.com') {
      base.price   = subs.reduce((s, r) => s + (r.price   ?? 0), 0);
      base.deposit = subs.reduce((s, r) => s + (r.deposit ?? 0), 0);
      const commBreakdown = subs.reduce(
        (acc, r) => {
          const bd = parseCommissionBreakdown(r.rateDescription ?? '', r.commission ?? 0);
          return {
            commissionAmount:    acc.commissionAmount    + bd.commissionAmount,
            paymentChargeAmount: acc.paymentChargeAmount + bd.paymentChargeAmount,
          };
        },
        { commissionAmount: 0, paymentChargeAmount: 0 },
      );
      (base as Beds24Booking & { _commissionBreakdown?: { commissionAmount: number; paymentChargeAmount: number } })
        ._commissionBreakdown = commBreakdown;
    }
    result.push(base);
  }

  // ── Case 3: package bookings created via the multi-row "New Booking" flow ──
  // Bookings POSTed in the same multi-row call all carry the same [GROUP:xxx]
  // marker in comments. After Beds24 has auto-allocated each master to its
  // physical sub(s) and our Case 1/2 logic has merged each master→subs pair,
  // we now merge across masters: collect every booking sharing the same
  // group marker, pick the first as the canonical reservation, and merge
  // physical room names + total price + commission across the rest.
  const finalBookings: Beds24Booking[] = [...manualResults, ...result];
  const byGroup = new Map<string, Beds24Booking[]>();
  for (const b of finalBookings) {
    const groupId = extractGroupId(b.comments ?? '');
    if (!groupId) continue;
    const arr = byGroup.get(groupId) ?? [];
    arr.push(b);
    byGroup.set(groupId, arr);
  }

  // Drop everything that belongs to a multi-row group; we'll replace with one
  // merged booking per group below.
  const groupConsumedIds = new Set<number>();
  for (const arr of byGroup.values()) {
    if (arr.length > 1) for (const b of arr) groupConsumedIds.add(b.id);
  }
  const ungrouped = finalBookings.filter((b) => !groupConsumedIds.has(b.id));
  const groupedMerged: Beds24Booking[] = [];

  for (const arr of byGroup.values()) {
    if (arr.length <= 1) continue; // single-row "group" wasn't actually grouped
    // Stable order: by id ascending — the lowest id is the canonical "package head".
    const sorted = [...arr].sort((a, b) => a.id - b.id);
    const head = sorted[0];
    const base: Beds24Booking = { ...head };
    // Combine physical rooms across all rows (already resolved by Case 1/2)
    const allRooms: string[] = [];
    for (const member of sorted) {
      const linked = (member as Beds24Booking & { _linkedRooms?: string[] })._linkedRooms;
      if (linked && linked.length > 0) {
        allRooms.push(...linked);
      } else {
        const name = UNIT_MAP[member.roomId];
        if (name) allRooms.push(name);
      }
    }
    (base as Beds24Booking & { _linkedRooms: string[] })._linkedRooms = [...new Set(allRooms)];
    // Sum total package price + deposit so the merged reservation shows the full amount
    base.price   = sorted.reduce((s, r) => s + (r.price   ?? 0), 0);
    base.deposit = sorted.reduce((s, r) => s + (r.deposit ?? 0), 0);
    base.commission = sorted.reduce((s, r) => s + (r.commission ?? 0), 0);
    groupedMerged.push(base);
  }

  return [...ungrouped, ...groupedMerged];
}

/** Extracts the group id from a "[GROUP:xxx]" marker anywhere in comments.
 *  Used by the multi-row package-booking merge in mergeGroupedBookings. */
function extractGroupId(comments: string): string | null {
  if (!comments) return null;
  const m = comments.match(/\[GROUP:([^\]\s]+)\]/);
  return m ? m[1] : null;
}

// ─── Parse blackout metadata from Beds24 comments ────────────────────────────
// Blackouts created via /api/bookings/blackout embed the operator email as
// "[BLACKOUT_BY:email@example.com]\n<reason>" — pull both back out for display.
// Matches the prefix anywhere in the comment (lenient — handles legacy entries
// where Beds24 may have moved the prefix or trimmed whitespace).
function parseBlackoutMeta(comments: string): { createdBy?: string; reason?: string } {
  if (!comments) return {};
  const m = comments.match(/\[BLACKOUT_BY:([^\]]+)\]/);
  if (!m) {
    // No prefix found — treat the whole comment as the reason (legacy blackouts)
    return { reason: comments.trim() || undefined };
  }
  const createdBy = m[1].trim();
  // Strip the prefix from the comment to get the reason
  const reason = comments.replace(m[0], '').replace(/^\s+|\s+$/g, '');
  return {
    createdBy: createdBy || undefined,
    reason: reason || undefined,
  };
}

// ─── Rate-plan detection signal ──────────────────────────────────────────────
/** Flatten Beds24 infoItems (shape varies) into searchable text for rate detection. */
function infoItemsText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  const parts: string[] = [];
  for (const it of items) {
    if (it && typeof it === "object") {
      for (const v of Object.values(it as Record<string, unknown>)) {
        if (typeof v === "string") parts.push(v);
      }
    } else if (typeof it === "string") {
      parts.push(it);
    }
  }
  return parts.join(" ");
}

/** Run best-effort rate-type detection, gated by the rate-type scope rule. */
function deriveRateType(b: Beds24Booking, channel: Channel): Reservation["rateType"] {
  const todayYmd = new Date().toISOString().slice(0, 10);
  const inScope = isRateTypeInScope(
    { channel, reservationDate: (b.bookingTime ?? "").slice(0, 10), checkOutDate: b.departure ?? "" },
    todayYmd,
  );
  if (!inScope) {
    return undefined;
  }
  return (
    detectRateType({
      channel,
      signals: [b.rateDescription, b.apiReference, infoItemsText(b.infoItems)],
    }) ?? undefined
  );
}

// ─── Map Beds24 booking → our Reservation type ────────────────────────────────
function mapToReservation(b: Beds24Booking): Reservation {
  const nights =
    b.arrival && b.departure
      ? Math.round(
          (new Date(b.departure).getTime() - new Date(b.arrival).getTime()) / 86_400_000
        )
      : 0;

  const isBlackout = b.status === 'black';
  const isCancelled = b.status === 'cancelled' || b.status === 'canceled';

  const { paymentStatus, amountPaid } = derivePayment(b);
  // Use pre-summed breakdown for Booking.com multi-unit groups; parse normally otherwise
  const precomputedBreakdown = (b as Beds24Booking & {
    _commissionBreakdown?: { commissionAmount: number; paymentChargeAmount: number };
  })._commissionBreakdown;
  const { commissionAmount, paymentChargeAmount } = precomputedBreakdown
    ?? parseCommissionBreakdown(b.rateDescription ?? "", b.commission ?? 0);

  const linkedRooms = (b as Beds24Booking & { _linkedRooms?: string[] })._linkedRooms;
  const room = linkedRooms && linkedRooms.length > 0
    ? linkedRooms.join(" + ")
    : mapRoom(b.roomId);

  // Unallocated VR detection: the booking sits on a virtual roomId AND
  // mergeGroupedBookings didn't pair it with any physical sub. That's the
  // "Beds24 couldn't auto-allocate, manual intervention needed" state.
  // Once the operator transfers the booking, roomId switches to the
  // physical and this flag drops back to false automatically.
  const isUnallocatedVR =
    !isBlackout &&
    !isCancelled &&
    isVirtualRoomId(b.roomId) &&
    !(linkedRooms && linkedRooms.length > 0);

  const blackoutMeta = isBlackout ? parseBlackoutMeta(b.comments ?? '') : {};

  const channel = mapChannel(b.apiSource, b.referer, b.comments ?? "");
  // Rate plan — only for current+future OTA stays (no backfill). Blackouts skip.
  const rateType = isBlackout ? undefined : deriveRateType(b, channel);

  return {
    reservationNumber: `BH-${b.id}`,
    ...(isBlackout ? { isBlackout: true } : {}),
    ...(isUnallocatedVR ? { isUnallocatedVR: true } : {}),
    ...(blackoutMeta.createdBy ? { blackoutCreatedBy: blackoutMeta.createdBy } : {}),
    ...(blackoutMeta.reason ? { blackoutReason: blackoutMeta.reason } : {}),
    ...(b.modifiedTime ? { modifiedAt: b.modifiedTime } : {}),
    firstName: b.firstName ?? "",
    lastName: b.lastName ?? "",
    channel,
    room,
    ...(linkedRooms && linkedRooms.length > 1 ? { linkedRooms } : {}),
    checkInDate: b.arrival ?? "",
    checkOutDate: b.departure ?? "",
    reservationDate: b.bookingTime ? b.bookingTime.slice(0, 10) : "",
    bookingTimestamp: b.bookingTime ?? "",
    numberOfNights: nights,
    numberOfGuests: (b.numAdult ?? 0) + (b.numChild ?? 0),
    email: b.email ?? "",
    phone: b.phone ?? "",
    price: b.price ?? 0,
    // Prefer an explicit country code (country2 = most OTAs, country = Direct/
    // rental-site API bookings — often lowercase). countryFromCodeOrLang maps
    // language codes that OTAs (esp. Airbnb) wrongly drop into the country
    // field — e.g. "cs" → CZ — so they don't render as a broken flag. Final
    // fall back derives from phone prefix / language.
    nationality:
      countryFromCodeOrLang(b.country2) ||
      countryFromCodeOrLang(b.country) ||
      deriveNationality(b.phone || b.mobile || "", b.lang),
    // Cleaning: date-derived until cleaning app is connected.
    // Blackouts have no guest, no stay → no cleaning event needed; we still
    // set a value to satisfy the type, but renderers skip the field for blackouts.
    cleaningStatus: isBlackout ? "Completed" : deriveCleaningStatus(b.departure ?? ""),
    paymentStatus,
    amountPaid,
    commissionAmount,
    paymentChargeAmount,
    ...(rateType ? { rateType } : {}),
    ...(b.status ? { status: b.status } : {}),
    ...(isCancelled ? { isCancelled: true } : {}),
    // Locally managed — Redis will layer these in Phase 3
    additionalEmail: "",
    paymentStatusOverride: null,
    notes: "",
    manualFlagOverrides: {},
    ratingStatus: "none",
    syncedRating: null,
    invoiceData: null,
    invoiceStatus: "Not Issued",
  };
}

// ─── Fetch all pages from Beds24 with Redis-backed delta sync ────────────────
//
// Old behaviour: every /api/bookings call did a full year-back + year-forward
// fetch from Beds24. As history grows, that's an increasing amount of stable
// data being shuffled around on every sync.
//
// New behaviour:
//  1. First call (or cache miss / forced full sync): fetch the full window,
//     persist to Redis as a map<id, booking>.
//  2. Subsequent calls: fetch only bookings with `modifiedFrom = lastSync - 5min`
//     (5-minute overlap to dodge clock skew). Merge into the cached set.
//  3. After 24 h, force a full refresh as a safety net for any modifications
//     Beds24 might have missed flagging.
//  4. Prune bookings whose departure is more than 14 months in the past so
//     the cache stays bounded.
//  5. Caller can force a full refresh by calling with fullSync=true (used by
//     `?fullSync=true` query param on the GET endpoint).

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

const BOOKINGS_CACHE_KEY  = "baker:beds24-bookings-cache";
const BOOKINGS_LAST_SYNC_KEY = "baker:beds24-last-sync";
const DELTA_OVERLAP_MS    = 5 * 60 * 1000;        // 5 minutes
const MAX_DELTA_AGE_MS    = 24 * 60 * 60 * 1000;  // 24 hours
const MIN_SYNC_INTERVAL_MS = 90 * 1000;            // 90s — coalesce rapid auto-refetches (tab switches)
const PRUNE_DEPARTURE_MONTHS = 14;                 // keep ~1 year + 2-month buffer
const LIVE_REFRESH_LOOKBACK_DAYS = 60;             // covers monthly stays currently checked-in

// Statuses we want Beds24 to return in the live-window refresh. Crucially
// includes 'cancelled' — otherwise a guest cancellation never lands in our
// cache (Beds24's default response excludes cancelled bookings), the old
// confirmed copy lingers, and the dashboard shows a stale duplicate
// alongside the replacement booking.
const ALL_BOOKING_STATUSES = ['confirmed', 'new', 'request', 'cancelled', 'black'] as const;

/**
 * One paginated `/bookings` call with the given params. Beds24 V2's
 * pagination shape (per Swagger):
 *
 *   Response: { pages: { nextPageExists: boolean, nextPageLink: string }, data: [...] }
 *   Request:  ?page=N integer query parameter (page=1 implicit)
 *
 * The previous version looked for a non-existent `json.nextPageToken`
 * field and so always exited after page 1 — silently dropping every
 * subsequent page (Beds24 returns ~100 bookings per page). The full
 * year-back sync that should have returned ~hundreds of bookings was
 * returning only the first batch. This is what caused the operator's
 * "missing historical reservations" report on 2026-05-31.
 *
 * Belt-and-braces: cap iterations at 200 pages so a buggy response
 * (nextPageExists=true forever) can't lock the function up.
 */
async function paginateBookings(
  token: string,
  params: URLSearchParams,
): Promise<Beds24Booking[]> {
  const fetched: Beds24Booking[] = [];
  // Ask Beds24 to include channel info-items (rate plan, meal plan, …) so the
  // rate-type detector has a signal beyond rateDescription. Harmless if Beds24
  // ignores the param — the array simply stays absent.
  params.set("includeInfoItems", "true");
  const MAX_PAGES = 200; // defensive — Beds24's largest plausible page count for our scale
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    if (page > 1) params.set("page", String(page));
    else params.delete("page");

    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, {
      headers: { token },
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Beds24 ${res.status}: ${text}`);
    }
    const json = await res.json();
    const data: Beds24Booking[] = Array.isArray(json) ? json : (json.data ?? []);
    fetched.push(...data);

    // Beds24 wraps paginated responses in { pages, data, ... }. A bare-array
    // response is single-page by definition (no wrapper, no next-page flag).
    if (Array.isArray(json)) break;
    const pages = (json as { pages?: { nextPageExists?: boolean } }).pages;
    if (!pages?.nextPageExists) break;
  }
  return fetched;
}

async function fetchAllBookings(
  token: string,
  options: { fullSync?: boolean } = {},
): Promise<Beds24Booking[]> {
  const redis = getRedis();

  // ── Load cache ──
  let cached: Record<string, Beds24Booking> = {};
  let lastSync: string | null = null;
  if (redis) {
    const [cacheRaw, lastSyncRaw] = await Promise.all([
      redis.get<Record<string, Beds24Booking>>(BOOKINGS_CACHE_KEY),
      redis.get<string>(BOOKINGS_LAST_SYNC_KEY),
    ]);
    cached = cacheRaw ?? {};
    lastSync = lastSyncRaw;
  }

  // ── Decide full vs delta ──
  const cacheAgeMs = lastSync ? Date.now() - new Date(lastSync).getTime() : Infinity;
  const cacheEmpty = Object.keys(cached).length === 0;
  const useFullSync = options.fullSync || cacheEmpty || cacheAgeMs > MAX_DELTA_AGE_MS;

  // ── Min-sync-interval short-circuit ──
  // The dashboard unmounts/remounts each tab on switch, so every switch re-hits
  // this endpoint. Without a guard each one fired a delta + live-window round
  // trip against Beds24 — amplified across operators sharing this cache key, and
  // adding up fast against the credit-bucket rate limit. When the shared cache
  // was refreshed within the last MIN_SYNC_INTERVAL_MS and the caller didn't
  // force a full sync, serve the cached set and skip Beds24 entirely. Deliberate
  // refreshes (manual Sync / Retry buttons, phone-booking creation) pass
  // fullSync=true to bypass; cache-miss and >24h-stale paths already bypass via
  // useFullSync above.
  if (!useFullSync && cacheAgeMs < MIN_SYNC_INTERVAL_MS) {
    return Object.values(cached);
  }

  // ── Pass 1: full-window OR delta ──
  // (Same logic as before. Both passes write into `cached` by id.)
  const primaryParams = new URLSearchParams();
  if (useFullSync) {
    // Full window: 1 year back → 1 year forward (by arrival date). Wipes
    // cache first so a forced full sync drops anything Beds24 has actually
    // deleted.
    const from = new Date();
    from.setFullYear(from.getFullYear() - 1);
    const to = new Date();
    to.setFullYear(to.getFullYear() + 1);
    primaryParams.set("arrivalFrom", from.toISOString().slice(0, 10));
    primaryParams.set("arrivalTo", to.toISOString().slice(0, 10));
    // Include cancelled in the full sweep too so the cache carries the
    // correct status for any historically-cancelled booking we re-fetch.
    for (const s of ALL_BOOKING_STATUSES) primaryParams.append("status", s);
    cached = {};
  } else {
    // Delta: bookings modified since last sync (with safety overlap). Same
    // explicit status list — without this Beds24 omits cancelled bookings
    // from its response, so a guest cancellation never propagates here.
    const since = new Date(new Date(lastSync!).getTime() - DELTA_OVERLAP_MS);
    primaryParams.set("modifiedFrom", since.toISOString());
    for (const s of ALL_BOOKING_STATUSES) primaryParams.append("status", s);
  }
  const primaryFetched = await paginateBookings(token, primaryParams);
  for (const b of primaryFetched) {
    cached[String(b.id)] = b;
  }

  // ── Pass 2: live-window refresh (always runs) ──
  // Re-pulls every booking with arrival within the last LIVE_REFRESH_LOOKBACK_DAYS
  // days or in the future, including cancelled. The point is to guarantee
  // that any change affecting an upcoming or currently-checked-in
  // reservation is reflected — even if Beds24's modifiedFrom delta missed
  // flagging it. Bounded scope: only future-impact bookings, not the whole
  // 2-year window.
  //
  // We do this on EVERY sync (not just delta) because the failure mode the
  // operator hit — cancel-then-rebook ghosts — is specifically a cache
  // staleness problem, not a "first load" problem.
  if (!useFullSync) {
    const liveFrom = new Date();
    liveFrom.setDate(liveFrom.getDate() - LIVE_REFRESH_LOOKBACK_DAYS);
    const liveTo = new Date();
    liveTo.setFullYear(liveTo.getFullYear() + 1);
    const liveParams = new URLSearchParams();
    liveParams.set("arrivalFrom", liveFrom.toISOString().slice(0, 10));
    liveParams.set("arrivalTo", liveTo.toISOString().slice(0, 10));
    for (const s of ALL_BOOKING_STATUSES) liveParams.append("status", s);
    const liveFetched = await paginateBookings(token, liveParams);
    for (const b of liveFetched) {
      cached[String(b.id)] = b;
    }
  }

  // ── Prune very old + persist ──
  // Anything whose departure is more than PRUNE_DEPARTURE_MONTHS ago.
  const pruneCutoff = new Date();
  pruneCutoff.setMonth(pruneCutoff.getMonth() - PRUNE_DEPARTURE_MONTHS);
  const pruneCutoffStr = pruneCutoff.toISOString().slice(0, 10);
  for (const [id, b] of Object.entries(cached)) {
    if (b.departure && b.departure < pruneCutoffStr) {
      delete cached[id];
    }
  }

  if (redis) {
    await Promise.all([
      redis.set(BOOKINGS_CACHE_KEY, cached),
      redis.set(BOOKINGS_LAST_SYNC_KEY, new Date().toISOString()),
    ]);
  }

  return Object.values(cached);
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
