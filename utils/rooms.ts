// Canonical Beds24 room-id → label mapping + review-fetch constants.
//
// NOTE: app/api/bookings/route.ts currently keeps its own inline copies of
// UNIT_MAP / VR_ROOM_LABELS / mapRoom / PHYSICAL_ROOM_IDS / REVIEWS_PROPERTY_ID.
// This module is the intended single source of truth for NEW code (e.g. the
// review-notification cron); the bookings route should be migrated onto it in a
// follow-up so the two can't drift.

import type { Room } from "@/types/reservation";

/** Physical unit roomId → display name. */
export const UNIT_MAP: Record<number, Room> = {
  // Deluxe
  656437: "K.201",
  648596: "K.202",
  648772: "K.203",
  674672: "O.308",
  // Urban
  679703: "K.102",
  679704: "K.103",
  679705: "K.106",
};

/** Virtual/selling room (room TYPE) labels — no physical allocation yet. */
export const VR_ROOM_LABELS: Record<number, string> = {
  679714: "1KK Urban Studios",
  648816: "1KK Deluxe Studios",
};

/** Physical roomIds to sweep for Airbnb per-room review fetches. */
export const PHYSICAL_ROOM_IDS: number[] = [
  656437, // K.201
  648596, // K.202
  648772, // K.203
  674672, // O.308
  679703, // K.102
  679704, // K.103
  679705, // K.106
];

/** Beds24 property id (single-property account) — Booking.com review fetch. */
export const REVIEWS_PROPERTY_ID = 311322;

/** Map a Beds24 roomId to its display name; screams rather than misattributing. */
export function mapRoom(roomId: number): Room {
  if (UNIT_MAP[roomId]) return UNIT_MAP[roomId];
  if (VR_ROOM_LABELS[roomId]) return VR_ROOM_LABELS[roomId];
  return `Unknown room ${roomId}`;
}
