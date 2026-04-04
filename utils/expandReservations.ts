import type { Reservation } from "@/types/reservation";

/**
 * Expands package/virtual-room reservations for per-room performance calculations.
 *
 * A merged reservation (e.g. "K.202 + K.203") has linkedRooms = ["K.202", "K.203"].
 * For revenue/occupancy reporting each room should carry an equal share of the price
 * and commission. This function splits such reservations into N copies — one per room —
 * each with price / N and commissionAmount / N.
 *
 * Standalone reservations pass through unchanged.
 */
export function expandLinkedReservations(reservations: Reservation[]): Reservation[] {
  const result: Reservation[] = [];

  for (const res of reservations) {
    if (!res.linkedRooms || res.linkedRooms.length <= 1) {
      result.push(res);
      continue;
    }

    const n = res.linkedRooms.length;
    for (const room of res.linkedRooms) {
      result.push({
        ...res,
        room,
        linkedRooms: undefined, // prevent double-expansion
        price: Math.round(res.price / n),
        commissionAmount: Math.round(res.commissionAmount / n),
        paymentChargeAmount: Math.round(res.paymentChargeAmount / n),
        amountPaid: Math.round(res.amountPaid / n),
      });
    }
  }

  return result;
}
