import { NextRequest, NextResponse } from "next/server";
import type { Reservation, Channel, Room, CleaningStatus, PaymentStatus } from "@/types/reservation";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

// ─── Room mapping ──────────────────────────────────────────────────────────────
// Derived from raw response inspection. Confirm in Beds24 → Properties → Rooms.
const UNIT_MAP: Record<number, Room> = {
  656437: "K.201 (2BR)",
  648596: "K.202 (1BR)",
  648772: "K.203 (1BR)",
};

// ─── Channel mapping ───────────────────────────────────────────────────────────
// Beds24 apiSource already returns the display name we need.
function mapChannel(apiSource = ""): Channel {
  if (apiSource === "Booking.com") return "Booking.com";
  if (apiSource === "Airbnb") return "Airbnb";
  return "Direct";
}

// ─── Room mapping ──────────────────────────────────────────────────────────────
function mapRoom(roomId: number): Room {
  return UNIT_MAP[roomId] ?? "K.202 (1BR)";
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
  arrival: string;      // YYYY-MM-DD (check-in)
  departure: string;    // YYYY-MM-DD (check-out)
  numAdult: number;
  numChild: number;
  price: number;        // total in CZK
  deposit: number;      // amount received/recorded in Beds24 (bank transfer, etc.)
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  country2: string | null; // uppercase ISO 2-letter (e.g. "CZ", "UA")
  apiSource: string;    // "Booking.com" | "Airbnb" | "Direct"
  bookingTime: string;  // ISO timestamp
  status: string;       // "new" | "confirmed" | "cancelled"
  comments: string;     // contains "PRE-PAID" for prepaid reservations
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

  return {
    reservationNumber: `BH-${b.id}`,
    firstName: b.firstName ?? "",
    lastName: b.lastName ?? "",
    channel: mapChannel(b.apiSource),
    room: mapRoom(b.roomId),
    checkInDate: b.arrival ?? "",
    checkOutDate: b.departure ?? "",
    reservationDate: b.bookingTime ? b.bookingTime.slice(0, 10) : "",
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
    // Locally managed — Redis will layer these in Phase 3
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

// ─── Route handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  const token = process.env.BEDS24_API_KEY;
  if (!token) {
    return NextResponse.json({ error: "BEDS24_API_KEY not set" }, { status: 500 });
  }

  try {
    const raw = await fetchAllBookings(token);

    // ?raw=true → return raw Beds24 response for debugging
    if (req.nextUrl.searchParams.get("raw") === "true") {
      return NextResponse.json(raw);
    }

    const reservations = raw
      .filter((b) => b.status !== "cancelled" && b.status !== "canceled")
      .map(mapToReservation);

    return NextResponse.json(reservations);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
