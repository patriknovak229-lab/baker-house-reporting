/**
 * What a cancelled booking was worth, and what the channel says it still owes.
 *
 * Pure and client-safe (no I/O), so it can be unit-tested against real Beds24
 * payloads.
 *
 * WHY THE PRICE NEEDS RECOVERING
 * ------------------------------
 * Beds24 reports `price: 0` on most cancelled channel bookings — 83 of 88
 * cancelled Booking.com bookings and all 4 Airbnb ones in the cache on
 * 2026-11-27. Showing 0 Kč makes a cancelled stay look like it was never worth
 * anything, which misleads the operator and the cancellation analytics alike.
 * Two sources bring the value back, in this order:
 *
 *   1. `_priceBeforeCancel` — the last non-zero price our own sync saw for the
 *      booking, carried forward in the Redis cache by `carryPriceBeforeCancel`.
 *      Exact, and the only source for direct bookings, but it exists only for
 *      bookings the cache saw while they still had a price.
 *   2. The rate text Beds24 keeps after the cancellation (`originalNightly`):
 *      Booking.com's per-night "CZK x" lines or Airbnb's "Base Price". On live
 *      bookings this reproduces `price` exactly (474 of 475 Booking.com, 36 of
 *      36 Airbnb). On long stays Beds24 truncates the text, so the value is the
 *      mean night × nights and flagged `approximate`.
 *
 * Recovery only kicks in when Beds24 reports 0. A cancelled booking that still
 * carries a price (direct cancellations, or Booking.com right after a
 * non-refundable cancellation — BH-95759725) keeps Beds24's figure untouched.
 *
 * The recovered price is for DISPLAY and analytics only. A cancelled booking
 * contributes no revenue unless the operator records a retained cancellation
 * fee (see `CancellationFee` and utils/reservationRevenue.ts).
 */
import type { CancellationFeeSuggestion, PriceRecovery } from "@/types/reservation";
import { originalNightly } from "@/utils/rateDescription";

/** The fields of a raw Beds24 booking this module reads. */
export interface CancelledPriceInput {
  status?: string;
  price?: number | null;
  rateDescription?: string | null;
  /** Last non-zero price our sync saw — see `carryPriceBeforeCancel`. */
  _priceBeforeCancel?: number;
}

export function isCancelledStatus(status: string | undefined | null): boolean {
  return status === "cancelled" || status === "canceled";
}

/** Night lines ("YYYY-MM-DD … CZK x") in a Booking.com rate description. */
function nightLineCount(rateDescription: string | null | undefined): number {
  let n = 0;
  for (const raw of (rateDescription ?? "").split("\n")) {
    if (/^\d{4}-\d{2}-\d{2}\s.*\sCZK\s+[0-9]/.test(raw.replace(/\r$/, ""))) n += 1;
  }
  return n;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The price to show for a cancelled booking Beds24 reports at 0 Kč, or null
 * when Beds24 still carries a price (nothing to recover) or nothing is known.
 */
export function recoverCancelledPrice(
  b: CancelledPriceInput,
  nights: number,
): { price: number; recovery: PriceRecovery } | null {
  if (!isCancelledStatus(b.status)) return null;
  const beds24Price = Number(b.price) || 0;
  if (beds24Price > 0) return null;

  const snapshot = Number(b._priceBeforeCancel) || 0;
  if (snapshot > 0) {
    return { price: round2(snapshot), recovery: { beds24PriceCzk: beds24Price, source: "snapshot" } };
  }

  const perNight = originalNightly(b.rateDescription, nights);
  if (perNight !== null && perNight > 0 && nights > 0) {
    const lines = nightLineCount(b.rateDescription);
    // Airbnb's Base Price is the whole stay (lines = 0) — exact. Booking.com
    // is exact only when every night has its line.
    const approximate = lines > 0 && lines < nights;
    return {
      price: round2(perNight * nights),
      recovery: {
        beds24PriceCzk: beds24Price,
        source: "rate-description",
        ...(approximate ? { approximate: true } : {}),
      },
    };
  }
  return null;
}

/**
 * Carry a booking's last non-zero price onto its cancelled copy, so a price
 * Beds24 later zeroes is not lost with the next sync. Called for every booking
 * the sync writes into the Redis cache, with the copy the cache held before.
 *
 * Only cancelled bookings carry the field (keeps the ~1.2 MB cache lean); a
 * booking that is reinstated drops it again.
 */
export function carryPriceBeforeCancel<T extends CancelledPriceInput>(
  previous: T | undefined,
  next: T,
): T {
  if (!isCancelledStatus(next.status)) {
    if (next._priceBeforeCancel === undefined) return next;
    const { _priceBeforeCancel: _drop, ...rest } = next;
    void _drop;
    return rest as T;
  }
  const own = Number(next.price) || 0;
  const remembered =
    own > 0
      ? own
      : Number(previous?._priceBeforeCancel) > 0
        ? Number(previous!._priceBeforeCancel)
        : Number(previous?.price) > 0
          ? Number(previous!.price)
          : 0;
  if (remembered <= 0 || next._priceBeforeCancel === remembered) return next;
  return { ...next, _priceBeforeCancel: remembered };
}

/**
 * Booking.com's own figures for a cancellation, read off the `apiMessage`
 * payload Beds24 stores on cancel:
 *
 *   commissionamount=2200.79
 *   paymentcharge=184.71
 *   currencycode=CZK
 *   total_cancellation_fee=12313.99
 *   totalprice=0
 *
 * Only a SUGGESTION: Booking.com's docs say the fee in the cancellation message
 * is the policy's fee even when the host waives it, and the field has been
 * seen on a single booking so far. The operator confirms it in the drawer.
 * Null when there is no positive fee.
 */
export function parseCancellationFeeSuggestion(
  apiMessage: string | null | undefined,
): CancellationFeeSuggestion | null {
  const text = apiMessage ?? "";
  const num = (key: string): number => {
    const m = new RegExp(`(?:^|\\n)\\s*${key}=([0-9]+(?:\\.[0-9]+)?)`, "i").exec(text);
    return m ? Number(m[1]) : 0;
  };
  const amountCzk = num("total_cancellation_fee");
  if (!(amountCzk > 0)) return null;
  const currency = /(?:^|\n)\s*currencycode=([A-Z]{3})/i.exec(text)?.[1]?.toUpperCase();
  if (currency && currency !== "CZK") return null;
  return {
    amountCzk: round2(amountCzk),
    commissionCzk: round2(num("commissionamount")),
    paymentChargeCzk: round2(num("paymentcharge")),
  };
}
