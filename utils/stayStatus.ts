import type { Reservation } from "@/types/reservation";

export type StayStatus =
  | "arriving-today"
  | "arriving-tomorrow"
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
 * Tags can overlap: in-house + checking-out-today/tomorrow always appear together.
 */
export function computeStayStatus(res: Reservation): StayStatus[] {
  const today = getToday();
  const tomorrow = getTomorrow();
  const statuses: StayStatus[] = [];

  if (res.checkInDate === today) {
    statuses.push("arriving-today");
    return statuses; // arriving guests are not yet "in-house"
  }

  if (res.checkInDate === tomorrow) {
    statuses.push("arriving-tomorrow");
    return statuses;
  }

  // In-house: already checked in, not yet fully checked out
  const isInHouse = res.checkInDate < today && res.checkOutDate >= today;
  if (isInHouse) {
    statuses.push("in-house");
    if (res.checkOutDate === today) statuses.push("checking-out-today");
    else if (res.checkOutDate === tomorrow) statuses.push("checking-out-tomorrow");
  }

  return statuses;
}
