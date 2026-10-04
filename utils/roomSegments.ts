/**
 * Mid-stay room moves — which physical unit a reservation occupied on which nights.
 *
 * WHY THIS LIVES IN THE APP AND NOT IN BEDS24
 * -------------------------------------------
 * When a guest is moved part-way through a stay (broken door, leak…), Beds24
 * only knows the booking's CURRENT roomId: the whole stay reads as the new unit,
 * including the nights already slept in the old one. Splitting the booking in
 * Beds24 was rejected on purpose (OTA date sync, money on two bookings, a fake
 * "arrival" triggering guest messages — see the 2026-10-04 decision). So Beds24
 * keeps ONE booking in the new room, and this app records the move date in
 * `room_moves.effective_from` and re-derives the true per-room picture:
 *
 *   arrival ──── fromRoom ──── effectiveFrom ──── toRoom ──── departure
 *
 * Segments drive three things:
 *   - occupancy / double-booking checks (the old unit's past nights no longer
 *     collide with whoever really held the new unit),
 *   - per-apartment money: gross, commission and every other amount split
 *     PRO-RATA BY NIGHTS (4 nights, 10 000 CZK, 2+2 → 5 000 + 5 000),
 *   - a cleaning of the vacated unit on the move date (published to the
 *     cleaning app — see `moveCleaningsFor`).
 *
 * The reservation's `room` stays the Beds24 room = the LAST segment's room.
 */
import type { Reservation, RoomSegment } from "@/types/reservation";

/** The subset of a `room_moves` row this module needs. */
export interface RoomMoveRecord {
  reservationNumber: string;
  fromRoom: string;
  toRoom: string;
  /** null = a whole-stay move (the classic drawer move / resolver leg). */
  effectiveFrom: string | null;
  /** ISO timestamp — orders moves when they compete. */
  movedAt: string;
}

function nightsBetween(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  return Math.round((b - a) / 86_400_000);
}

/**
 * Per-room segments for one reservation, or null when the stay is in one room.
 *
 * Only mid-stay moves made AFTER the reservation's latest whole-stay move count
 * — a later whole-stay move re-homes every night and supersedes the history.
 * Two mid-stay moves on the same date: the later one wins (an operator redoing
 * a move). A move date outside (checkIn, checkOut) — e.g. the stay was
 * shortened afterwards — is ignored.
 *
 * Safety: the chain must END in the room Beds24 currently holds. If it doesn't,
 * someone moved the booking outside this app since, the recorded history no
 * longer describes reality, and we fall back to the plain single-room view
 * rather than attribute nights to a room on stale evidence.
 */
export function buildRoomSegments(
  r: Pick<Reservation, "room" | "checkInDate" | "checkOutDate">,
  moves: RoomMoveRecord[],
): RoomSegment[] | null {
  if (!r.checkInDate || !r.checkOutDate || r.checkOutDate <= r.checkInDate) return null;
  const ordered = [...moves].sort((a, b) => a.movedAt.localeCompare(b.movedAt));
  const lastWhole = ordered.map((m) => m.effectiveFrom).lastIndexOf(null);
  const byDate = new Map<string, RoomMoveRecord>();
  for (const m of ordered.slice(lastWhole + 1)) {
    if (!m.effectiveFrom) continue;
    if (m.effectiveFrom <= r.checkInDate || m.effectiveFrom >= r.checkOutDate) continue;
    byDate.set(m.effectiveFrom, m); // later movedAt overwrites
  }
  if (byDate.size === 0) return null;

  const cuts = [...byDate.values()].sort((a, b) => a.effectiveFrom!.localeCompare(b.effectiveFrom!));
  if (cuts[cuts.length - 1].toRoom !== r.room) return null;

  const total = nightsBetween(r.checkInDate, r.checkOutDate);
  const segments: RoomSegment[] = [];
  let from = r.checkInDate;
  let room = cuts[0].fromRoom;
  for (const cut of cuts) {
    const to = cut.effectiveFrom!;
    const nights = nightsBetween(from, to);
    segments.push({ room, from, to, nights, share: nights / total });
    from = to;
    room = cut.toRoom;
  }
  const nights = nightsBetween(from, r.checkOutDate);
  segments.push({ room, from, to: r.checkOutDate, nights, share: nights / total });

  // Two cuts that land the guest back in the same room collapse into one span.
  const merged: RoomSegment[] = [];
  for (const s of segments) {
    const prev = merged[merged.length - 1];
    if (prev && prev.room === s.room) {
      prev.to = s.to;
      prev.nights += s.nights;
      prev.share += s.share;
    } else {
      merged.push({ ...s });
    }
  }
  return merged.length > 1 ? merged : null;
}

/** Attach `roomSegments` to every reservation that has mid-stay moves. */
export function attachRoomSegments<T extends Reservation>(reservations: T[], moves: RoomMoveRecord[]): T[] {
  if (moves.length === 0) return reservations;
  const byRes = new Map<string, RoomMoveRecord[]>();
  for (const m of moves) {
    const list = byRes.get(m.reservationNumber);
    if (list) list.push(m);
    else byRes.set(m.reservationNumber, [m]);
  }
  return reservations.map((r) => {
    const list = byRes.get(r.reservationNumber);
    if (!list || !list.some((m) => m.effectiveFrom)) return r;
    if (r.linkedRooms && r.linkedRooms.length > 1) return r; // multi-apartment stays aren't split
    const segments = buildRoomSegments(r, list);
    return segments ? { ...r, roomSegments: segments } : r;
  });
}

