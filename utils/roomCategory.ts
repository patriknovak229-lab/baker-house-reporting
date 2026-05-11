/**
 * Room categorisation — Urban vs Deluxe.
 *
 * Two property categories sit under one Beds24 account:
 *   - Urban  (1KK Urban Studios, VR 679714): K.102, K.103, K.106
 *   - Deluxe (2KK Deluxe + Twin Apartments + 2 Bedroom): K.201, K.202, K.203, O.308
 *
 * This util is the single source of truth for which room belongs to which
 * category, and the canonical display order within each. Every UI that
 * groups or styles rooms (calendar, filter chips, drawer) reads from here
 * so adding a future room is a one-line change.
 */

export type RoomCategory = 'Urban' | 'Deluxe';

/** Canonical render order within each category. Used by the calendar group
 *  layout and any room-by-room iteration that wants a stable sequence. */
export const URBAN_ROOMS  = ['K.102', 'K.103', 'K.106'] as const;
export const DELUXE_ROOMS = ['K.201', 'K.202', 'K.203', 'O.308'] as const;

/** Calendar lists Urban first (more turnover / shorter stays expected). */
export const CATEGORY_ORDER: RoomCategory[] = ['Urban', 'Deluxe'];

const URBAN_SET  = new Set<string>(URBAN_ROOMS);
const DELUXE_SET = new Set<string>(DELUXE_ROOMS);

/** Returns the category for a physical room name (e.g. "K.102" → "Urban").
 *  For combined/virtual room labels like "K.102 + K.103" or "K.202 / K.203",
 *  uses the first physical room as the lookup key. Returns null when the
 *  room is unknown (e.g. legacy combined VRs that map to none of the above). */
export function roomToCategory(room: string): RoomCategory | null {
  if (!room) return null;
  // Combined/virtual labels — pick the first component
  const first = room.split(/[\s+/]+/).find((s) => s.includes('.'))?.trim() ?? room;
  if (URBAN_SET.has(first))  return 'Urban';
  if (DELUXE_SET.has(first)) return 'Deluxe';
  return null;
}

/** All physical rooms across both categories, in canonical render order
 *  (Urban first per CATEGORY_ORDER). Used wherever we need the full list. */
export const ALL_ROOMS_BY_CATEGORY = [...URBAN_ROOMS, ...DELUXE_ROOMS] as const;

export interface RoomCategoryGroup {
  category: RoomCategory;
  rooms: readonly string[];
}

/** Returns rooms split into ordered category groups — handy for iterating
 *  with section headers in the UI. */
export function groupRoomsByCategory(): RoomCategoryGroup[] {
  return [
    { category: 'Urban',  rooms: URBAN_ROOMS },
    { category: 'Deluxe', rooms: DELUXE_ROOMS },
  ];
}
