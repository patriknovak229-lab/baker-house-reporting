import { describe, it, expect } from "vitest";
import { detectRateType } from "./rateType";

/**
 * Booking.com rate-plan detection from real rateDescription strings.
 *
 * Regression guard for the 2026-09-20 fix: some rooms (notably K.201, and some
 * Deluxe plans) name their non-refundable plan with the abbreviated "Non-Ref"
 * instead of the full "Non-Refundable" / "Non Refundable" others use — these
 * came through undetected (rate type missing → manual). The strings below are
 * verbatim plan phrases pulled from live Baker House bookings.
 */
const bcom = (rd: string) => detectRateType({ channel: "Booking.com", signals: [rd] });

describe("detectRateType — Booking.com non-refundable vocabulary", () => {
  it("detects the abbreviated 'Non-Ref' plan name (the reported bug)", () => {
    expect(bcom("2026-09-21 (63119086 Non-Ref K201 rewritten from  Limited Time Deal) CZK 2851.11")).toBe("Non-Refundable");
    expect(bcom("2026-09-26 (63119086 Non-Ref K201 rewritten from  Last Minute) CZK 4484.52 genius")).toBe("Non-Refundable");
    expect(bcom("2026-10-03 (63119086 Non-Ref K201 rewritten from  Early Booker Deal) CZK 4000.81 genius")).toBe("Non-Refundable");
    expect(bcom("2026-09-18 (60681829 Non-Ref 1KK Deluxe rewritten from  Last Minute) CZK 2382.42 genius")).toBe("Non-Refundable");
  });

  it("still detects the full non-refundable forms across rooms", () => {
    expect(bcom("(1 Non-Refundable Urban 1KK rewritten from  Early Booker Deal) CZK 1")).toBe("Non-Refundable");
    expect(bcom("(1 Non Refundable O308 rewritten from  August Deal) CZK 1")).toBe("Non-Refundable");
    expect(bcom("(1 Non-refundable Rate-One-Bedroom Apartment-1541267401 rewritten from  Last Minute Deal) CZK 1")).toBe("Non-Refundable");
    expect(bcom("(1 Non-Refundable Double Bedroom) CZK 1")).toBe("Non-Refundable");
  });

  it("keeps classifying the other plan types correctly", () => {
    expect(bcom("(1 Flexible K201 rewritten from  Early Booker Deal) CZK 1")).toBe("Flexi");
    expect(bcom("(1 One Night Stays K201 rewritten from  Last Minute Deal) CZK 1")).toBe("One-Night");
    expect(bcom("(1 Weekly rate K201) CZK 1")).toBe("Weekly");
    expect(bcom("(1 Standard Rate) CZK 1")).toBe("Standard");
  });

  it("does not treat an unrelated 'ref' word as non-refundable (\\b guard)", () => {
    // "non reference"/"non refurbished" must not flip a Flexi plan to Non-Refundable.
    expect(bcom("(1 Flexible K201 — see booking non reference note) CZK 1")).toBe("Flexi");
  });
});
