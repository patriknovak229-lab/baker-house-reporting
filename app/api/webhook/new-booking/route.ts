import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { rejectBadWebhookSecret } from "@/utils/webhookSecret";
import { clashesInRoom, dateChangeMessage, detectDateChange, type BookingLite } from "@/utils/dateChangeAlert";

const TELEGRAM_API = "https://api.telegram.org";

// ─── Redis helper ─────────────────────────────────────────────────────────────
function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.error("[webhook] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set");
    return;
  }

  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: "HTML",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[webhook] Telegram error:", text);
  }
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}

interface Beds24Booking {
  id?: number | string;
  roomId?: number | string;
  firstName?: string;
  lastName?: string;
  arrival?: string;
  departure?: string;
  numAdult?: number | string;
  numChild?: number | string;
  price?: number | string;
  apiSource?: string;
  status?: string;
  bookingTime?: string;  // ISO — when the booking was originally created
  modifiedTime?: string; // ISO — when the booking was last modified
}

// Beds24 wraps the booking under a "booking" key
interface Beds24WebhookPayload {
  timeStamp?: string;
  booking?: Beds24Booking;
}

// Only notify for bookings created within this window.
// Beds24 fires the webhook for modifications too (messages, status changes, etc.)
// An old booking receiving a message will have a bookingTime from days/months ago.
const NEW_BOOKING_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// Redis key TTL — once notified, suppress all further webhook calls for this ID
const NOTIFIED_TTL_SECONDS = 2 * 60 * 60; // 2 hours

const BOOKINGS_CACHE_KEY = "baker:beds24-bookings-cache";
// One date-change alert per booking + new dates, however often Beds24 re-fires.
const DATE_CHANGE_TTL_SECONDS = 7 * 24 * 60 * 60;

const ROOM_MAP: Record<string, string> = {
  // Deluxe physical rooms
  "656437": "K.201",
  "648596": "K.202",
  "648772": "K.203",
  "674672": "O.308",
  // Deluxe virtual sellable for the 1KK Deluxe pair (Twin Apartments).
  // Direct-web bookings arrive on this VR with the full price; the physical
  // sub allocated by Beds24 ends up with price=0 (skipped by the rule below).
  "648816": "K.202 / K.203",
  // Urban physical rooms (1KK Urban Studios, opening soon)
  "679703": "K.102",
  "679704": "K.103",
  "679705": "K.106",
  // Urban virtual sellable for the 1KK Urban triple
  "679714": "K.102 / K.103 / K.106",
};

/**
 * "Date change detected": compare the webhook's dates with the cached copy,
 * which still holds the OLD ones (the dashboard refreshes the cache only when
 * someone opens it). On a change, Telegram says whether the guest's unit is
 * now double-booked — the OTA only checks the room TYPE has space, so Beds24
 * can keep them in a unit that's taken on the new nights. Best-effort: any
 * failure is logged, never fails the webhook.
 *
 * Blind spot: if someone opened the dashboard between the change and this
 * webhook, the cache already has the new dates and no alert fires — the
 * Room assignment panel still catches any resulting double-booking.
 */
