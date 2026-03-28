import { NextRequest, NextResponse } from "next/server";
import type { Reservation, Channel, Room, CleaningStatus } from "@/types/reservation";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

// ─── Room mapping ──────────────────────────────────────────────────────────────
// Map Beds24 unitId → your Room name.
// To find your unit IDs: hit /api/bookings?raw=true and look at the `roomId` field.
const UNIT_MAP: Record<number, Room> = {
  // TODO: fill in after first raw response
  // 12345: "Apartment 101",
  // 12346: "Apartment 202",
  // 12347: "Apartment 303",
};

// ─── Channel mapping ───────────────────────────────────────────────────────────
function mapChannel(raw = ""): Channel {
  const lower = raw.toLowerCase();
  if (lower.includes("booking")) return "Booking.com";
  if (lower.includes("airbnb")) return "Airbnb";
  return "Direct";
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
function mapRoom(unitId: number, roomName?: string): Room {
  if (UNIT_MAP[unitId]) return UNIT_MAP[unitId];
  // Fallback: try to match by name pattern
  const name = roomName ?? "";
  if (name.includes("101")) return "Apartment 101";
  if (name.includes("202")) return "Apartment 202";
  if (name.includes("303")) return "Apartment 303";
  return "Apartment 101"; // last resort
}

// ─── Cleaning status (date-based until cleaning app is wired) ──────────────────
function deriveCleaningStatus(checkOut: string): CleaningStatus {
  const today = new Date().toISOString().slice(0, 10);
  return checkOut < today ? "Completed" : "Pending";
}

// ─── Beds24 V2 booking shape ───────────────────────────────────────────────────
// Field names based on Beds24 V2 REST API.
// If fields come back undefined, hit /api/bookings?raw=true to inspect the real shape.
interface Beds24Booking {
  id: number;
  roomId: number;
  roomName?: string;
  checkIn: string;      // YYYY-MM-DD
  checkOut: string;     // YYYY-MM-DD
  numAdult: number;
  numChild: number;
  price: number;        // total in property currency
  guestFirstName: string;
  guestLastName: string;
  guestEmail: string;
  guestPhone: string;
  guestCountry: string; // ISO 2-letter
  channel: string;      // booking source
  created: string;      // ISO timestamp
  status: string;       // "confirmed" | "cancelled" | ...
}

// ─── Map Beds24 booking → our Reservation type ────────────────────────────────
function mapToReservation(b: Beds24Booking): Reservation {
  const nights =
    b.checkIn && b.checkOut
      ? Math.round(
          (new Date(b.checkOut).getTime() - new Date(b.checkIn).getTime()) / 86_400_000
        )
      : 0;

  return {
    reservationNumber: `BH-${b.id}`,
    firstName: b.guestFirstName ?? "",
    lastName: b.guestLastName ?? "",
    channel: mapChannel(b.channel),
    room: mapRoom(b.roomId, b.roomName),
    checkInDate: b.checkIn ?? "",
    checkOutDate: b.checkOut ?? "",
    reservationDate: b.created ? b.created.slice(0, 10) : "",
    numberOfNights: nights,
    numberOfGuests: (b.numAdult ?? 0) + (b.numChild ?? 0),
    email: b.guestEmail ?? "",
    phone: b.guestPhone ?? "",
    price: b.price ?? 0,
    nationality: (b.guestCountry ?? "").toUpperCase(),
    // Cleaning: date-derived until cleaning app is connected
    cleaningStatus: deriveCleaningStatus(b.checkOut ?? ""),
    // Payment: defaults until Stripe is connected
    paymentStatus: "Unpaid",
    amountPaid: 0,
    // Locally managed — Redis will layer these in Phase 3
    notes: "",
    manualFlagOverrides: {},
    ratingStatus: "none",
    invoiceData: null,
    invoiceStatus: "Not Issued",
  };
}

// ─── Fetch all pages from Beds24 ──────────────────────────────────────────────
async function fetchAllBookings(accessToken: string): Promise<Beds24Booking[]> {
  const all: Beds24Booking[] = [];

  // 1 year back → 1 year forward
  const from = new Date();
  from.setFullYear(from.getFullYear() - 1);
  const to = new Date();
  to.setFullYear(to.getFullYear() + 1);

  const params = new URLSearchParams({
    checkInFrom: from.toISOString().slice(0, 10),
    checkInTo: to.toISOString().slice(0, 10),
  });

  let pageToken: string | undefined;
  do {
    if (pageToken) params.set("pageToken", pageToken);

    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
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

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const token = process.env.BEDS24_API_KEY;
  if (!token) {
    return NextResponse.json({ error: "BEDS24_API_KEY not set" }, { status: 500 });
  }

  try {
    const raw = await fetchAllBookings(token);

    // ?raw=true → return raw Beds24 response for debugging field names / unit IDs
    if (req.nextUrl.searchParams.get("raw") === "true") {
      return NextResponse.json(raw);
    }

    const reservations = raw
      .filter((b) => b.status !== "cancelled")
      .map(mapToReservation);

    return NextResponse.json(reservations);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
