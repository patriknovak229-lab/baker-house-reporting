import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import type { Reservation, Channel, Room, CleaningStatus, PaymentStatus } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";

const BEDS24_API_BASE = "https://beds24.com/api/v2";
const ADDITIONAL_PAYMENTS_KEY = "baker:additional-payments";

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
    if (ap.status !== "paid" || typeof ap.stripeFeeCzk !== "number") continue;
    feeByRes.set(ap.reservationNumber, (feeByRes.get(ap.reservationNumber) ?? 0) + ap.stripeFeeCzk);
  }

  if (feeByRes.size === 0) return reservations;

  return reservations.map((r) => {
    const fee = feeByRes.get(r.reservationNumber);
    if (!fee) return r;
    return { ...r, paymentChargeAmount: r.paymentChargeAmount + fee };
  });
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
// Derived from raw response inspection. Confirm in Beds24 → Properties → Rooms.
const UNIT_MAP: Record<number, Room> = {
  656437: "K.201",
  648596: "K.202",
  648772: "K.203",
  674672: "O.308",
};

// ─── Channel mapping ───────────────────────────────────────────────────────────
// Beds24 sets `apiSource` to:
//   - "Booking.com" / "Airbnb" — channel-manager bookings (OTAs)
//   - "API"                    — bookings POSTed via Beds24 V2 API. Two known origins:
//        a) our /api/bookings POST (manual phone bookings) — sets referer="PhoneDirect"
//        b) rental site bakerhouseapartments.cz — sets referer with "web"/"DirectWeb"
//   - "Direct" / blank         — legacy / manually created in Beds24 UI
//
// We classify by referer first (most specific), then fall back on apiSource.
// API-source bookings without a referer hint default to Direct-Web — the
// rental site is the dominant API source we don't author ourselves.
function mapChannel(apiSource = "", referer = ""): Channel {
  if (apiSource === "Booking.com") return "Booking.com";
  if (apiSource === "Airbnb") return "Airbnb";

  const ref = referer.toLowerCase();
  if (ref.includes("phone")) return "Direct-Phone";
  if (ref.includes("web"))   return "Direct-Web";

  // No referer hint — bookings POSTed via Beds24 API (rental site, third-party
  // integration, etc.) default to Direct-Web. Manually-created Beds24 UI
  // bookings (apiSource blank/"Direct") fall through to "Direct".
  if (apiSource === "API") return "Direct-Web";

  return "Direct";
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
function mapRoom(roomId: number): Room {
  return UNIT_MAP[roomId] ?? "K.202";
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
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country2: string | null; // uppercase ISO 2-letter (e.g. "CZ", "UA")
  apiSource: string;      // "Booking.com" | "Airbnb" | "API" (V2 POST) | "Direct" (Beds24 UI) | ""
  referer: string;        // e.g. "PhoneDirect" (our app), "DirectWeb" (rental site), or empty
  bookingTime: string;    // ISO timestamp
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

  return [...manualResults, ...result];
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

// ─── Map Beds24 booking → our Reservation type ────────────────────────────────
function mapToReservation(b: Beds24Booking): Reservation {
  const nights =
    b.arrival && b.departure
      ? Math.round(
          (new Date(b.departure).getTime() - new Date(b.arrival).getTime()) / 86_400_000
        )
      : 0;

  const isBlackout = b.status === 'black';

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

  const blackoutMeta = isBlackout ? parseBlackoutMeta(b.comments ?? '') : {};

  return {
    reservationNumber: `BH-${b.id}`,
    ...(isBlackout ? { isBlackout: true } : {}),
    ...(blackoutMeta.createdBy ? { blackoutCreatedBy: blackoutMeta.createdBy } : {}),
    ...(blackoutMeta.reason ? { blackoutReason: blackoutMeta.reason } : {}),
    firstName: b.firstName ?? "",
    lastName: b.lastName ?? "",
    channel: mapChannel(b.apiSource, b.referer),
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
    nationality: (b.country2 ?? "").toUpperCase(),
    // Cleaning: date-derived until cleaning app is connected.
    // Blackouts have no guest, no stay → no cleaning event needed; we still
    // set a value to satisfy the type, but renderers skip the field for blackouts.
    cleaningStatus: isBlackout ? "Completed" : deriveCleaningStatus(b.departure ?? ""),
    paymentStatus,
    amountPaid,
    commissionAmount,
    paymentChargeAmount,
    // Locally managed — Redis will layer these in Phase 3
    additionalEmail: "",
    paymentStatusOverride: null,
    notes: "",
    manualFlagOverrides: {},
    ratingStatus: "none",
    invoiceData: null,
    invoiceStatus: "Not Issued",
  };
}

// ─── Fetch all pages from Beds24 ──────────────────────────────────────────────
async function fetchAllBookings(token: string): Promise<Beds24Booking[]> {
  const all: Beds24Booking[] = [];

  // 1 year back → 1 year forward
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 1);

  const params = new URLSearchParams({
    arrivalFrom: from.toISOString().slice(0, 10),
    arrivalTo: to.toISOString().slice(0, 10),
  });

  let pageToken: string | undefined;
  do {
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, {
      headers: { token },
      cache: "no-store",
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Beds24 ${res.status}: ${text}`);
    }

    const json = await res.json();
    const page: Beds24Booking[] = Array.isArray(json) ? json : (json.data ?? []);
    all.push(...page);
    pageToken = Array.isArray(json) ? undefined : json.nextPageToken;
  } while (pageToken);

  return all;
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
  const { roomId, arrival, departure, numAdult, numChild, firstName, lastName, email, phone, price, notes } = body;

  if (!roomId || !arrival || !departure || !firstName) {
    return NextResponse.json({ error: "roomId, arrival, departure and firstName are required" }, { status: 400 });
  }

  const booking = {
    roomId: Number(roomId),
    status: "confirmed",
    arrival,
    departure,
    numAdult: numAdult ?? 1,
    numChild: numChild ?? 0,
    firstName,
    lastName: lastName ?? "",
    email: email ?? "",
    phone: phone ?? "",
    // "PhoneDirect" referer is what mapChannel() detects to label the
    // booking as "Direct-Phone" in the reporting app — distinguishes
    // operator-created bookings from rental-site "DirectWeb" ones.
    referer: "PhoneDirect",
    apiSource: "Direct",
    comments: notes ?? "",
    // Top-level price field — shown in Beds24 UI and read by the reporting app
    price: price ? Number(price) : 0,
    // invoiceItems creates the charge line item in Beds24 invoicing
    invoiceItems: price
      ? [{ type: "charge", subType: 1, description: "Accommodation", qty: 1, amount: Number(price) }]
      : [],
  };

  const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
    method: "POST",
    headers: { token, "Content-Type": "application/json" },
    body: JSON.stringify([booking]),
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text();
    return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: res.status });
  }

  const json = await res.json();
  return NextResponse.json({ ok: true, data: json });
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
    const raw = await fetchAllBookings(token);

    // ?raw=true → return raw Beds24 response for debugging
    if (req.nextUrl.searchParams.get("raw") === "true") {
      return NextResponse.json(raw);
    }

    // ?debugId=<id> → return raw fields for a single booking (masterid diagnosis)
    const debugId = req.nextUrl.searchParams.get("debugId");
    if (debugId) {
      const booking = raw.find((b) => b.id === Number(debugId));
      return NextResponse.json(booking ?? { error: `Booking ${debugId} not found in fetched set` });
    }

    const reservations = mergeGroupedBookings(
      raw.filter((b) => b.status !== "cancelled" && b.status !== "canceled")
    ).map(mapToReservation);

    const withStripeFees = await aggregateStripeFees(reservations);
    return NextResponse.json(withStripeFees);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
