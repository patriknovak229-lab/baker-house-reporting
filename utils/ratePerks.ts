/**
 * Rate-driven guest perks — the single source of truth for the three events we
 * surface per reservation: early check-in, late checkout, and a special
 * treatment (currently a welcome bottle of wine on Weekly stays).
 *
 * Design (mirrors the app's other override layers, e.g. rateTypeOverride):
 *   effective = operator override ?? rate-derived auto value
 * The reporting app owns this — it derives perks from the effective rate on
 * every sync (so cancellations / rate changes self-correct), lets the operator
 * override each event, shows them in the transactions overview, and publishes
 * the EFFECTIVE result to Redis for the cleaning app to consume.
 */

import type { RateType } from "@/types/reservation";

/** Fixed policy times, shared with the cleaning app's messaging. */
export const EARLY_CHECKIN_TIME = "13:30";
export const LATE_CHECKOUT_TIME = "12:00";

/** Default note for the Weekly-stay welcome gift. */
export const WINE_TREATMENT_NOTE = "Bottle of wine, weekly stay";

/** The three rate-driven events, resolved to their effective state. */
export interface RatePerks {
  /** Guest may arrive early (from EARLY_CHECKIN_TIME). */
  earlyCheckIn: boolean;
  /** Guest may stay late (until LATE_CHECKOUT_TIME). */
  lateCheckout: boolean;
  /** Special-treatment note (e.g. the wine), or null when none. */
  specialTreatment: string | null;
}

/**
 * Operator overrides. An absent field falls back to the rate-derived auto value.
 * For `specialTreatment`: a string replaces the note (e.g. a substitute gift),
 * `null` explicitly removes it (e.g. out of wine), absent = use auto.
 */
export interface PerkOverrides {
  earlyCheckIn?: boolean;
  lateCheckout?: boolean;
  specialTreatment?: string | null;
}

/**
 * Standard-rate perk change. The Standard rate's perk was reworked: it now
 * grants an early check-in instead of a late check-out. Gated by booking-made
 * date so bookings keep what they were sold — only Standard reservations CREATED
 * on/after this date get the new perk; earlier ones keep the previous late
 * check-out. Compared against the reservation's `reservationDate` (YYYY-MM-DD);
 * an empty/unknown date is treated as pre-change (keeps late check-out).
 */
export const STANDARD_PERK_CHANGE_DATE = "2026-07-23";

/**
 * Standard loses its early check-in on every channel. Patrik took it off the
 * Booking.com Standard rate's listed benefits on this date (over the previous 90
 * days that rate earned no more gross profit than Non-refundable, and the perk
 * had no visible pull on how many guests chose it), then, on 2026-11-28, off
 * Standard on the web, by phone and on Airbnb too. Standard reservations
 * CREATED on/after this date carry no perk at all; earlier ones keep what they
 * were sold. Early check-in now comes only with Flexi, Weekly or a manual
 * operator override.
 */
export const STANDARD_NO_PERK_DATE = "2026-11-27";

const NO_PERKS: RatePerks = { earlyCheckIn: false, lateCheckout: false, specialTreatment: null };

/**
 * Perks a booked rate grants before any operator override.
 *   Non-Refundable / One-Night → none
 *   Standard → late check-out   (booked before STANDARD_PERK_CHANGE_DATE)
 *           → early check-in    (booked on/after STANDARD_PERK_CHANGE_DATE)
 *           → none              (booked on/after STANDARD_NO_PERK_DATE, any channel)
 *   Flexi    → early check-in + late checkout
 *   Weekly   → early check-in + late checkout + welcome bottle of wine
 *
 * `reservationDate` is the booking-made date (YYYY-MM-DD); it only drives the
 * Standard rate's gates. `_channel` is accepted for channel-specific rules but
 * no rate currently depends on it.
 */
export function autoRatePerks(
  rate: RateType | null | undefined,
  reservationDate?: string | null,
  _channel?: string | null,
): RatePerks {
  switch (rate) {
    case "Standard": {
      if (!!reservationDate && reservationDate >= STANDARD_NO_PERK_DATE) {
        return { ...NO_PERKS };
      }
      const bookedSinceChange = !!reservationDate && reservationDate >= STANDARD_PERK_CHANGE_DATE;
      return bookedSinceChange
        ? { earlyCheckIn: true, lateCheckout: false, specialTreatment: null }
        : { earlyCheckIn: false, lateCheckout: true, specialTreatment: null };
    }
    case "Flexi":
      return { earlyCheckIn: true, lateCheckout: true, specialTreatment: null };
    case "Weekly":
      return { earlyCheckIn: true, lateCheckout: true, specialTreatment: WINE_TREATMENT_NOTE };
    default:
      return { ...NO_PERKS };
  }
}

/** Effective perks = operator override wins over the rate-derived auto value. */
export function effectiveRatePerks(auto: RatePerks, override?: PerkOverrides | null): RatePerks {
  if (!override) return auto;
  return {
    earlyCheckIn: override.earlyCheckIn ?? auto.earlyCheckIn,
    lateCheckout: override.lateCheckout ?? auto.lateCheckout,
    // `undefined` = use auto; a string or explicit null overrides it.
    specialTreatment:
      override.specialTreatment !== undefined ? override.specialTreatment : auto.specialTreatment,
  };
}

/** True when a field of the override differs from the rate-derived auto value. */
export function isPerkOverridden(auto: RatePerks, override: PerkOverrides | null | undefined): boolean {
  if (!override) return false;
  return (
    (override.earlyCheckIn !== undefined && override.earlyCheckIn !== auto.earlyCheckIn) ||
    (override.lateCheckout !== undefined && override.lateCheckout !== auto.lateCheckout) ||
    (override.specialTreatment !== undefined && override.specialTreatment !== auto.specialTreatment)
  );
}

export function hasAnyPerk(p: RatePerks): boolean {
  return p.earlyCheckIn || p.lateCheckout || p.specialTreatment != null;
}
