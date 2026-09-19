/**
 * POST /api/bookings/move — reassign one or more bookings to different
 * physical units (admin/super). This is the "execute the reshuffle" endpoint
 * behind the unallocated-reservation resolver.
 *
 * Body: { moves: [{ reservationNumber, toRoom }], reason? }
 *   - reservationNumber: "BH-<id>", or "BH-<id>#<unit>" for ONE apartment of a
 *     guest who booked several. Such a reservation is a single visible booking
 *     holding several units, so the solver addresses each unit separately and
 *     this endpoint resolves the leg back to its own Beds24 booking (below).
 *   - toRoom: physical unit name, e.g. "K.203"
 *   The list includes the unallocated booking's placement AND any shuffle.
 *
 * Safety (this mutates real Beds24 bookings):
 *   1. admin/super only.
 *   2. WITHIN ROOM TYPE only — every target unit must be in the same
 *      allocation group (no cross-type moves here).
 *   3. Re-validated against LIVE Beds24 state, not the client's view:
 *        - target bookings exist and aren't cancelled,
 *        - no target booking is currently in-house (can't move a staying guest),
 *        - the resulting allocation has no overlapping bookings in any unit.
 *   4. Only then does it POST the batch roomId change to Beds24.
 */

import { NextRequest, NextResponse } from "next/server";
import { getAccessToken } from "@/utils/beds24Auth";
import { requireRole } from "@/utils/authGuard";
import {
  roomIdForName,
  groupForRoom,
  type AllocationGroup,
} from "@/utils/roomAllocation";
import { pragueToday } from "@/utils/periodUtils";
import { recordRoomMoves, roomMoveId } from "@/data-access/roomMoves";

const BEDS24_API_BASE = "https://beds24.com/api/v2";

interface Beds24Booking {
  id: number;
  roomId: number;
  arrival: string; // YYYY-MM-DD
  departure: string; // YYYY-MM-DD (exclusive)
  status: string;
  firstName?: string;
  lastName?: string;
}

interface ParsedMove {
  /** Exactly what the client sent, for error messages. */
  ref: string;
  /** The visible reservation's Beds24 id (the master of a merged group). */
  masterId: number;
  /** Set when the ref addressed one apartment of a multi-unit reservation. */
  legUnit: string | null;
  toRoom: string;
  toRoomId: number;
  /** The Beds24 booking actually being moved — resolved before execution. */
  bookingId: number;
}

interface MoveInput {
  reservationNumber: string;
  toRoom: string;
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

function asArray(json: unknown): Beds24Booking[] {
  if (Array.isArray(json)) return json as Beds24Booking[];
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Beds24Booking[]) : [];
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin", "super"]);
  if ("error" in guard) return guard.error;

