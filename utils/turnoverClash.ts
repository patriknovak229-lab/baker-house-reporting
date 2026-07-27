/**
 * Turnover clash detection — a same-room, same-day turnover where the outgoing
 * guest has a LATE CHECKOUT (stays until 12:00) and the incoming guest has an
 * EARLY CHECK-IN (arrives 13:00). That collapses the cleaning window to ~1h,
 * so the operator needs to see it and coordinate with cleaners (e.g. two
 * back-to-back Flexi-rate stays in the same room).
 *
 * Perks are the EFFECTIVE rate perks (rate-derived + operator overrides), so a
 * removed/added perk changes clash detection accordingly.
 *
 * When a like-for-like room (same interchangeable type) is free for one of the
 * two stays, we suggest moving that reservation there to dissolve the clash.
 * Suggestions are advisory only — they never move anything.
 */
import type { Reservation } from "@/types/reservation";
import { effectiveRatePerks, autoRatePerks } from "./ratePerks";
import { effectiveRateType } from "./rateType";
import { ALL_ROOMS_BY_CATEGORY } from "./roomCategory";

/** Physical rooms that are interchangeable (same sellable type) — moving a
 *  guest within a group is a like-for-like reallocation. K.201 (2KK) and
 *  O.308 (2-bedroom) are unique, so they have no sibling. */
export const INTERCHANGEABLE_ROOM_GROUPS: readonly (readonly string[])[] = [
  ["K.102", "K.103", "K.106"], // 1KK Urban Studios
  ["K.202", "K.203"],          // 1KK Deluxe
];

const PHYSICAL_ROOMS = new Set<string>(ALL_ROOMS_BY_CATEGORY);

export interface TurnoverClash {
  /** Turnover day = outgoing checkout = incoming check-in (YYYY-MM-DD). */
  date: string;
  room: string;
  outgoing: Reservation;
  incoming: Reservation;
  /** A like-for-like room free for one stay, or null if none. */
  suggestion: { who: "incoming" | "outgoing"; guest: Reservation; toRoom: string } | null;
}

function perksOf(r: Reservation) {
  return effectiveRatePerks(autoRatePerks(effectiveRateType(r), r.reservationDate), r.perkOverrides);
}

/** A real guest stay (drives clashes) — excludes blackouts, cancellations, and
 *  non-arrivals (the guest never physically shows up). */
function isRealStay(r: Reservation): boolean {
  return !r.isBlackout && !r.isCancelled && !r.nonArrival && PHYSICAL_ROOMS.has(r.room);
}

/** Occupies a room for availability purposes — anything but a plain
 *  cancellation (blackouts and non-arrivals still hold the room in Beds24). */
function blocksRoom(r: Reservation): boolean {
  return !(r.isCancelled && !r.nonArrival);
}

function siblingsOf(room: string): string[] {
  const g = INTERCHANGEABLE_ROOM_GROUPS.find((grp) => grp.includes(room));
  return g ? g.filter((r) => r !== room) : [];
}

/**
 * Is `room` a clean like-for-like target for `stay`? Requires no blocker
 * overlapping the stay AND clean boundaries (nothing checking out on the
 * arrival day / checking in on the departure day) so the move can't just
 * recreate a turnover clash in the new room.
 */
function roomIsCleanFor(room: string, stay: Reservation, blockers: Reservation[]): boolean {
  const inD = stay.checkInDate;
  const outD = stay.checkOutDate;
  for (const b of blockers) {
    if (b.room !== room) continue;
    if (b.reservationNumber === stay.reservationNumber) continue;
    // Overlap on the half-open interval [checkIn, checkOut).
    if (b.checkInDate < outD && inD < b.checkOutDate) return false;
    // Adjacent turnovers at either boundary.
    if (b.checkOutDate === inD || b.checkInDate === outD) return false;
  }
  return true;
}

/**
 * Find all upcoming turnover clashes (turnover date on/after `todayYmd`),
 * sorted by date. Each carries a move suggestion when a like-for-like room is
 * free (prefers moving the incoming guest, else the outgoing).
 */
export function computeTurnoverClashes(
  reservations: Reservation[],
  todayYmd: string = new Date().toLocaleDateString("sv-SE"),
): TurnoverClash[] {
  const blockers = reservations.filter(blocksRoom);
  const stays = reservations.filter(isRealStay);

  const byRoom = new Map<string, Reservation[]>();
  for (const r of stays) {
    const list = byRoom.get(r.room);
    if (list) list.push(r);
    else byRoom.set(r.room, [r]);
  }

  const clashes: TurnoverClash[] = [];
  for (const [room, list] of byRoom) {
    for (const incoming of list) {
      if (incoming.checkInDate < todayYmd) continue; // only upcoming turnovers
      if (!perksOf(incoming).earlyCheckIn) continue;
      const outgoing = list.find(
        (a) =>
          a.reservationNumber !== incoming.reservationNumber &&
          a.checkOutDate === incoming.checkInDate &&
          perksOf(a).lateCheckout,
      );
      if (!outgoing) continue;

      // Suggestion: prefer relocating the incoming, else the outgoing.
      let suggestion: TurnoverClash["suggestion"] = null;
      const incTarget = siblingsOf(room).find((s) => roomIsCleanFor(s, incoming, blockers));
      if (incTarget) {
        suggestion = { who: "incoming", guest: incoming, toRoom: incTarget };
      } else {
        const outTarget = siblingsOf(room).find((s) => roomIsCleanFor(s, outgoing, blockers));
        if (outTarget) suggestion = { who: "outgoing", guest: outgoing, toRoom: outTarget };
      }

      clashes.push({ date: incoming.checkInDate, room, outgoing, incoming, suggestion });
    }
  }

  return clashes.sort((a, b) => a.date.localeCompare(b.date));
}
