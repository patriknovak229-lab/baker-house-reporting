/**
 * POST /api/bookings/relocate — manually move ONE reservation to another
 * physical room (admin/super). This is the operator's free-form move for
 * maintenance and ad-hoc situations — distinct from the within-type
 * unallocated resolver (`/api/bookings/move`):
 *   - target may be ANY physical unit (cross-type allowed),
 *   - an in-house guest MAY be moved (that's a normal maintenance case),
 *   - the target is normally required to be FREE for the stay's dates.
 *
 * `allowOccupied: true` is the operator's explicit override of that last rule.
 * It exists because a multi-step reshuffle has no legal first step: swapping two
 * guests, or rotating three, means every individual move lands on an occupied
 * unit until the last one completes. Rather than force the operator into Beds24
 * mid-sequence, we let them push through a KNOWN, temporary double-booking. The
 * conflicts are still computed and returned, recorded on the move notice, and
 * called out in the Telegram alert — the override skips the rejection, not the
 * check. Transactions' existing same-room-conflict banner then keeps shouting
 * until the sequence is finished.
 *
 * Body: { reservationNumber, toRoom, reason?, allowOccupied? }
 * Returns: { ok, from, to, inHouse, forced, conflicts }.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import { physicalRoomIdForName, physicalRoomName } from "@/utils/roomAllocation";
import { pragueToday } from "@/utils/periodUtils";
import { recordRoomMoves, roomMoveId } from "@/data-access/roomMoves";
import type { RoomMoveConflict } from "@/lib/db/schema/roomMoves";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

interface Beds24Booking {
  id: number;
  roomId: number;
  arrival: string;
  departure: string;
  status: string;
  firstName?: string;
  lastName?: string;
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

  let body: { reservationNumber?: string; toRoom?: string; reason?: string; allowOccupied?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookingId = Number(String(body.reservationNumber ?? "").replace(/^BH-/, ""));
  const toRoom = body.toRoom?.trim() ?? "";
  const toRoomId = physicalRoomIdForName(toRoom);
  const allowOccupied = body.allowOccupied === true;

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

  // Prague day, matching the resolver (`/api/bookings/move`) — a UTC date can
  // read as "yesterday" for the first two hours of a Prague day in summer and
  // silently mislabel an arriving guest as not yet in-house.
  const today = pragueToday();
  const inHouse = booking.arrival <= today && booking.departure > today;
  const fromRoom = physicalRoomName(booking.roomId) ?? `room ${booking.roomId}`;

  // ── Is the target free for the stay? ──
  // Always computed. Only the REACTION to a conflict depends on allowOccupied:
  // reject by default, record-and-continue when the operator has overridden.
  let conflicts: RoomMoveConflict[] = [];
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
    conflicts = asArray(await res.json())
      .filter((b) => b.id !== bookingId && overlaps(b, booking!))
      .map((b) => ({ reservationNumber: `BH-${b.id}`, arrival: b.arrival, departure: b.departure }));
  } catch (err) {
    // An unreadable availability check is never waved through, override or not:
    // "I accept a conflict I can see" is a different decision from "move blind".
    return NextResponse.json({ error: err instanceof Error ? err.message : "Availability check failed" }, { status: 502 });
  }

  if (conflicts.length > 0 && !allowOccupied) {
    const c = conflicts[0];
    return NextResponse.json(
      {
        error: `${toRoom} is occupied ${c.arrival}→${c.departure} (booking ${c.reservationNumber}). Pick a free room, or tick "Ignore occupied" to stack the move anyway.`,
        conflicts,
      },
      { status: 409 },
    );
  }
  const forced = conflicts.length > 0;

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

  const guestName = `${booking.firstName ?? ""} ${booking.lastName ?? ""}`.trim();

  // Operator-facing notice — persists until someone dismisses it.
  await recordRoomMoves([
    {
      id: roomMoveId(String(bookingId)),
      reservationNumber: `BH-${bookingId}`,
      guestName: guestName || null,
      fromRoom,
      toRoom,
      checkInDate: booking.arrival,
      checkOutDate: booking.departure,
      movedBy: guard.email,
      source: "manual",
      inHouse,
      forced,
      conflicts: forced ? conflicts : null,
      reason: body.reason?.trim() || null,
    },
  ]);

  await sendTelegram(
    [
      `🚪 <b>Room move</b>`,
      `#${bookingId}: ${fromRoom} → ${toRoom}`,
      inHouse ? "⚠️ guest is currently in-house" : "",
      forced
        ? `🚨 FORCED onto an occupied unit — ${toRoom} still holds ${conflicts
            .map((c) => `${c.reservationNumber} (${c.arrival}→${c.departure})`)
            .join(", ")}. Finish the reshuffle.`
        : "",
      body.reason ? `🗒 ${body.reason}` : "",
      `👤 by ${guard.email}`,
    ].filter(Boolean).join("\n"),
  );

  return NextResponse.json({ ok: true, from: fromRoom, to: toRoom, inHouse, forced, conflicts });
}
