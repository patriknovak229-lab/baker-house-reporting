import { describe, it, expect } from "vitest";
import {
  channelHasRatePlan,
  detectRateType,
  isRateTypeInScope,
  RATE_TYPE_LAUNCH_DATE,
} from "./rateType";
import { autoRatePerks, STANDARD_PERK_CHANGE_DATE } from "./ratePerks";

/**
 * Phone bookings sell the same single direct rate as the website, so they get
 * the Standard rate — and, because perks key off the rate alone, the same
 * Standard perk a web booking gets. Legacy "Direct" (unknown Beds24-UI origin)
 * stays excluded.
 */
describe("Direct-Phone rate plan", () => {
  it("counts as a rate-plan channel alongside Direct-Web", () => {
    expect(channelHasRatePlan("Direct-Phone")).toBe(true);
    expect(channelHasRatePlan("Direct-Web")).toBe(true);
    expect(channelHasRatePlan("Direct")).toBe(false);
  });

  it("always detects Standard, with or without rate text", () => {
    expect(detectRateType({ channel: "Direct-Phone", signals: [] })).toBe("Standard");
    expect(detectRateType({ channel: "Direct-Phone", signals: [null, ""] })).toBe("Standard");
    // Stray channel vocabulary in the comments must not reclassify it.
    expect(
      detectRateType({ channel: "Direct-Phone", signals: ["Non-Refundable weekly flexi"] }),
    ).toBe("Standard");
    expect(detectRateType({ channel: "Direct", signals: ["Standard Rate"] })).toBeNull();
  });

  it("is in scope on the same terms as any other rate-plan channel", () => {
    const today = "2026-08-21";
    // Past stay booked before the rate launch → out of scope, no backfill.
    expect(
      isRateTypeInScope(
        { channel: "Direct-Phone", reservationDate: "2026-01-01", checkOutDate: "2026-02-01" },
        today,
      ),
    ).toBe(false);
    // Booked since launch → in scope even after checkout.
    expect(
      isRateTypeInScope(
        {
          channel: "Direct-Phone",
          reservationDate: RATE_TYPE_LAUNCH_DATE,
          checkOutDate: "2026-07-01",
        },
        today,
      ),
    ).toBe(true);
    // Upcoming stay → in scope regardless of when it was booked.
    expect(
      isRateTypeInScope(
        { channel: "Direct-Phone", reservationDate: "2020-01-01", checkOutDate: "2026-09-01" },
        today,
      ),
    ).toBe(true);
  });

  it("earns the same Standard perk a web booking of the same vintage earns", () => {
    const phone = detectRateType({ channel: "Direct-Phone", signals: [] });
    const web = detectRateType({ channel: "Direct-Web", signals: [] });
    expect(autoRatePerks(phone, STANDARD_PERK_CHANGE_DATE)).toEqual(
      autoRatePerks(web, STANDARD_PERK_CHANGE_DATE),
    );
    expect(autoRatePerks(phone, STANDARD_PERK_CHANGE_DATE)).toEqual({
      earlyCheckIn: true,
      lateCheckout: false,
      specialTreatment: null,
    });
    // Booked before the perk change → keeps the old late-checkout perk.
    expect(autoRatePerks(phone, "2026-07-01")).toEqual({
      earlyCheckIn: false,
      lateCheckout: true,
      specialTreatment: null,
    });
  });
});
