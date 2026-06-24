/**
 * Rate-type detection, labels, and visual styling — kept in one place so the
 * Beds24 parser, the transactions table, and the reservation drawer all agree.
 *
 * Colors mirror the tinted-chip visual language of utils/roomVisuals.ts
 * (bg-X-50 / text-X-700|800 / ring-X-200). Per operator spec:
 *   Non-Refundable → red · Standard → blue · Flexi → green ·
 *   Weekly → yellow · One-Night → violet
 */

import type { RateType, Channel } from "@/types/reservation";

export const RATE_TYPES: RateType[] = [
  "Non-Refundable",
  "Standard",
  "Flexi",
  "One-Night",
  "Weekly",
];

/** Full label — used in the drawer where there's room. */
export const RATE_TYPE_LABELS: Record<RateType, string> = {
  "Non-Refundable": "Non-Refundable",
  "Standard": "Standard",
  "Flexi": "Flexi",
  "One-Night": "One-Night",
  "Weekly": "Weekly",
};

/** Compact label — used in the dense, right-aligned price column. */
export const RATE_TYPE_SHORT: Record<RateType, string> = {
  "Non-Refundable": "Non-Ref",
  "Standard": "Standard",
  "Flexi": "Flexi",
  "One-Night": "1-Night",
  "Weekly": "Weekly",
};

const RATE_STYLES: Record<RateType, { bg: string; text: string; ring: string }> = {
  "Non-Refundable": { bg: "bg-red-50",     text: "text-red-700",     ring: "ring-red-200" },
  "Standard":       { bg: "bg-blue-50",    text: "text-blue-700",    ring: "ring-blue-200" },
  "Flexi":          { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200" },
  "Weekly":         { bg: "bg-yellow-50",  text: "text-yellow-800",  ring: "ring-yellow-200" },
  "One-Night":      { bg: "bg-violet-50",  text: "text-violet-700",  ring: "ring-violet-200" },
};

/**
 * Inline chip className for a rate type.
 * Use as: `<span className={rateChipClasses(rt)}>{RATE_TYPE_SHORT[rt]}</span>`
 */
export function rateChipClasses(rt: RateType): string {
  const p = RATE_STYLES[rt];
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset ${p.bg} ${p.text} ${p.ring}`;
}

/** OTA channels that carry a rate plan. Direct bookings have no channel rate. */
export function channelHasRatePlan(channel: Channel): boolean {
  return channel === "Booking.com" || channel === "Airbnb";
}

/**
 * The date the business introduced the new rate plans + their perks (early
 * check-in / late check-out). Only bookings CREATED on/after this date carry the
 * new rates, so rate tracking is scoped to them — no backfill of older bookings,
 * which were made under the previous structure without perks.
 */
export const RATE_TYPE_LAUNCH_DATE = "2026-06-20";

/**
 * In scope (show + detect a rate) when an OTA booking is EITHER a current/future
 * stay (check-out >= today) OR was created on/after the launch date. The union
 * keeps rates on every active/upcoming booking AND retains them for post-launch
 * bookings even after they check out — so short/just-ended stays don't lose
 * their chip. `todayYmd` is YYYY-MM-DD (caller passes it so server and client
 * agree on "today").
 */
export function isRateTypeInScope(
  args: { channel: Channel; reservationDate: string; checkOutDate: string },
  todayYmd: string,
): boolean {
  if (!channelHasRatePlan(args.channel)) return false;
  const bookedSinceLaunch = !!args.reservationDate && args.reservationDate >= RATE_TYPE_LAUNCH_DATE;
  const currentOrFuture = !!args.checkOutDate && args.checkOutDate >= todayYmd;
  return bookedSinceLaunch || currentOrFuture;
}

/** The rate to display/act on: manual override wins over auto-detection. */
export function effectiveRateType(r: {
  rateType?: RateType | null;
  rateTypeOverride?: RateType | null;
}): RateType | null {
  return r.rateTypeOverride ?? r.rateType ?? null;
}

/**
 * Rate-type detection from Beds24 `rateDescription` (+ apiReference / infoItems).
 * Calibrated against live Baker House bookings on 2026-06-20 (n=85 current/future
 * OTA stays; 84 auto-classified, 1 genuinely unnamed → manual).
 *
 * Real signal formats found:
 *   Booking.com — per-night lines, plan name in parens, e.g.
 *     "2026-09-04 (65571638 Flexible 1 day Urban …) CZK 2727.63 genius".
 *     Vocabulary seen: "Standard Rate", "Non-Refundable …"/"Non Refundable …",
 *     "Weekly rate …", "Flexible …"/"Flexibl …". A bare "<date> Rate (<id>)"
 *     with no plan name → null → alert + manual.
 *   Airbnb — plan is in the cancel policy: "Cancel policy
 *     tiered_pricing_non_refundable" → Non-Refundable; "moderate"/other →
 *     Standard. NOTE the underscore in "non_refundable".
 *
 * Returns null only when no plan can be inferred (unnamed Booking.com rate, or
 * truncation) → "rate type missing" alert + manual override. Matching is
 * case-insensitive substring ("flexi" catches "Flexible").
 *
 * Re-calibrate via GET /api/bookings?debugRates=true if the channels change
 * wording or the property adds rate plans.
 */
export function detectRateType(input: {
  channel: Channel;
  /** Any text fields that might mention the rate plan (rateDescription, etc.). */
  signals: Array<string | null | undefined>;
}): RateType | null {
  if (!channelHasRatePlan(input.channel)) return null;

  const hay = input.signals
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" • ")
    .toLowerCase();
  if (!hay.trim()) return null;

  const has = (re: RegExp) => re.test(hay);

  // Non-refundable — both channels. Allow space/underscore/hyphen so Airbnb's
  // cancel-policy code "non_refundable" matches alongside "Non-Refundable".
  if (has(/non[\s_-]?refundable|nonref/)) return "Non-Refundable";

  // Airbnb has only two plans; anything not non-refundable is Standard (its
  // length-of-stay discounts ride on Standard — same rate type).
  if (input.channel === "Airbnb") return "Standard";

  // Booking.com plan names — substring match ("flexi" catches "Flexible").
  // "1 day"/"genius" in the text are cancellation-window / loyalty noise.
  if (has(/weekly|week rate|7 nights?/)) return "Weekly";
  if (has(/flexi/)) return "Flexi";
  if (has(/one[\s-]?night|1[\s-]?night|single[\s-]?night/)) return "One-Night";
  if (has(/standard/)) return "Standard";

  return null; // unnamed / truncated → alert + manual override
}
