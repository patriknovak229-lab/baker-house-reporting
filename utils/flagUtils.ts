import type { Reservation, CustomerFlag } from "@/types/reservation";

const REPEAT_WINDOW_MONTHS = 12;

export function computeAutoFlags(
  res: Reservation,
  allReservations: Reservation[]
): Set<CustomerFlag> {
  const flags = new Set<CustomerFlag>();

  // High Value: >= 5 nights
  if (res.numberOfNights >= 5) {
    flags.add("High Value Customer");
  }

  // Repeat Customer: same email OR full name found in another booking in the past 12 months
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - REPEAT_WINDOW_MONTHS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);

  const fullName = `${res.firstName} ${res.lastName}`.toLowerCase().trim();

  const isRepeat = allReservations.some((other) => {
    if (other.reservationNumber === res.reservationNumber) return false;
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
