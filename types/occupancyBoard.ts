/**
 * PII-free occupancy board served to the stakeholder /occupancy page.
 *
 * Contains ONLY occupied/free night booleans + occupancy percentages — never
 * any guest, reservation, channel, price or payment data. Built server-side in
 * app/api/occupancy/route.ts from the shared occupancy cache; this is the whole
 * shape the stakeholder browser ever receives.
 */
export interface OccupancyRoomRow {
  room: string;
  soldNights: number;
  availableNights: number;
  occupancyPct: number;
}

export interface OccupancyBoard {
  /** ISO timestamp of the last Sync, or null if never synced. */
  syncedAt: string | null;
  period: { start: string; end: string; label: string };
  rooms: string[];
  overall: { soldNights: number; availableNights: number; occupancyPct: number };
  perRoom: OccupancyRoomRow[];
  calendar: { dates: string[]; perRoom: { room: string; occupied: boolean[] }[] };
}

/** Envelope returned by GET/POST /api/occupancy. */
export interface OccupancyResponse {
  /** True when no Sync has ever populated the cache — the UI prompts to Sync. */
  neverSynced: boolean;
  syncedAt: string | null;
  /** Selectable date bounds (current month start → +12 months); no past. */
  horizon: { start: string; end: string };
  /** Null only when neverSynced. */
  board: OccupancyBoard | null;
}