async function alertOnDateChange(booking: Beds24Booking): Promise<"alerted" | "duplicate" | null> {
  try {
    const redis = getRedis();
    if (!redis || booking.id === undefined) return null;
    const cache = (await redis.get<Record<string, BookingLite>>(BOOKINGS_CACHE_KEY)) ?? {};
    const change = detectDateChange(booking, cache[String(booking.id)]);
    if (!change) return null;

    const fresh = await redis.set(`datechange:${booking.id}:${change.to.arrival}:${change.to.departure}`, "1", {
      nx: true,
      ex: DATE_CHANGE_TTL_SECONDS,
    });
    if (!fresh) return "duplicate";

    const roomName = ROOM_MAP[String(booking.roomId ?? "")] ?? `room ${String(booking.roomId ?? "?")}`;
    // A virtual room is shared by every booking of its type — "K.102 / K.103 / K.106".
    const unassigned = roomName.includes("/");
    const clashes = unassigned ? [] : clashesInRoom(booking, cache);
    await sendTelegram(dateChangeMessage(booking, change, roomName, clashes, unassigned));
    return "alerted";
  } catch (err) {
    console.error("[webhook] date-change alert failed", err);
    return null;
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const denied = rejectBadWebhookSecret(req, "webhook/new-booking");
  if (denied) return denied;

  let payload: Beds24WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const booking = payload.booking;

  // Only notify on new/confirmed bookings, ignore cancellations and blackouts
  if (booking?.status === "cancelled" || booking?.status === "canceled") {
    return NextResponse.json({ ok: true, skipped: "cancellation" });
  }
  if (booking?.status === "black") {
    // Blackouts are owner-side room blocks, not actual bookings — no
    // Telegram, no operator-facing notification.
    return NextResponse.json({ ok: true, skipped: "blackout" });
  }

  // Skip sub-bookings: virtual-room allocations always carry price = 0;
  // the master booking holds the real price and is notified separately.
  // This prevents duplicate notifications for Twin Apartments bookings.
  if (Number(booking?.price ?? 0) === 0) {
    return NextResponse.json({ ok: true, skipped: "sub-booking (price=0)" });
  }

  // Modifications to existing bookings: no "new booking" message, but a date
  // change gets its own alert (see utils/dateChangeAlert).
  // A true new booking has bookingTime ≈ now (within 30 min window).
  if (booking?.bookingTime) {
    const age = Date.now() - new Date(booking.bookingTime).getTime();
    if (age > NEW_BOOKING_WINDOW_MS) {
      const dateChange = booking ? await alertOnDateChange(booking) : null;
      return NextResponse.json({ ok: true, skipped: "existing booking update", ...(dateChange ? { dateChange } : {}) });
    }
  }

  const roomKey = String(booking?.roomId ?? "");
  const room = ROOM_MAP[roomKey];
  if (!room) {
    // Virtual or unrecognised room — skip notification, physical allocation will follow
    return NextResponse.json({ ok: true, skipped: "virtual room" });
  }

  // ── Redis dedup — one notification per booking ID, regardless of how many
  // webhook calls Beds24 fires for the same booking (retries, rapid updates, etc.)
  const bookingId = String(booking?.id ?? "");
  if (bookingId) {
    const redis = getRedis();
    if (redis) {
      // Claim before sending, atomically (SET NX) — prevents race on parallel invocations
      const fresh = await redis.set(`notified:booking:${bookingId}`, "1", {
        nx: true,
        ex: NOTIFIED_TTL_SECONDS,
      });
      if (!fresh) {
        return NextResponse.json({ ok: true, skipped: "already notified" });
      }
    }
  }

  const firstName = booking?.firstName ?? "";
  const lastName = booking?.lastName ?? "";
  const guests =
    (Number(booking?.numAdult ?? 0) + Number(booking?.numChild ?? 0)) || "—";
  const nights =
    booking?.arrival && booking?.departure
      ? Math.round(
          (new Date(booking.departure).getTime() -
            new Date(booking.arrival).getTime()) /
            86_400_000
        )
      : "—";
  const channel = booking?.apiSource || "Direct";
  const price = booking?.price ? `${Number(booking.price).toLocaleString("cs-CZ")} Kč` : "—";

  const message = [
    `🏠 <b>New Booking — ${room}</b>`,
    `👤 ${firstName} ${lastName}`.trim() || "👤 —",
    `📅 ${formatDate(booking?.arrival ?? "")} → ${formatDate(booking?.departure ?? "")} (${nights} nights)`,
    `👥 ${guests} guests`,
    `📣 ${channel}`,
    `💰 ${price}`,
  ].join("\n");

  await sendTelegram(message);

  return NextResponse.json({ ok: true });
}
