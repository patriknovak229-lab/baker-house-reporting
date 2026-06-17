/**
 * Shareable occupancy snapshot.
 *
 * An operator picks apartment(s) + a period in the Performance tab and
 * mints a public, read-only link. The numbers are FROZEN at creation
 * (recomputed on demand via "Regenerate") so what a recipient sees can
 * never silently drift from what the operator shared.
 *
 * Privacy: the stored `data` is deliberately PII-free — only aggregate
 * metrics and an anonymized occupied/free night grid. No guest names,
 * emails, or per-booking prices ever land in a snapshot, so the public
 * link can't leak the booking database. `createdBy` (operator email) is
 * stored for the admin management list but is stripped before anything
 * is served publicly (see `toPublicSnapshot`).
 */

/** Headline metrics, mirroring the Performance tab's own math exactly. */
export interface SnapshotMetrics {
  /** Occupancy % = soldNights / availableNights, rounded. */
  occupancyPct: number;
  /** Guest nights sold within the period (blackouts excluded, same as dashboard). */
  soldNights: number;
  /** rooms × days-in-period. */
  availableNights: number;
  /** Distinct reservations with ≥1 night in the period. */
  reservationsCount: number;
  /** Gross sales (CZK), pro-rated across month boundaries, refunded excluded.
   *  Omitted entirely when the link was created with gross sales hidden. */
  grossSalesCzk?: number;
}

/** Per-apartment occupancy breakdown. */
export interface PerRoomOccupancy {
  room: string;
  soldNights: number;
  availableNights: number;
  occupancyPct: number;
}

/**
 * Anonymized calendar grid. `dates` is every calendar day in the period
 * (each cell is a night); each room carries a boolean array aligned to
 * `dates` — true = occupied by a guest that night, false = free.
 */
export interface SnapshotCalendar {
  dates: string[]; // ISO YYYY-MM-DD, ascending
  perRoom: Array<{ room: string; occupied: boolean[] }>;
}

/** The full PII-free payload that gets rendered on the public page. */
export interface SnapshotData {
  period: { start: string; end: string; label: string };
  rooms: string[];
  includeGrossSales: boolean;
  metrics: SnapshotMetrics;
  perRoom: PerRoomOccupancy[];
  calendar: SnapshotCalendar;
}

/** Stored record (Redis hash `baker:occupancy-snapshots`, field = token). */
export interface OccupancySnapshot {
  token: string;
  createdAt: string;
  /** Operator email — admin-only; never served publicly. */
  createdBy: string;
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null;
  data: SnapshotData;
}

/** What the public endpoint / page is allowed to see (no operator email). */
export type PublicOccupancySnapshot = Omit<OccupancySnapshot, 'createdBy'>;

export function toPublicSnapshot(s: OccupancySnapshot): PublicOccupancySnapshot {
  // Explicit all-list so we can never accidentally leak a field added later.
  return {
    token: s.token,
    createdAt: s.createdAt,
    expiresAt: s.expiresAt,
    data: s.data,
  };
}
