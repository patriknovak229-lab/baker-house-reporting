/**
 * POST /api/bookings/relocate — manually move ONE reservation to another
 * physical room (admin/super). This is the operator's free-form move for
 * maintenance and ad-hoc situations — distinct from the within-type
 * unallocated resolver (`/api/bookings/move`):
 *   - target may be ANY physical unit (cross-type allowed),
 *   - an in-house guest MAY be moved (that's a normal maintenance case),
 *   - but the target must be FREE for the stay's dates — we never create a
 *     double-booking here (occupied targets are rejected, not forced).
 *
 * Body: { reservationNumber, toRoom, reason? }
 * Returns: { ok, from, to, inHouse }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import { physicalRoomIdForName, physicalRoomName } from "@/utils/roomAllocation";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

interface Beds24Booking {
  id: number;
  roomId: number;
  arrival: string;
  departure: string;
  status: string;
}

function asArray(json: unknown): Beds24Booking[] {
  if (Array.isArray(json)) return json as Beds24Booking[];
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Beds24Booking[]) : [];
}

function overlaps(a: { arrival: string; departure: string }, b: { arrival: string; departure: string }): boolean {
  return a.arrival < b.departure && b.arrival < a.departure;
}

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
  }).catch(() => null);
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: { reservationNumber?: string; toRoom?: string; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookingId = Number(String(body.reservationNumber ?? "").replace(/^BH-/, ""));
  const toRoom = body.toRoom?.trim() ?? "";
  const toRoomId = physicalRoomIdForName(toRoom);

  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return NextResponse.json({ error: "Valid reservationNumber is required" }, { status: 400 });
  }
  if (toRoomId === null) {
    return NextResponse.json({ error: `"${toRoom}" is not a known room` }, { status: 400 });
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Auth error" }, { status: 500 });
  }

  // ── Look up the booking (live) ──
  let booking: Beds24Booking | undefined;
  try {
    const params = new URLSearchParams();
    params.append("id", String(bookingId));
    for (const s of ["confirmed", "new", "request", "cancelled"]) params.append("status", s);
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: "no-store" });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    booking = asArray(await res.json()).find((b) => b.id === bookingId);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Lookup failed" }, { status: 502 });
  }

  if (!booking) return NextResponse.json({ error: `Booking ${bookingId} not found` }, { status: 404 });
  if (booking.status === "cancelled") {
    return NextResponse.json({ error: `Booking ${bookingId} is cancelled` }, { status: 409 });
  }
  if (booking.roomId === toRoomId) {
    return NextResponse.json({ error: `Booking is already in ${toRoom}` }, { status: 409 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const inHouse = booking.arrival <= today && booking.departure > today;
  const fromRoom = physicalRoomName(booking.roomId) ?? `room ${booking.roomId}`;

  // ── Target must be free for the stay (no accidental double-booking) ──
  try {
    const from = new Date(booking.arrival + "T00:00:00Z");
    from.setUTCDate(from.getUTCDate() - 60); // back-buffer to catch long stays starting earlier
    const params = new URLSearchParams();
    params.append("roomId", String(toRoomId));
    params.set("arrivalFrom", from.toISOString().slice(0, 10));
    params.set("arrivalTo", booking.departure);
    for (const s of ["confirmed", "new", "request", "black"]) params.append("status", s);
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: "no-store" });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    const conflict = asArray(await res.json()).find((b) => b.id !== bookingId && overlaps(b, booking!));
    if (conflict) {
      return NextResponse.json(
        {
          error: `${toRoom} is occupied ${conflict.arrival}→${conflict.departure} (booking ${conflict.id}). Pick a free room or resolve in Beds24.`,
        },
        { status: 409 },
      );
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Availability check failed" }, { status: 502 });
  }

  // ── Execute the move ──
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
      method: "POST",
      headers: { token, "Content-Type": "application/json" },
      body: JSON.stringify([{ id: bookingId, roomId: toRoomId }]),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: 502 });
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = null; }
    const failed = asArray(json).find((r) => (r as { success?: boolean }).success === false);
    if (failed) return NextResponse.json({ error: `Beds24 rejected the move: ${JSON.stringify(failed)}` }, { status: 502 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Beds24 move failed" }, { status: 502 });
  }

  await sendTelegram(
    [
      `🚪 <b>Room move</b>`,
      `#${bookingId}: ${fromRoom} → ${toRoom}`,
      inHouse ? "⚠️ guest is currently in-house" : "",
      body.reason ? `🗒 ${body.reason}` : "",
      `👤 by ${guard.email}`,
    ].filter(Boolean).join("\n"),
  );

  return NextResponse.json({ ok: true, from: fromRoom, to: toRoom, inHouse });
}
