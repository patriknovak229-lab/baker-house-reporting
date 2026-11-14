/**
 * Booking.com Visibility Booster — the economics the "booster candidates" list
 * on the Pricing → Radar tab runs on. Client-safe (plain constants).
 *
 * WHERE THE NUMBERS COME FROM (2026-11-13 analysis): commission ÷ Beds24 price
 * in `bookings_mirror`.
 *   - 19.3 % on every Booking.com booking since mid-May 2026 = the Preferred
 *     Partner contract (18 %) plus the Payments-by-Booking fee.
 *   - 26.1–26.2 % on the six bookings for boosted check-in dates (4–13 Nov 2026).
 * Both go stale silently if the contract, the Preferred status or the booster
 * slider changes — re-measure them with a commission ÷ price query, the same way.
 */
export const BOOSTER_ECONOMICS = {
  /** All-in Booking.com cost on a normal booking, share of the Beds24 price. */
  baseCommission: 0.193,
  /** All-in cost on a booking for a boosted check-in date (booster slider at 25 %). */
  boostedCommission: 0.2615,
  /**
   * Cleaning, laundry, consumables per sold night as a share of net revenue.
   * About 15 % on every unit (deal-structure analysis, 2026-11-11).
   */
  variableCostShareOfNet: 0.15,
  /**
   * How much more booking demand a boosted date attracts — an ASSUMPTION.
   * Booking.com publishes no figure for the Visibility Booster; its only number
   * is "+20 % more bookings" for the Preferred programme (about +3 points of
   * commission). Using that as the booster's uplift is deliberately cautious.
   * Tune it once the boosted dates have a track record.
   */
  assumedDemandUplift: 0.2,
  /**
   * Booking.com guest price ÷ PriceLabs live price. Booking sells at price1 × 1.3,
   * then the deal, Genius and mobile discounts take it to roughly 0.9× (realised
   * Booking ADR ÷ live price, Urban Dec 2026). Only used to size the Kč column.
   */
  bookingPriceFactor: 0.9,
} as const;

/** How far ahead the list looks. The booster is a short-term, per-date tool. */
export const BOOSTER_HORIZON_DAYS = 30;

/**
 * How many days of past nights the "chance it sells anyway" curve learns from.
 * 180 days is mostly high season, so in winter the curve OVERSTATES the chance a
 * night sells on its own — the list errs towards "don't boost", which is the
 * cheap mistake.
 */
export const BOOSTER_HISTORY_DAYS = 180;
