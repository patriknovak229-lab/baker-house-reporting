import type { Reservation } from "@/types/reservation";

export type StayStatus =
  | "checking-in"
  | "arriving-tomorrow"
  | "arriving-in-x-days"
  | "in-house"
  | "checking-out-today"
  | "checking-out-tomorrow";

function getToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function getTomorrow(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the stay statuses that apply to a reservation as of today.
 *
 * Arrival logic (future reservations only):
 * - Only the NEXT upcoming reservation per room gets an arrival tag.
 * - Arriving today  → "checking-in"
 * - Next for room, check-in tomorrow        → "arriving-tomorrow"
 * - Next for room, check-in 2–14 days away  → "arriving-in-x-days"
 * - Next for room, check-in >14 days away   → no tag
 *
 * In-house reservations always get "in-house" plus an optional checkout tag.
 */
export function computeStayStatus(res: Reservation, allReservations: Reservation[]): StayStatus[] {
  const today = getToday();
  const tomorrow = getTomorrow();
  const statuses: StayStatus[] = [];

  // Arriving today
  if (res.checkInDate === today) {
    statuses.push("checking-in");
    return statuses;
  }

  // In-house: checked in, not yet checked out
  const isInHouse = res.checkInDate < today && res.checkOutDate >= today;
  if (isInHouse) {
    statuses.push("in-house");
    if (res.checkOutDate === today) statuses.push("checking-out-today");
    else if (res.checkOutDate === tomorrow) statuses.push("checking-out-tomorrow");
    return statuses;
  }

  // Future reservation: is this the next upcoming for its room?
  if (res.checkInDate > today) {
    const nextCheckInForRoom = allReservations
      .filter((r) => r.room === res.room && r.checkInDate > today)
      .map((r) => r.checkInDate)
      .sort()[0];

    if (res.checkInDate === nextCheckInForRoom) {
      if (res.checkInDate === tomorrow) {
        statuses.push("arriving-tomorrow");
      } else {
        const days = Math.round(
          (new Date(res.checkInDate).getTime() - new Date(today).getTime()) / 86_400_000
        );
        if (days >= 2 && days <= 14) {
          statuses.push("arriving-in-x-days");
        }
      }
    }
  }

  return statuses;
}
