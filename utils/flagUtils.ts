import type { Reservation, CustomerFlag } from "@/types/reservation";
import { pragueToday } from "@/utils/periodUtils";

const REPEAT_WINDOW_MONTHS = 12;

/**
 * Did this booking result in a stay we actually served? Cancellations,
 * non-arrivals and blackouts never count, and neither does a stay that hasn't
 * finished yet — the guest has to have checked out. Used as the qualifying test
 * for the Repeat Customer tag.
 */
function wasServed(res: Reservation, todayYmd: string): boolean {
  if (res.isCancelled) return false;
  if (res.nonArrival) return false;
  if (res.isBlackout) return false;
  return !!res.checkOutDate && res.checkOutDate < todayYmd;
}

export function computeAutoFlags(
  res: Reservation,
  allReservations: Reservation[]
): Set<CustomerFlag> {
  const flags = new Set<CustomerFlag>();

  // High Value: >= 5 nights
  if (res.numberOfNights >= 5) {
    flags.add("High Value Customer");
  }

  // Repeat Customer: same email OR full name on a stay we actually SERVED in the
  // past 12 months. "Served" is deliberately strict — the guest must have checked
  // out, and the booking must be neither cancelled nor a non-arrival. Without this
  // a guest who booked, cancelled and rebooked used to earn the tag off their own
  // cancellation, and two upcoming bookings would flag each other before either
  // guest had set foot in the building.
  // Prague-local "today" so a stay counts as served the moment the property's
  // own day ticks over, not two hours later when UTC catches up.
  const todayStr = pragueToday();
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - REPEAT_WINDOW_MONTHS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const fullName = `${res.firstName} ${res.lastName}`.toLowerCase().trim();

  const isRepeat = allReservations.some((other) => {
    if (other.reservationNumber === res.reservationNumber) return false;
    if (!wasServed(other, todayStr)) return false;
    if (other.checkInDate < cutoffStr && other.checkOutDate < cutoffStr) return false;
    const otherName = `${other.firstName} ${other.lastName}`.toLowerCase().trim();
    return (
      (res.email.length > 0 && other.email === res.email) ||
      otherName === fullName
    );
  });

  if (isRepeat) flags.add("Repeat Customer");

  // Problematic: no auto rule — manual only

  return flags;
}

export function getEffectiveFlags(
  res: Reservation,
  allReservations: Reservation[]
): CustomerFlag[] {
  const auto = computeAutoFlags(res, allReservations);
  const result = new Set<CustomerFlag>(auto);

  for (const [flag, override] of Object.entries(res.manualFlagOverrides) as [
    CustomerFlag,
    boolean,
  ][]) {
    if (override === true) result.add(flag);
    else if (override === false) result.delete(flag);
  }

  return Array.from(result);
}

export function toggleFlagOverride(
  res: Reservation,
  flag: CustomerFlag,
  allReservations: Reservation[]
): Partial<Record<CustomerFlag, boolean>> {
  const auto = computeAutoFlags(res, allReservations);
  const autoState = auto.has(flag);
  const currentOverride = res.manualFlagOverrides[flag];

  // Current effective state: override wins over auto if set
  const currentEffective =
    currentOverride !== undefined ? currentOverride : autoState;
  const newEffective = !currentEffective;

  // If new effective matches auto, remove the override (keep it clean)
  if (newEffective === autoState) {
    const updated = { ...res.manualFlagOverrides };
    delete updated[flag];
    return updated;
  }

  return { ...res.manualFlagOverrides, [flag]: newEffective };
}
