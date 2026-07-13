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
export const EARLY_CHECKIN_TIME = "13:00";
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
 * Perks a booked rate grants before any operator override.
 *   Non-Refundable / One-Night → none
 *   Standard → late checkout
 *   Flexi    → early check-in + late checkout
 *   Weekly   → early check-in + late checkout + welcome bottle of wine
 */
export function autoRatePerks(rate: RateType | null | undefined): RatePerks {
  switch (rate) {
    case "Standard":
      return { earlyCheckIn: false, lateCheckout: true, specialTreatment: null };
    case "Flexi":
      return { earlyCheckIn: true, lateCheckout: true, specialTreatment: null };
    case "Weekly":
      return { earlyCheckIn: true, lateCheckout: true, specialTreatment: WINE_TREATMENT_NOTE };
    default:
      return { earlyCheckIn: false, lateCheckout: false, specialTreatment: null };
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
