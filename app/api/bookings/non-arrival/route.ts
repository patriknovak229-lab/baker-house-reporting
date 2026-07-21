/**
 * POST /api/bookings/non-arrival — cancel + channel-lock a booking in Beds24 so
 * its nights free up for resale, WITHOUT cancelling on the OTA (the guest stays
 * booked and charged per the channel). This is the automated version of the
 * operator's manual "set status = Cancelled + Allow Channel Modifications = No"
 * step in the Beds24 UI.
 *
 * The non-arrival FLAG and the editable net price live in our overrides
 * (`baker:reservation-overrides`, written client-side via /api/local-state).
 * This endpoint performs ONLY the Beds24 mutation.
 *
 * Body: { reservationNumber: "BH-<id>" }
 * Auth: admin / super only — this mutates a real Beds24 booking.
 *
 * ⚠ allowChannelUpdate="none" is Beds24's "block all channel modifications"
 * (so a later channel sync can't reinstate our cancel and re-block the room).
 * Verify this behaves as expected on THIS account by testing one booking before
 * relying on it for all operators.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

// Beds24 v2 booking field. "none" = block ALL channel modifications from
// overriding our local change (UI equivalent: "Allow Channel Modifications = No").
const LOCK_CHANNEL_UPDATE = "none";

interface Beds24Booking {
  id: number;
  status: string;
  arrival: string;
  departure: string;
}

function asArray(json: unknown): Beds24Booking[] {
  if (Array.isArray(json)) return json as Beds24Booking[];
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Beds24Booking[]) : [];
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

  let body: { reservationNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bookingId = Number(String(body.reservationNumber ?? "").replace(/^BH-/, ""));
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return NextResponse.json(
      { error: `Bad reservation number: ${body.reservationNumber}` },
      { status: 400 },
    );
  }

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auth error" },
      { status: 500 },
    );
  }

  // ── Confirm the booking exists (live) before mutating ──
  const idParams = new URLSearchParams();
  idParams.append("id", String(bookingId));
  for (const s of ["confirmed", "new", "request", "cancelled", "black"]) idParams.append("status", s);
  let booking: Beds24Booking | undefined;
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${idParams}`, {
      headers: { token },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    booking = asArray(await res.json()).find((b) => b.id === bookingId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Lookup failed" },
      { status: 502 },
    );
  }
  if (!booking) {
    return NextResponse.json({ error: `Booking ${bookingId} not found` }, { status: 404 });
  }
  if (booking.status === "black") {
    return NextResponse.json({ error: "Blackouts can't be marked as non-arrival" }, { status: 409 });
  }

  // ── Execute: cancel + lock the channel in a single POST ──
  // (Idempotent: re-running on an already-cancelled booking just re-asserts the lock.)
  const payload = [{ id: bookingId, status: "cancelled", allowChannelUpdate: LOCK_CHANNEL_UPDATE }];
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
      method: "POST",
      headers: { token, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `Beds24 ${res.status}: ${text}` }, { status: 502 });
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const rows = asArray(json) as Array<{ success?: boolean; errors?: unknown }>;
    const failed = rows.find((r) => r && r.success === false);
    if (failed) {
      return NextResponse.json(
        { error: `Beds24 rejected the cancel: ${JSON.stringify(failed)}` },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Beds24 cancel failed" },
      { status: 502 },
    );
  }

  await sendTelegram(
    [
      `🚨 <b>Non-arrival — booking freed in Beds24</b>`,
      `#${bookingId} · ${booking.arrival} → ${booking.departure}`,
      `Cancelled + channel-locked (guest still booked on the OTA).`,
      `👤 by ${guard.email}`,
    ].join("\n"),
  );

  return NextResponse.json({ ok: true, bookingId, status: "cancelled", channelLocked: true });
}
