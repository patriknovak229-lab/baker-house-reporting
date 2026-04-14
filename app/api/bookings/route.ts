import { NextRequest, NextResponse } from "next/server";
import type { Reservation, Channel, Room, CleaningStatus, PaymentStatus } from "@/types/reservation";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

// ─── Room mapping ──────────────────────────────────────────────────────────────
// Derived from raw response inspection. Confirm in Beds24 → Properties → Rooms.
const UNIT_MAP: Record<number, Room> = {
  656437: "K.201",
  648596: "K.202",
  648772: "K.203",
};

// ─── Channel mapping ───────────────────────────────────────────────────────────
// referer "PhoneDirect." means reservation came via phone/email, not web checkout.
function mapChannel(apiSource = "", referer = ""): Channel {
  if (apiSource === "Booking.com") return "Booking.com";
  if (apiSource === "Airbnb") return "Airbnb";
  if (referer.toLowerCase().includes("phone")) return "Direct-Phone";
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
  apiSource: string;      // "Booking.com" | "Airbnb" | "Direct"
  referer: string;        // e.g. "PhoneDirect." for phone/email bookings
  bookingTime: string;    // ISO timestamp
  status: string;         // "new" | "confirmed" | "cancelled"
  comments: string;       // contains "PRE-PAID" for prepaid reservations
}

// ─── Parse channel fee breakdown from rateDescription ────────────────────────
// Booking.com format: "Total Commission: 404.07\nPayment Charge: 47.06\n"
// Airbnb format:      "Host Fee -1635.93 CZK\n"
// Fallback:           use top-level commission field as a single total
function parseCommissionBreakdown(
  rateDescription: string,
  totalCommission: number
): { commissionAmount: number; paymentChargeAmount: number } {
  const commMatch = rateDescription?.match(/Total Commission:\s*([\d.]+)/);
  const feeMatch  = rateDescription?.match(/Payment Charge:\s*([\d.]+)/);
  if (commMatch && feeMatch) {
    return {
      commissionAmount: parseFloat(commMatch[1]),
      paymentChargeAmount: parseFloat(feeMatch[1]),
    };
  }
  const hostFeeMatch = rateDescription?.match(/Host Fee\s*-?([\d.]+)/);
  if (hostFeeMatch) {
    return { commissionAmount: parseFloat(hostFeeMatch[1]), paymentChargeAmount: 0 };
  }
  // Fallback: expose the top-level total with no payment-charge split
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
        merged.price      = (merged.price      ?? 0) + siblings.reduce((s, r) => s + (r.price      ?? 0), 0);
        merged.commission = (merged.commission ?? 0) + siblings.reduce((s, r) => s + (r.commission ?? 0), 0);
        merged.deposit    = (merged.deposit    ?? 0) + siblings.reduce((s, r) => s + (r.deposit    ?? 0), 0);
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
          b.price      = (b.price      ?? 0) + subs.reduce((s, r) => s + (r.price      ?? 0), 0);
          b.commission = (b.commission ?? 0) + subs.reduce((s, r) => s + (r.commission ?? 0), 0);
          b.deposit    = (b.deposit    ?? 0) + subs.reduce((s, r) => s + (r.deposit    ?? 0), 0);
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
      base.price      = subs.reduce((s, r) => s + (r.price      ?? 0), 0);
      base.commission = subs.reduce((s, r) => s + (r.commission ?? 0), 0);
      base.deposit    = subs.reduce((s, r) => s + (r.deposit    ?? 0), 0);
    }
    result.push(base);
  }

  return [...manualResults, ...result];
}

// ─── Map Beds24 booking → our Reservation type ────────────────────────────────
function mapToReservation(b: Beds24Booking): Reservation {
  const nights =
    b.arrival && b.departure
      ? Math.round(
          (new Date(b.departure).getTime() - new Date(b.arrival).getTime()) / 86_400_000
        )
      : 0;

  const { paymentStatus, amountPaid } = derivePayment(b);
  const { commissionAmount, paymentChargeAmount } = parseCommissionBreakdown(
    b.rateDescription ?? "",
    b.commission ?? 0
  );

  const linkedRooms = (b as Beds24Booking & { _linkedRooms?: string[] })._linkedRooms;
  const room = linkedRooms && linkedRooms.length > 0
    ? linkedRooms.join(" + ")
    : mapRoom(b.roomId);

  return {
    reservationNumber: `BH-${b.id}`,
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
    // Cleaning: date-derived until cleaning app is connected
    cleaningStatus: deriveCleaningStatus(b.departure ?? ""),
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
    referer: "Direct",
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

    return NextResponse.json(reservations);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
