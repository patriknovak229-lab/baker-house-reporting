import { NextRequest, NextResponse } from "next/server";

const TELEGRAM_API = "https://api.telegram.org";

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

// Beds24 sends the booking as a flat object in the POST body.
// Fields used here are confirmed from Beds24 V2 webhook docs.
interface Beds24WebhookPayload {
  bookId?: number | string;
  propId?: number | string;
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
}

const ROOM_MAP: Record<string, string> = {
  "656437": "K.201",
  "648596": "K.202",
  "648772": "K.203",
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

  // Only notify on new/confirmed bookings, ignore cancellations
  if (payload.status === "cancelled" || payload.status === "canceled") {
    return NextResponse.json({ ok: true, skipped: "cancellation" });
  }

  const room = ROOM_MAP[String(payload.roomId ?? "")] ?? "Unknown room";
  const firstName = payload.firstName ?? "";
  const lastName = payload.lastName ?? "";
  const guests =
    (Number(payload.numAdult ?? 0) + Number(payload.numChild ?? 0)) || "—";
  const nights =
    payload.arrival && payload.departure
      ? Math.round(
          (new Date(payload.departure).getTime() -
            new Date(payload.arrival).getTime()) /
            86_400_000
        )
      : "—";
  const channel = payload.apiSource || "Direct";
  const price = payload.price ? `${Number(payload.price).toLocaleString("cs-CZ")} Kč` : "—";

  const message = [
    `🏠 <b>New Booking — ${room}</b>`,
    `👤 ${firstName} ${lastName}`.trim() || "👤 —",
    `📅 ${formatDate(payload.arrival ?? "")} → ${formatDate(payload.departure ?? "")} (${nights} nights)`,
    `👥 ${guests} guests`,
    `📣 ${channel}`,
    `💰 ${price}`,
  ].join("\n");

  await sendTelegram(message);

  return NextResponse.json({ ok: true });
}
