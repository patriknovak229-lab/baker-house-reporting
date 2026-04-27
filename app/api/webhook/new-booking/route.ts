import { NextRequest, NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

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

const ROOM_MAP: Record<string, string> = {
  "656437": "K.201",
  "648596": "K.202",
  "648772": "K.203",
  "674672": "O.308",
  // Virtual sellable for the 1KK pair. Direct-web bookings via the rental-site
  // arrive on this VR with the full price; the physical sub allocated by Beds24
  // ends up with price=0 (skipped by the rule below). Without this entry the
  // master was being skipped as "virtual room" → zero Telegram notifications.
  "648816": "K.202 / K.203",
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Optional secret check — set WEBHOOK_SECRET in env to lock this down
  const secret = process.env.WEBHOOK_SECRET;
  if (secret) {
    const provided = req.nextUrl.searchParams.get("secret");
    if (provided !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let payload: Beds24WebhookPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const booking = payload.booking;

  // Only notify on new/confirmed bookings, ignore cancellations
  if (booking?.status === "cancelled" || booking?.status === "canceled") {
    return NextResponse.json({ ok: true, skipped: "cancellation" });
  }

  // Skip sub-bookings: virtual-room allocations always carry price = 0;
  // the master booking holds the real price and is notified separately.
  // This prevents duplicate notifications for Twin Apartments bookings.
  if (Number(booking?.price ?? 0) === 0) {
    return NextResponse.json({ ok: true, skipped: "sub-booking (price=0)" });
  }

  // Skip modifications to existing bookings.
  // A true new booking has bookingTime ≈ now (within 30 min window).
  if (booking?.bookingTime) {
    const age = Date.now() - new Date(booking.bookingTime).getTime();
    if (age > NEW_BOOKING_WINDOW_MS) {
      return NextResponse.json({ ok: true, skipped: "existing booking update" });
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
      const redisKey = `notified:booking:${bookingId}`;
      const alreadySent = await redis.get(redisKey);
      if (alreadySent) {
        return NextResponse.json({ ok: true, skipped: "already notified" });
      }
      // Mark as notified before sending — prevents race on parallel invocations
      await redis.set(redisKey, "1", { ex: NOTIFIED_TTL_SECONDS });
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