  let body: { moves?: MoveInput[]; reason?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const moves = Array.isArray(body.moves) ? body.moves : [];
  if (moves.length === 0) {
    return NextResponse.json({ error: "No moves provided" }, { status: 400 });
  }

  // ── Parse + within-type validation ──
  const parsed: ParsedMove[] = [];
  let group: AllocationGroup | null = null;
  for (const m of moves) {
    const ref = String(m.reservationNumber ?? "");
    // "BH-123#K.106" addresses one apartment of a multi-apartment reservation.
    const [idPart, legUnit = null] = ref.split("#");
    const masterId = Number(idPart.replace(/^BH-/, ""));
    const toRoomId = roomIdForName(m.toRoom);
    const g = groupForRoom(m.toRoom);
    if (!Number.isFinite(masterId) || masterId <= 0) {
      return NextResponse.json({ error: `Bad reservation number: ${ref}` }, { status: 400 });
    }
    if (toRoomId === null || !g) {
      return NextResponse.json({ error: `"${m.toRoom}" is not a shuffleable unit` }, { status: 400 });
    }
    if (legUnit !== null && groupForRoom(legUnit) !== g) {
      return NextResponse.json(
        { error: `"${legUnit}" is not a unit of ${g.typeLabel} — a leg can only move within its own room type` },
        { status: 400 },
      );
    }
    if (group && g !== group) {
      return NextResponse.json(
        { error: "All moves must stay within one room type (no cross-type moves here)" },
        { status: 400 },
      );
    }
    group = g;
    // Resolved after the live fetch; masterId is right for a single-unit booking.
    parsed.push({ ref, masterId, legUnit, toRoom: m.toRoom, toRoomId, bookingId: masterId });
  }
  group = group!;

  let token: string;
  try {
    token = await getAccessToken();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Auth error" }, { status: 500 });
  }

  // ── Fetch the bookings being moved (live), to learn dates + status ──
  const idParams = new URLSearchParams();
  [...new Set(parsed.map((p) => p.masterId))].forEach((id) => idParams.append("id", String(id)));
  for (const s of ["confirmed", "new", "request", "cancelled"]) idParams.append("status", s);
  let movedBookings: Beds24Booking[];
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${idParams}`, { headers: { token }, cache: "no-store" });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    movedBookings = asArray(await res.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Lookup failed" }, { status: 502 });
  }

  const movedById = new Map(movedBookings.map((b) => [b.id, b]));
  const today = pragueToday();

  for (const p of parsed) {
    if (!movedById.has(p.masterId)) {
      return NextResponse.json({ error: `Booking ${p.masterId} not found` }, { status: 404 });
    }
  }

  // ── Re-validate the resulting allocation against live group state ──
  const winStart = movedBookings.reduce((m, b) => (b.arrival < m ? b.arrival : m), movedBookings[0].arrival);
  const winEnd = movedBookings.reduce((m, b) => (b.departure > m ? b.departure : m), movedBookings[0].departure);
  // Pull a generous arrival window for the group's physical units so any stay
  // overlapping [winStart, winEnd) is captured (60-day back buffer for long stays).
  const from = new Date(winStart + "T00:00:00Z");
  from.setUTCDate(from.getUTCDate() - 60);
  const groupParams = new URLSearchParams();
  group.units.forEach((u) => groupParams.append("roomId", String(u.roomId)));
  groupParams.set("arrivalFrom", from.toISOString().slice(0, 10));
  groupParams.set("arrivalTo", winEnd);
  for (const s of ["confirmed", "new", "request"]) groupParams.append("status", s);

  let groupBookings: Beds24Booking[];
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${groupParams}`, { headers: { token }, cache: "no-store" });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    groupBookings = asArray(await res.json());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Validation fetch failed" }, { status: 502 });
  }

  const roomIdToName = new Map(group.units.map((u) => [u.roomId, u.room]));
  const byId = new Map<number, Beds24Booking>();
  for (const b of [...movedBookings, ...groupBookings]) byId.set(b.id, b);

  // ── Resolve each leg of a multi-apartment reservation to its own booking ──
  // One guest booking two apartments is two Beds24 bookings merged into one
  // visible reservation, and only the master's id survives that merge. The leg
  // is identified from LIVE state instead: the booking sitting in that unit for
  // exactly the reservation's dates. Two bookings cannot share a unit over the
  // same nights, so a match is unique — and if it somehow is not, refusing
  // beats moving a stranger's booking.
  for (const p of parsed) {
    if (!p.legUnit) continue;
    const master = movedById.get(p.masterId)!;
    const candidates = groupBookings.filter(
      (b) =>
        roomIdToName.get(b.roomId) === p.legUnit &&
        b.arrival === master.arrival &&
        b.departure === master.departure &&
        b.status !== "cancelled",
    );
    if (candidates.length !== 1) {
      return NextResponse.json(
        {
          error:
            `Could not identify which booking of ${p.ref} occupies ${p.legUnit} ` +
            `(${candidates.length} candidates for ${master.arrival}→${master.departure}). ` +
            `Move that apartment in Beds24 by hand.`,
        },
        { status: 409 },
      );
    }
    p.bookingId = candidates[0].id;
  }

  for (const p of parsed) {
    const b = byId.get(p.bookingId);
    if (!b) return NextResponse.json({ error: `Booking ${p.bookingId} not found` }, { status: 404 });
    if (b.status === "cancelled") {
      return NextResponse.json({ error: `Booking ${p.bookingId} is cancelled` }, { status: 409 });
    }
    // In-house = already arrived and not yet departed → must not be moved.
    if (b.arrival <= today && b.departure > today) {
      return NextResponse.json(
        { error: `Booking ${p.bookingId} is an in-house guest and cannot be moved` },
        { status: 409 },
      );
    }
  }

  // Two legs of one reservation must not be sent to the same unit — that would
  // ask Beds24 to put one guest's two apartments into a single room.
  const targetsByBooking = new Map<number, string>();
  for (const p of parsed) {
    if (targetsByBooking.has(p.bookingId)) {
      return NextResponse.json(
        { error: `Booking ${p.bookingId} appears twice in this reshuffle` },
        { status: 400 },
      );
    }
    targetsByBooking.set(p.bookingId, p.toRoom);
  }

  const moveTargetById = new Map(parsed.map((p) => [p.bookingId, p.toRoom]));

  // Build post-move unit → intervals (only physically-allocated bookings count).
  const perUnit: Record<string, Beds24Booking[]> = {};
  for (const u of group.units) perUnit[u.room] = [];

  // Existing group bookings, with moved ones relocated to their target unit.
  const seen = new Set<number>();
  for (const b of groupBookings) {
    seen.add(b.id);
    const unit = moveTargetById.get(b.id) ?? roomIdToName.get(b.roomId);
    if (!unit) continue; // not a physical unit in this group
    perUnit[unit].push(b);
  }
  // Moved bookings currently on the VR won't appear in the unit-scoped fetch —
  // add them at their target unit using the dates we already fetched.
  for (const p of parsed) {
    if (seen.has(p.bookingId)) continue;
    const b = byId.get(p.bookingId);
    if (!b) continue; // already reported as missing above
    perUnit[p.toRoom].push({ ...b, roomId: p.toRoomId });
  }

  for (const [unit, list] of Object.entries(perUnit)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (overlaps(list[i], list[j])) {
          return NextResponse.json(
            { error: `Move rejected — it would double-book ${unit} (bookings ${list[i].id} & ${list[j].id})` },
            { status: 409 },
          );
        }
      }
    }
  }

  // ── Execute: batch roomId reassign ──
  const payload = parsed.map((p) => ({ id: p.bookingId, roomId: p.toRoomId }));
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
    // Beds24 returns per-row success flags; surface any row-level failure.
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = null; }
    const rows = asArray(json) as Array<{ success?: boolean; errors?: unknown }>;
    const failedRow = rows.find((r) => r && r.success === false);
    if (failedRow) {
      return NextResponse.json({ error: `Beds24 rejected a move: ${JSON.stringify(failedRow)}` }, { status: 502 });
    }
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Beds24 move failed" }, { status: 502 });
  }

  // Operator-facing notices — one per leg of the reshuffle. A resolver run can
  // move guests who never asked to be moved, so each leg gets its own notice
  // that stays up until someone acknowledges it.
  const stamp = Date.now();
  await recordRoomMoves(
    parsed.map((p) => {
      const b = byId.get(p.bookingId)!;
      const guestName = `${b.firstName ?? ""} ${b.lastName ?? ""}`.trim();
      return {
        id: roomMoveId(String(p.bookingId), stamp),
        // The master id is what the operator sees in Transactions; a leg's own
        // booking id would point at a reservation the app never displays.
        reservationNumber: `BH-${p.masterId}`,
        guestName: guestName || null,
        // Unallocated placements come off the virtual room, which has no unit name.
        fromRoom: roomIdToName.get(b.roomId) ?? group.typeLabel,
        toRoom: p.toRoom,
        checkInDate: b.arrival,
        checkOutDate: b.departure,
        movedBy: guard.email,
        source: "resolver" as const,
        // The resolver refuses to move an in-house guest, so this is always false —
        // set from the same data anyway rather than hard-coding the invariant.
        inHouse: b.arrival <= today && b.departure > today,
        forced: false,
        conflicts: null,
        reason: body.reason?.trim() || null,
      };
    }),
  );

  const summary = parsed
    .map((p) => (p.legUnit ? `#${p.masterId} (${p.legUnit}) → ${p.toRoom}` : `#${p.bookingId} → ${p.toRoom}`))
    .join(", ");
  await sendTelegram(
    [
      `🔀 <b>Room reallocation</b> (${group.typeLabel})`,
      summary,
      body.reason ? `🗒 ${body.reason}` : "",
      `👤 by ${guard.email}`,
    ].filter(Boolean).join("\n"),
  );

  return NextResponse.json({ ok: true, moved: payload, group: group.typeLabel });
}
