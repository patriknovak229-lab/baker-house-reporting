import type { Reservation } from "@/types/reservation";
import { PRORATED_FIELDS, allocate, splitBySegments } from "@/utils/roomSegments";
import { revenueSpansOf } from "@/utils/reservationRevenue";

/**
 * Expands package/virtual-room reservations for per-room performance calculations.
 *
 * A merged reservation (e.g. "K.202 + K.203") has linkedRooms = ["K.202", "K.203"].
 * For revenue/occupancy reporting each room should carry its share of the price
 * and commission. This function splits such reservations into N copies — one per room —
 * each with price / N and commissionAmount / N, or — when the apartments were
 * priced on their own (`linkedRoomShares`, Booking.com multi-room) — each with
 * its own share: O.308 6 290 + Urban 3 898 CZK stays 6 290 / 3 898, not 5 094
 * each. Those apartments often belong to different owners.
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
    // Every room shares the same dates, so the whole booking's spans (shares,
    // not amounts) hold for each piece as-is, whatever its cut of the money.
    const revenueSpans = revenueSpansOf(res) ?? undefined;
    const shares = res.linkedRoomShares?.length === n ? res.linkedRoomShares : null;
    if (shares) {
      // In haléř, not whole CZK: the shares come from each apartment's own
      // Beds24 price, so the pieces land on exactly those prices (6 290.20 +
      // 3 897.58), the last one absorbing any rounding.
      const toHaler = (total: number) => allocate(Math.round(total * 100), shares).map((h) => h / 100);
      const parts = Object.fromEntries(PRORATED_FIELDS.map((f) => [f, toHaler(res[f] ?? 0)])) as Record<
        (typeof PRORATED_FIELDS)[number],
        number[]
      >;
      res.linkedRooms.forEach((room, i) => {
        result.push({
          ...res,
          room,
          linkedRooms: undefined, // prevent double-expansion
          linkedRoomShares: undefined,
          revenueSpans,
          price: parts.price[i],
          commissionAmount: parts.commissionAmount[i],
          paymentChargeAmount: parts.paymentChargeAmount[i],
          amountPaid: parts.amountPaid[i],
        });
      });
      continue;
    }
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