/**
 * Where a reservation physically was, as half-open night spans. One span for an
 * ordinary booking (per linked room for a multi-apartment one); one per segment
 * for a mid-stay move. Every occupancy check should read this, not `room`.
 */
export function occupancySpans(
  r: Pick<Reservation, "room" | "linkedRooms" | "checkInDate" | "checkOutDate" | "roomSegments">,
): { room: string; from: string; to: string }[] {
  if (r.roomSegments && r.roomSegments.length > 0) {
    return r.roomSegments.map((s) => ({ room: s.room, from: s.from, to: s.to }));
  }
  const rooms = r.linkedRooms && r.linkedRooms.length > 0 ? r.linkedRooms : [r.room];
  return rooms.map((room) => ({ room, from: r.checkInDate, to: r.checkOutDate }));
}

/**
 * Money fields that scale with the stay — the same four
 * `expandLinkedReservations` splits for a multi-apartment booking. Everything
 * derived from them (non-arrival net, platform refund) is applied downstream as
 * a RATIO of the row's `price` (see utils/reservationRevenue), so it follows the
 * split on its own and must NOT be scaled here too.
 */
const PRORATED_FIELDS = ["price", "commissionAmount", "paymentChargeAmount", "amountPaid"] as const;

/**
 * Split `total` across `shares` in whole CZK, the last piece taking the
 * remainder so the pieces always add back up to the booking exactly.
 */
function allocate(total: number, shares: number[]): number[] {
  let left = total;
  return shares.map((share, i) => {
    if (i === shares.length - 1) return left;
    const part = Math.round(total * share);
    left -= part;
    return part;
  });
}

/**
 * One reservation → one per-room piece per segment, each carrying its own
 * room, dates, nights and a nights-proportional share of the money
 * (4 nights, 10 000 CZK gross, 2 000 commission, moved after 2 nights →
 * 5 000 / 1 000 in each apartment). An ordinary reservation comes back
 * untouched as a single-element array.
 *
 * The pieces keep the original `reservationNumber`: they are views for
 * per-apartment aggregation, never new bookings — count stays BEFORE splitting.
 */
export function splitBySegments<T extends Reservation>(r: T): T[] {
  const segs = r.roomSegments;
  if (!segs || segs.length < 2) return [r];
  const shares = segs.map((s) => s.share);
  const parts = Object.fromEntries(PRORATED_FIELDS.map((f) => [f, allocate(r[f] ?? 0, shares)])) as Record<
    (typeof PRORATED_FIELDS)[number],
    number[]
  >;
  return segs.map((s, i) => ({
    ...r,
    room: s.room as T["room"],
    linkedRooms: undefined,
    checkInDate: s.from,
    checkOutDate: s.to,
    numberOfNights: s.nights,
    price: parts.price[i],
    commissionAmount: parts.commissionAmount[i],
    paymentChargeAmount: parts.paymentChargeAmount[i],
    amountPaid: parts.amountPaid[i],
    roomSegments: undefined, // prevent double-expansion
    segmentPiece: { index: i, of: segs.length },
  }));
}

/**
 * Booking counters: true when this row is a mid-stay piece whose reservation
 * was already counted from another piece in `seen` (which it updates). An
 * ordinary row is never a repeat. Lets "reservations" counts stay at one per
 * booking while nights and money are split per apartment.
 */
export function isRepeatSegmentPiece(r: Pick<Reservation, "reservationNumber" | "segmentPiece">, seen: Set<string>): boolean {
  if (!r.segmentPiece) return false;
  if (seen.has(r.reservationNumber)) return true;
  seen.add(r.reservationNumber);
  return false;
}

/**
 * Amounts recorded against the WHOLE reservation (cleaning-app costs tagged
 * with a reservation number) belong to the piece the guest checked out of —
 * the last one. True for ordinary rows.
 */
export function isFinalSegmentPiece(r: Pick<Reservation, "segmentPiece">): boolean {
  return !r.segmentPiece || r.segmentPiece.index === r.segmentPiece.of - 1;
}

/** A cleaning of the unit a guest moved OUT of, due on the move date. */
export interface MoveCleaning {
  /** Move date = the day the vacated unit is free to clean. */
  date: string;
  /** Physical unit vacated. */
  room: string;
  /** The unit the guest moved into (for the cleaner's context). */
  toRoom: string;
  /** First night spent in the vacated unit. */
  stayFrom: string;
}

/** The vacated-unit cleanings a segmented reservation implies. */
export function moveCleaningsFor(r: Pick<Reservation, "roomSegments">): MoveCleaning[] {
  const segs = r.roomSegments ?? [];
  const out: MoveCleaning[] = [];
  for (let i = 0; i < segs.length - 1; i++) {
    out.push({ date: segs[i].to, room: segs[i].room, toRoom: segs[i + 1].room, stayFrom: segs[i].from });
  }
  return out;
}
