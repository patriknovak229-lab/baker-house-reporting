/**
 * POST /api/bookings/shorten — cut nights off a booking that is still going
 * ahead, so the freed nights go back on sale immediately.
 *
 * The use case: the guest asks to drop a night (arrive later or leave earlier)
 * and wants that night's money back. Three things have to happen; this endpoint
 * does the first two:
 *   1. the booking's dates move in Beds24,
 *   2. the trimmed nights become vacant and sellable again (automatic — Beds24
 *      frees availability the moment the dates shrink),
 *   3. the price is adjusted by hand in Beds24 by the operator, because the
 *      refund is what was agreed with the guest, not what a rate says. Beds24
 *      deliberately does NOT recalculate the price on a date change, so nothing
 *      here touches `price`, invoice items or payments.
 *
 * This is NOT a non-arrival (`/api/bookings/non-arrival`), which cancels the
 * whole booking while still charging for it, and NOT a partial platform refund
 * (drawer-only), which hands money back without moving the dates.
 *
 * Body: {
 *   reservationNumber: "BH-<id>",
 *   arrival:   "YYYY-MM-DD",   // new check-in  (unchanged if only the tail moves)
 *   departure: "YYYY-MM-DD",   // new check-out (unchanged if only the front moves)
 *   lockChannel?: boolean,     // block channel updates from restoring the old dates
 *   reason?: string,
 * }
 * Auth: admin / super only — this mutates a real Beds24 booking.
 *
 * Safety:
 *   - trim only, re-validated against LIVE Beds24 dates (see utils/stayShorten),
 *   - never a cancelled booking, a blackout, or a stay whose arrival has passed
 *     (an in-house guest can still leave early — only the departure may move),
 *   - package/virtual-room bookings are moved as a GROUP, so a two-room stay
 *     can't end up with one room shortened and the other not.
 *
 * `lockChannel` sets Beds24's `allowChannelUpdate: "none"` (UI: "Allow Channel
 * Modifications = No"). The OTA still holds the original reservation — it isn't
 * told about the change — so without the lock its next sync can push the
 * original dates back and re-block a night we may already have resold. The
 * trade-off is that genuine channel-side changes (including a cancellation)
 * stop reaching Beds24 for this booking until the lock is lifted there.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import { pragueToday } from "@/utils/periodUtils";
import { planShortening, describeShortening, nightsLabel } from "@/utils/stayShorten";
import { getRedis } from "@/utils/beds24Reservations";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

/** Same key as utils/beds24Reservations — patched here so the shortened dates
 *  show on the next dashboard read instead of waiting out the 90s sync guard. */
const BOOKINGS_CACHE_KEY = "baker:beds24-bookings-cache";

/** Beds24's "block all channel modifications" — see the header note. */
const LOCK_CHANNEL_UPDATE = "none";

interface Beds24Booking {
  id: number;
  roomId: number;
  arrival: string;
  departure: string;
  status: string;
  firstName?: string;
  lastName?: string;
  apiSource?: string;
  bookingGroup?: { master?: number; ids?: number[] } | null;
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

/** Fetch bookings by id, whatever their status. */
async function fetchByIds(token: string, ids: number[]): Promise<Beds24Booking[]> {
  const params = new URLSearchParams();
  for (const id of ids) params.append("id", String(id));
  for (const s of ["confirmed", "new", "request", "cancelled", "black"]) params.append("status", s);
  params.set("includeBookingGroup", "true");
  const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, {
    headers: { token },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
  return asArray(await res.json());
}

/** Write the new dates into the shared bookings cache for the ids we moved. */
async function patchBookingsCache(
  ids: number[],
  arrival: string,
  departure: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const cached = await redis.get<Record<string, { arrival: string; departure: string }>>(
      BOOKINGS_CACHE_KEY,
    );
    if (!cached) return;
    let touched = false;
    for (const id of ids) {
      const entry = cached[String(id)];
      if (!entry) continue;
      entry.arrival = arrival;
      entry.departure = departure;
      touched = true;
    }
    if (touched) await redis.set(BOOKINGS_CACHE_KEY, cached);
  } catch {
    // Best-effort only: the next Beds24 sync corrects the cache regardless.
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: {
    reservationNumber?: string;
    arrival?: string;
    departure?: string;
    lockChannel?: boolean;
    reason?: string;
  };
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
  const nextArrival = String(body.arrival ?? "");
  const nextDeparture = String(body.departure ?? "");
  const reason = (body.reason ?? "").trim();

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Auth error" },
      { status: 500 },
    );
  }

