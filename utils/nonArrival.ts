import type { NonArrival } from "@/types/reservation";

/**
 * Why a booking can't be marked as a non-arrival, or null when it can. Shared
 * by the drawer (hides the action) and POST /api/bookings/non-arrival (rejects
 * it), so the two can't drift apart.
 *
 * A booking that is ALREADY cancelled in Beds24 isn't a non-arrival: the guest
 * cancelled, or Beds24 saved an unpaid checkout already cancelled (BH-95080626).
 * Marking one would put its full price back into revenue. An existing
 * non-arrival is cancelled by design, so it stays allowed — re-running the
 * action only re-asserts the channel lock.
 */
export function nonArrivalBlockReason(booking: {
  isCancelled?: boolean;
  isBlackout?: boolean;
  nonArrival?: NonArrival | null;
}): string | null {
  if (booking.isBlackout) return "Blackouts can't be marked as non-arrival";
  if (booking.isCancelled && !booking.nonArrival) {
    return "This booking is already cancelled in Beds24, so it can't be marked as a non-arrival";
  }
  return null;
}
