import { describe, it, expect } from "vitest";
import { nonArrivalBlockReason } from "./nonArrival";

/**
 * "Mark as non-arrival" puts the booking's full price into revenue. On a booking
 * Beds24 already has as cancelled (BH-95080626, an unpaid checkout saved
 * cancelled) that would invent 11 969 Kč, so the drawer hides the action and the
 * API refuses it — but an existing non-arrival, cancelled by design, stays allowed.
 */

const flagged = {
  flaggedAt: "2026-11-09T10:00:00Z",
  flaggedBy: "ops@bakerhouse.cz",
  originalPriceCzk: 11969,
};

describe("nonArrivalBlockReason", () => {
  it("allows a live booking", () => {
    expect(nonArrivalBlockReason({ isCancelled: false })).toBeNull();
    expect(nonArrivalBlockReason({})).toBeNull();
  });

  it("blocks a booking already cancelled in Beds24", () => {
    expect(nonArrivalBlockReason({ isCancelled: true })).toMatch(/already cancelled/);
    expect(nonArrivalBlockReason({ isCancelled: true, nonArrival: null })).toMatch(/already cancelled/);
  });

  it("allows an existing non-arrival (re-asserting the channel lock)", () => {
    expect(nonArrivalBlockReason({ isCancelled: true, nonArrival: flagged })).toBeNull();
  });

  it("blocks a blackout", () => {
    expect(nonArrivalBlockReason({ isBlackout: true })).toMatch(/Blackouts/);
  });
});
