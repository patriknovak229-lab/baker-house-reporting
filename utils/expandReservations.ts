import type { Reservation } from "@/types/reservation";
import { splitBySegments } from "@/utils/roomSegments";
import { revenueSpansOf } from "@/utils/reservationRevenue";

/**
 * Expands package/virtual-room reservations for per-room performance calculations.
 *
 * A merged reservation (e.g. "K.202 + K.203") has linkedRooms = ["K.202", "K.203"].
 * For revenue/occupancy reporting each room should carry an equal share of the price
 * and commission. This function splits such reservations into N copies — one per room —
 * each with price / N and commissionAmount / N.
 *
 * A guest moved MID-STAY (`roomSegments`) is split the same way, by nights:
 * each room gets its own dates and a nights-proportional share of the money
 * (see utils/roomSegments.ts). Every per-apartment view already runs through
 * here, which is why the split lives here and not in each view.
 *
 * A SHORTENED stay spreads its money over the original nights, not evenly over
 * its own (see `shortenedRevenueSpans`). Those spans depend on the booking's
 * total price, which a piece no longer knows, so they are worked out here on
 * the whole booking and handed to every piece as `revenueSpans`.
 *
 * Standalone reservations pass through unchanged. Running this twice is safe:
 * pieces carry neither linkedRooms nor roomSegments.
 */
export function expandLinkedReservations(reservations: Reservation[]): Reservation[] {
  const result: Reservation[] = [];

  for (const res of reservations) {
    if (res.roomSegments && res.roomSegments.length > 1) {
      result.push(...splitBySegments(res));
      continue;
    }
    if (!res.linkedRooms || res.linkedRooms.length <= 1) {
      result.push(res);
      continue;
    }

    const n = res.linkedRooms.length;
    // Every room shares the same dates and an equal cut of the money, so the
    // whole booking's spans (shares, not amounts) hold for each piece as-is.
    const revenueSpans = revenueSpansOf(res) ?? undefined;
    for (const room of res.linkedRooms) {
      result.push({
        ...res,
        room,
        linkedRooms: undefined, // prevent double-expansion
        revenueSpans,
        price: Math.round(res.price / n),
        commissionAmount: Math.round(res.commissionAmount / n),
        paymentChargeAmount: Math.round(res.paymentChargeAmount / n),
        amountPaid: Math.round(res.amountPaid / n),
      });
    }
  }

  return result;
}
