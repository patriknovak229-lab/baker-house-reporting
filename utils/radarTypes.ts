/**
 * Price Radar response types — client-safe module.
 *
 * Same discipline as `utils/analyticsTypes.ts`: the radar read layer
 * (`data-access/pricing/radar.ts`) touches the database and must never be
 * imported from a client component, so the shapes the UI needs live here and
 * both sides import from this file.
 */

export type DemandLevel = 'low' | 'normal' | 'good' | 'high';

export type PricePosition =
  | 'below-p25'
  | 'p25-50'
  | 'p50-75'
  | 'p75-90'
  | 'above-p90';

export type RadarFlagKind = 'underpriced' | 'overpriced' | 'blocked-hot';

export interface RadarDay {
  date: string;
  /** The unit's own reading; null when masked by unavailability or missing. */
  demand: DemandLevel | null;
  /** Max demand across all units that date — the market's view, never masked. */
  cityDemand: DemandLevel | null;
  /** True when this unit cannot be sold that night (booked or blocked). */
  unavailable: boolean;
  demandColor: string | null;
  livePrice: number | null;
  recommendedPrice: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  medianBooked: number | null;
  /** Market occupancy for the night, 0–1. */
  marketOccupancy: number | null;
  /** Share of comp set that booked this night in the last 7 days, 0–1. */
  marketPickup7: number | null;
  nBookings: number | null;
  minStay: number | null;
  position: PricePosition | null;
  flags: RadarFlagKind[];
  /** Labels of curated events covering this night. */
  events: string[];
}

export interface RadarUnit {
  unitId: string;
  label: string;
  listingId: string;
  days: RadarDay[];
  /** Oldest capture vintage among this unit's rows — staleness indicator. */
  capturedAt: string | null;
}

export interface RadarEvent {
  id: string;
  label: string;
  start: string;
  end: string;
  kind: string;
}

export interface RadarResponse {
  units: RadarUnit[];
  events: RadarEvent[];
  from: string;
  to: string;
  generatedAt: string;
}
