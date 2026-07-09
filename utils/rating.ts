import type { Reservation, GuestRating, RatingStatus } from "@/types/reservation";

// Guest-rating derivation. A reservation can carry two rating sources:
//   • syncedRating  — pulled from Beds24's Booking.com / Airbnb review endpoints
//   • manualRating  — operator-entered fallback (Google, Direct, or pre-review)
// Synced always wins; manual is the fallback. The legacy good/bad `ratingStatus`
// is the last resort when there is no numeric rating at all.

/** The rating that should drive the smiley + displayed value: synced first, then manual. */
export function effectiveRating(r: Reservation): GuestRating | null {
  return r.syncedRating ?? r.manualRating ?? null;
}

/** True when a score is the top of its native scale (Booking 10/10, Airbnb 5/5, Google 5/5). */
export function isTopRating(g: GuestRating): boolean {
  return g.score >= g.scale;
}

/**
 * The overview/header smiley. Driven by the numeric rating's score when one
 * exists; otherwise falls back to the legacy manual good/bad flag. Empty string
 * when there is nothing to show.
 */
export function ratingSmiley(r: Reservation): "😊" | "😡" | "" {
  const g = effectiveRating(r);
  if (g) return isTopRating(g) ? "😊" : "😡";
  if (r.ratingStatus === "good") return "😊";
  if (r.ratingStatus === "bad") return "😡";
  return "";
}

/**
 * Coarse rating class for filtering — mirrors the smiley the operator sees:
 * top-of-scale → "good", any other numeric score (or legacy bad flag) → "bad",
 * nothing on file → "none".
 */
export function ratingClass(r: Reservation): RatingStatus {
  const s = ratingSmiley(r);
  return s === "😊" ? "good" : s === "😡" ? "bad" : "none";
}

/** Native-scale label, e.g. "9.2/10" or "5/5". Trims a trailing ".0". */
export function formatRating(g: GuestRating): string {
  const score = Number.isInteger(g.score) ? String(g.score) : g.score.toFixed(1);
  return `${score}/${g.scale}`;
}
