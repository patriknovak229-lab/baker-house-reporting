/**
 * When a mid-stay cleaning can be: a night of the stay other than the arrival
 * day — the check-in and check-out days already have their own cleanings.
 * Pure — the drawer validates with it, utils/cleaningRequestsPublish publishes
 * by it.
 */
import type { Reservation } from "@/types/reservation";

type StayDates = Pick<Reservation, "checkInDate" | "checkOutDate">;

export function isMidStayDate(r: StayDates, date: string): boolean {
  return !!date && date > r.checkInDate && date < r.checkOutDate;
}

/** The middle night of the stay (rounded down) — a sensible first guess. */
export function defaultMidStayDate(r: StayDates): string {
  const from = Date.parse(`${r.checkInDate}T00:00:00Z`);
  const to = Date.parse(`${r.checkOutDate}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to - from < 2 * 86_400_000) return r.checkInDate;
  const nights = Math.round((to - from) / 86_400_000);
  return new Date(from + Math.floor(nights / 2) * 86_400_000).toISOString().slice(0, 10);
}
