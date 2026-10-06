/**
 * Availability verdict for one corporate stay — pure, client-safe, tested.
 *
 * Asks the shared Stay Request planner (the same solver behind the
 * Transactions room-assignment panel) two questions per stay:
 *   1. Can the AGREED types host it as one booking? Which type, which unit,
 *      does anyone have to move?
 *   2. If not (or only with a shuffle) — which OTHER sellable type has
 *      vacancy? That is what the operator tells the company: "the studios are
 *      full that week, but K.201 is free".
 *
 * Advisory only: it reads the dashboard's reservations, and Beds24's own
 * availability check is the final word when the booking is created.
 */
import { SELLABLE_UNITS, planStayRequest } from './stayRequest';
import type { ResRef } from './roomAllocation';
import { formatStayDate, roomShortLabel } from './corporateShared';

export interface StayDates {
  arrival: string;
  departure: string;
}

/** Another type that could host the stay. */
export interface Alternative {
  roomId: number;
  /** Physical unit the planner would use. */
  unit: string;
  /** Other guests that would have to move within that type; 0 = free as is. */
  moves: number;
}

export type Availability =
  | { kind: 'free'; unit: string }
  | { kind: 'shuffle'; unit: string; moves: number; alternatives: Alternative[] }
  | { kind: 'blocked'; note: string; alternatives: Alternative[] }
  | { kind: 'past' }
  | { kind: 'unknown' };

/**
 * One booking = ONE segment. The planner happily answers "yes" with a split
 * itinerary (night one in Urban, night two in Deluxe) even at
 * maxRoomChanges 0 when no single type covers the span, so a plan only counts
 * here if it keeps the guest in one unit of one type.
 */
function singleSegment(
  reservations: ResRef[],
  stay: StayDates,
  roomId: number,
  guests: number,
  today: string,
  allowShuffle: boolean,
): { unit: string; moves: number } | null {
  const plan = planStayRequest(reservations, stay.arrival, stay.departure, today, {
    allowedRoomIds: [roomId],
    maxRoomChanges: 0,
    allowShuffle,
    guests,
  });
  if (!plan.feasible || plan.segments.length !== 1) return null;
  const seg = plan.segments[0];
  return { unit: seg.room, moves: seg.moves.length };
}

/** Why one type refused — the planner's blocking night and who holds the units. */
function blockingNote(reservations: ResRef[], stay: StayDates, roomIds: number[], guests: number, today: string): string {
  const plan = planStayRequest(reservations, stay.arrival, stay.departure, today, {
    allowedRoomIds: roomIds,
    maxRoomChanges: 0,
    allowShuffle: true,
    guests,
  });
  if (plan.feasible) return 'no single unit covers every night';
  if (plan.reason) return plan.reason;
  const who = plan.holders
    .filter((h) => h.who)
    .map((h) => `${h.room}: ${h.who}${h.inHouse ? ' (in-house)' : ''}`)
    .join(', ');
  return who ? `${formatStayDate(plan.blockedAt)} — ${who}` : `blocked on ${formatStayDate(plan.blockedAt)}`;
}

/**
 * Judge one stay against the agreed types, in preference order (preferred
 * first, then the rest as listed). A type that is simply free beats any
 * arrangement that moves another guest — a shuffle is work and a risk, not a
 * feature — so every type is tried without a shuffle before any is tried with
 * one. Returns the type to book plus the verdict.
 */
export function evaluateAvailability(
  reservations: ResRef[] | null,
  stay: StayDates,
  roomIds: number[],
  preferredRoomId: number | null,
  guests: number,
  today: string,
): { roomId: number; availability: Availability } {
  const ordered =
    preferredRoomId !== null && roomIds.includes(preferredRoomId)
      ? [preferredRoomId, ...roomIds.filter((id) => id !== preferredRoomId)]
      : [...roomIds];
  const fallbackRoom = ordered[0];
  if (stay.arrival < today) return { roomId: fallbackRoom, availability: { kind: 'past' } };
  if (!reservations) return { roomId: fallbackRoom, availability: { kind: 'unknown' } };

  for (const roomId of ordered) {
    const quiet = singleSegment(reservations, stay, roomId, guests, today, false);
    if (quiet) return { roomId, availability: { kind: 'free', unit: quiet.unit } };
  }
  for (const roomId of ordered) {
    const shuffled = singleSegment(reservations, stay, roomId, guests, today, true);
    if (shuffled) {
      // Only types that are free WITHOUT moving anyone are worth mentioning here.
      const alternatives = findAlternatives(reservations, stay, roomIds, guests, today).filter((a) => a.moves === 0);
      return { roomId, availability: { kind: 'shuffle', unit: shuffled.unit, moves: shuffled.moves, alternatives } };
    }
  }
  return {
    roomId: fallbackRoom,
    availability: {
      kind: 'blocked',
      note: blockingNote(reservations, stay, roomIds, guests, today),
      alternatives: findAlternatives(reservations, stay, roomIds, guests, today),
    },
  };
}

/**
 * Which OTHER sellable types could host this stay — asked one type at a time,
 * so the answer names a type and a unit, not an itinerary. Free-as-is types
 * come first, then those needing a shuffle. `exclude` = the types already
 * judged (the agreed ones for a blocked stay, the picked one for a shuffle).
 */
export function findAlternatives(
  reservations: ResRef[],
  stay: StayDates,
  exclude: number[],
  guests: number,
  today: string,
): Alternative[] {
  const out: Alternative[] = [];
  for (const u of SELLABLE_UNITS) {
    if (exclude.includes(u.roomId)) continue;
    const quiet = singleSegment(reservations, stay, u.roomId, guests, today, false);
    if (quiet) {
      out.push({ roomId: u.roomId, unit: quiet.unit, moves: 0 });
      continue;
    }
    const shuffled = singleSegment(reservations, stay, u.roomId, guests, today, true);
    if (shuffled) out.push({ roomId: u.roomId, unit: shuffled.unit, moves: shuffled.moves });
  }
  return out.sort((a, b) => a.moves - b.moves);
}

/** "Deluxe 1KK (K.203) · K.201 2KK (K.201, 1 move)" */
export function describeAlternatives(alts: Alternative[]): string {
  return alts
    .map((a) => `${roomShortLabel(a.roomId)} (${a.unit}${a.moves > 0 ? `, ${a.moves} move${a.moves === 1 ? '' : 's'}` : ''})`)
    .join(' · ');
}
