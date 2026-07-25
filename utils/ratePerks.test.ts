import { describe, it, expect } from "vitest";
import {
  autoRatePerks,
  effectiveRatePerks,
  isPerkOverridden,
  hasAnyPerk,
  WINE_TREATMENT_NOTE,
  STANDARD_PERK_CHANGE_DATE,
} from "./ratePerks";

describe("autoRatePerks", () => {
  it("maps each rate to the agreed perks", () => {
    expect(autoRatePerks("Non-Refundable")).toEqual({ earlyCheckIn: false, lateCheckout: false, specialTreatment: null });
    expect(autoRatePerks("One-Night")).toEqual({ earlyCheckIn: false, lateCheckout: false, specialTreatment: null });
    // Standard with no/unknown booking date = pre-change perk (late check-out).
    expect(autoRatePerks("Standard")).toEqual({ earlyCheckIn: false, lateCheckout: true, specialTreatment: null });
    expect(autoRatePerks("Flexi")).toEqual({ earlyCheckIn: true, lateCheckout: true, specialTreatment: null });
    expect(autoRatePerks("Weekly")).toEqual({ earlyCheckIn: true, lateCheckout: true, specialTreatment: WINE_TREATMENT_NOTE });
  });

  it("grants nothing for null/unknown rate", () => {
    expect(hasAnyPerk(autoRatePerks(null))).toBe(false);
    expect(hasAnyPerk(autoRatePerks(undefined))).toBe(false);
  });

  it("date-gates the Standard perk on booking-made date", () => {
    const oldPerk = { earlyCheckIn: false, lateCheckout: true, specialTreatment: null };
    const newPerk = { earlyCheckIn: true, lateCheckout: false, specialTreatment: null };
    // Booked before the change → keeps late check-out.
    expect(autoRatePerks("Standard", "2000-01-01")).toEqual(oldPerk);
    // Empty/unknown date → treated as pre-change.
    expect(autoRatePerks("Standard", "")).toEqual(oldPerk);
    // Booked on the cutoff (inclusive) or later → early check-in, no late check-out.
    expect(autoRatePerks("Standard", STANDARD_PERK_CHANGE_DATE)).toEqual(newPerk);
    expect(autoRatePerks("Standard", "2999-01-01")).toEqual(newPerk);
  });

  it("ignores booking date for non-Standard rates", () => {
    expect(autoRatePerks("Flexi", "2999-01-01")).toEqual({ earlyCheckIn: true, lateCheckout: true, specialTreatment: null });
    expect(autoRatePerks("Weekly", STANDARD_PERK_CHANGE_DATE)).toEqual({ earlyCheckIn: true, lateCheckout: true, specialTreatment: WINE_TREATMENT_NOTE });
    expect(autoRatePerks("Non-Refundable", "2999-01-01")).toEqual({ earlyCheckIn: false, lateCheckout: false, specialTreatment: null });
  });
});

describe("effectiveRatePerks (manual overrides auto)", () => {
  it("returns auto when there is no override", () => {
    expect(effectiveRatePerks(autoRatePerks("Weekly"))).toEqual(autoRatePerks("Weekly"));
  });

  it("lets the operator remove an auto perk (wine ran out)", () => {
    const eff = effectiveRatePerks(autoRatePerks("Weekly"), { specialTreatment: null });
    expect(eff.specialTreatment).toBeNull();
    expect(eff.earlyCheckIn).toBe(true); // untouched
  });

  it("lets the operator substitute the special-treatment note", () => {
    const eff = effectiveRatePerks(autoRatePerks("Weekly"), { specialTreatment: "Box of chocolates" });
    expect(eff.specialTreatment).toBe("Box of chocolates");
  });

  it("lets the operator force a perk on for a rate that doesn't grant it", () => {
    const eff = effectiveRatePerks(autoRatePerks("Standard"), { earlyCheckIn: true });
    expect(eff.earlyCheckIn).toBe(true);
    expect(eff.lateCheckout).toBe(true); // Standard auto
  });

  it("lets the operator force a perk off", () => {
    const eff = effectiveRatePerks(autoRatePerks("Flexi"), { lateCheckout: false });
    expect(eff.lateCheckout).toBe(false);
    expect(eff.earlyCheckIn).toBe(true);
  });

  it("treats undefined override fields as 'use auto'", () => {
    const eff = effectiveRatePerks(autoRatePerks("Weekly"), { earlyCheckIn: undefined });
    expect(eff.earlyCheckIn).toBe(true);
    expect(eff.specialTreatment).toBe(WINE_TREATMENT_NOTE);
  });
});

describe("isPerkOverridden", () => {
  it("is false when override matches auto or is empty", () => {
    expect(isPerkOverridden(autoRatePerks("Weekly"), null)).toBe(false);
    expect(isPerkOverridden(autoRatePerks("Weekly"), {})).toBe(false);
    expect(isPerkOverridden(autoRatePerks("Flexi"), { earlyCheckIn: true })).toBe(false); // same as auto
  });
  it("is true when a field differs from auto", () => {
    expect(isPerkOverridden(autoRatePerks("Weekly"), { specialTreatment: null })).toBe(true);
    expect(isPerkOverridden(autoRatePerks("Standard"), { earlyCheckIn: true })).toBe(true);
  });
});
