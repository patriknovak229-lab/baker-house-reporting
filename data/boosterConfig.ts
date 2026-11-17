/**
 * Booking.com Visibility Booster — the economics the "booster candidates" list
 * on the Pricing → Radar tab runs on. Client-safe (plain constants).
 *
 * WHERE THE NUMBERS COME FROM (2026-11-13/17 analyses): commission ÷ Beds24
 * price in `bookings_mirror`.
 *   - 19.3 % on every Booking.com booking since mid-May 2026 = the Preferred
 *     Partner contract (18 %) plus the Payments-by-Booking fee.
 *   - 26.0–26.2 % on every booking for a boosted check-in date (slider at 25 %).
 * Both go stale silently if the contract, the Preferred status or the booster
 * slider changes — re-measure them with a commission ÷ price query, the same way.
 */
export const BOOSTER_ECONOMICS = {
  /** All-in Booking.com cost on a normal booking, share of the Beds24 price. */
  baseCommission: 0.193,
  /** All-in cost on a booking for a boosted check-in date (booster slider at 25 %). */
  boostedCommission: 0.2615,
  /** The booster slider level the list recommends, in nominal commission points. */
  boostLevel: 25,
  /**
   * Cleaning, laundry, consumables per sold night as a share of net revenue.
   * About 15 % on every unit (deal-structure analysis, 2026-11-11).
   */
  variableCostShareOfNet: 0.15,
  /**
   * Chance a still-open room sells once its check-in date is boosted at
   * `boostLevel` — Patrik's assumption (2026-11-17). Boosted dates reach page 1
   * of a Brno search; the first 7 boosted dates (31 Oct–16 Nov) filled 7 of the 8
   * rooms still open (88 %). The card's "track record" line keeps measuring it;
   * move this number when that line says otherwise.
   */
  fillAtBoost: 0.85,
  /**
   * Booking.com guest price ÷ PriceLabs live price. Booking sells at price1 × 1.3,
   * then the deal, Genius and mobile discounts take it to roughly 0.9× (realised
   * Booking ADR ÷ live price, Urban Dec 2026). Only used to size the Kč column.
   */
  bookingPriceFactor: 0.9,
} as const;

/** How far ahead the list looks. The booster is a short-term, per-date tool. */
export const BOOSTER_HORIZON_DAYS = 30;

/** How far back the track record looks for boosted dates and what they filled. */
export const BOOSTER_TRACK_RECORD_DAYS = 30;

/**
 * A Booking.com booking whose all-in commission is above this share of its
 * price was made for a boosted check-in date (19.3 % normally, ~26 % boosted).
 * Any slider level from 20 % up clears it; 19 % would not be detected.
 */
export const BOOSTED_COMMISSION_DETECT = 0.205;

/**
 * How many days of past nights the "chance it sells anyway" curve learns from.
 * 180 days is mostly high season, so in winter the curve OVERSTATES the chance a
 * night sells on its own — the list errs towards "don't boost", which is the
 * cheap mistake.
 */
export const BOOSTER_HISTORY_DAYS = 180;