  // ── Read LIVE state — the client's dates are a display, not a source ──
  let booking: Beds24Booking | undefined;
  try {
    booking = (await fetchByIds(token, [bookingId])).find((b) => b.id === bookingId);
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
    return NextResponse.json(
      { error: "This is a blackout — edit it from the blackout tools instead." },
      { status: 409 },
    );
  }
  if (booking.status === "cancelled") {
    return NextResponse.json(
      { error: "This booking is cancelled in Beds24 — its nights are already free." },
      { status: 409 },
    );
  }

  const result = planShortening(
    { arrival: booking.arrival, departure: booking.departure },
    { arrival: nextArrival, departure: nextDeparture },
    { today: pragueToday() },
  );
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  const { plan } = result;

  // ── Package bookings move as one ──
  // A virtual-room stay is several Beds24 bookings sharing a master; shortening
  // only the one the operator clicked would leave the other room blocked.
  // (Beds24's own grouping only — the app's hard-wired MANUAL_GROUPS map is a
  // one-off for two long-past 2026 bookings and can't be shortened anyway.)
  const groupIds = new Set<number>([bookingId]);
  for (const id of booking.bookingGroup?.ids ?? []) {
    if (Number.isFinite(id)) groupIds.add(Number(id));
  }
  if (booking.bookingGroup?.master) groupIds.add(Number(booking.bookingGroup.master));

  let targets: Beds24Booking[] = [booking];
  const skipped: Array<{ id: number; why: string }> = [];
  if (groupIds.size > 1) {
    let members: Beds24Booking[];
    try {
      members = await fetchByIds(token, [...groupIds]);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Group lookup failed" },
        { status: 502 },
      );
    }
    targets = [];
    for (const m of members) {
      if (m.status === "cancelled" || m.status === "black") {
        skipped.push({ id: m.id, why: m.status });
        continue;
      }
      // Only move legs that currently run the same dates — a member on its own
      // schedule isn't part of this stay in any meaningful sense.
      if (m.arrival !== booking.arrival || m.departure !== booking.departure) {
        skipped.push({ id: m.id, why: `different dates (${m.arrival}→${m.departure})` });
        continue;
      }
      targets.push(m);
    }
    if (!targets.some((t) => t.id === bookingId)) targets.push(booking);
  }

  // ── Execute ──
  const lockChannel = body.lockChannel === true;
  // roomId is echoed back unchanged — Beds24's booking schema treats it as part
  // of a booking write, and re-sending the room it already has keeps the update
  // a pure date move.
  const payload = targets.map((t) => ({
    id: t.id,
    roomId: t.roomId,
    arrival: plan.toArrival,
    departure: plan.toDeparture,
    ...(lockChannel ? { allowChannelUpdate: LOCK_CHANNEL_UPDATE } : {}),
  }));
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
    const rows = asArray(json) as unknown as Array<{ success?: boolean; errors?: unknown }>;
    const failed = rows.find((r) => r && r.success === false);
    if (failed) {
      return NextResponse.json(
        { error: `Beds24 rejected the change: ${JSON.stringify(failed)}` },
        { status: 502 },
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Beds24 update failed" },
      { status: 502 },
    );
  }

  const movedIds = targets.map((t) => t.id);
  await patchBookingsCache(movedIds, plan.toArrival, plan.toDeparture);

  const guest = `${booking.firstName ?? ""} ${booking.lastName ?? ""}`.trim() || `#${bookingId}`;
  await sendTelegram(
    [
      `✂️ <b>Stay shortened</b> — ${nightsLabel(plan.nightsRemoved)} back on sale`,
      `#${bookingId} · ${guest}${booking.apiSource ? ` · ${booking.apiSource}` : ""}`,
      `${plan.fromArrival} → ${plan.fromDeparture}  ⇒  ${plan.toArrival} → ${plan.toDeparture}`,
      describeShortening(plan),
      lockChannel ? `🔒 Channel updates blocked on this booking.` : `Channel updates left open.`,
      `💰 Price unchanged in Beds24 — adjust it there and refund the guest.`,
      reason ? `📝 ${reason}` : "",
      `👤 by ${guard.email}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return NextResponse.json({
    ok: true,
    bookingIds: movedIds,
    skipped,
    channelLocked: lockChannel,
    plan,
  });
}
