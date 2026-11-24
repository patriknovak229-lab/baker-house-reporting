/**
 * "Date change detected" — the Beds24 booking webhook fires for every
 * modification, and until now /api/webhook/new-booking dropped them all. When a
 * guest moves their dates on an OTA, the channel only checks that the ROOM TYPE
 * has space; Beds24 accepts the change but keeps the guest in their old unit,
 * which may be taken on the new nights (BH-95599985, Nov 2026). Nobody heard
 * about it until an overbooking alert.
 *
 * Pure helpers so the webhook stays thin and this logic is testable: compare
 * the webhook's booking with the cached copy (still holding the OLD dates — the
 * dashboard refreshes the cache only when someone opens it), find who the new
 * nights clash with in the same physical room, and word the Telegram alert.
 */
import { escapeHtml } from "@/utils/telegram";

/** The fields of a Beds24 booking these helpers read (webhook + cache share the shape). */
export interface BookingLite {
  id?: number | string;
  roomId?: number | string;
  arrival?: string;
  departure?: string;
  status?: string;
  firstName?: string;
  lastName?: string;
  apiSource?: string;
}

export interface DateChange {
  from: { arrival: string; departure: string };
  to: { arrival: string; departure: string };
}

const day = (iso: string | undefined) => (iso ?? "").slice(0, 10);
const isLive = (b: BookingLite) => b.status !== "cancelled" && b.status !== "canceled" && b.status !== "black";

/** The dates moved between the cached copy and the webhook's — or null (no change, or nothing to compare). */
export function detectDateChange(next: BookingLite, cached: BookingLite | undefined): DateChange | null {
  if (!cached || !isLive(next)) return null;
  const from = { arrival: day(cached.arrival), departure: day(cached.departure) };
  const to = { arrival: day(next.arrival), departure: day(next.departure) };
  if (!from.arrival || !from.departure || !to.arrival || !to.departure) return null;
  if (from.arrival === to.arrival && from.departure === to.departure) return null;
  return { from, to };
}

/**
 * Other live bookings holding the same physical room on any of `next`'s nights.
 * Blackouts are left out on purpose: they routinely sit next to the booking
 * they protect, and the red banner ignores them for the same reason.
 */
export function clashesInRoom(next: BookingLite, cache: Record<string, BookingLite>): BookingLite[] {
  const arrival = day(next.arrival);
  const departure = day(next.departure);
  if (!arrival || !departure || next.roomId === undefined) return [];
  return Object.values(cache).filter(
    (b) =>
      String(b.id) !== String(next.id) &&
      String(b.roomId) === String(next.roomId) &&
      isLive(b) &&
      day(b.arrival) < departure &&
      arrival < day(b.departure),
  );
}

function fmt(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

function guest(b: BookingLite): string {
  return escapeHtml(`${b.firstName ?? ""} ${b.lastName ?? ""}`.trim() || `BH-${b.id}`);
}

/**
 * Telegram HTML for a detected date change. `room` is the display name of
 * `next.roomId`; `unassigned` = it sits on a virtual room (no unit yet), where
 * `clashes` don't apply — every booking of the type shares that roomId.
 */
export function dateChangeMessage(
  next: BookingLite,
  change: DateChange,
  room: string,
  clashes: BookingLite[],
  unassigned = false,
): string {
  const lines = [
    `📅 <b>Dates changed — ${escapeHtml(room)}</b>`,
    `👤 ${guest(next)} · BH-${escapeHtml(String(next.id))}${next.apiSource ? ` · ${escapeHtml(next.apiSource)}` : ""}`,
    `🔁 ${fmt(change.from.arrival)} → ${fmt(change.from.departure)}  ⟶  <b>${fmt(change.to.arrival)} → ${fmt(change.to.departure)}</b>`,
  ];
  if (unassigned) {
    lines.push(`🧩 Sold on the room type, not a unit — if Beds24 couldn't place the new dates, it shows under Transactions → <b>Room assignment needed</b>.`);
  } else if (clashes.length > 0) {
    const who = clashes.map((c) => `${guest(c)} (${fmt(day(c.arrival))} → ${fmt(day(c.departure))})`).join(", ");
    lines.push(
      `⚠️ Now double-booked in ${escapeHtml(room)} with ${who}.`,
      `The OTA only allows a date change when the room type has space, so this is a room assignment, not an overbooking — open Transactions → <b>Room assignment needed</b> for the suggested fix.`,
    );
  } else {
    lines.push(`✅ ${escapeHtml(room)} is free for the new dates — nothing to do.`);
  }
  return lines.join("\n");
}
