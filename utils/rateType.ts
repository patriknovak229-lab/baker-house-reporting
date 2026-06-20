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
 * Rate-type tracking is intentionally NOT backfilled — it applies only to stays
 * that are current or upcoming. A reservation is in scope when it is on an OTA
 * channel AND has not yet checked out. `todayYmd` is local YYYY-MM-DD, passed in
 * so server and client agree on "today".
 */
export function isRateTypeInScope(
  args: { channel: Channel; checkOutDate: string },
  todayYmd: string,
): boolean {
  return (
    channelHasRatePlan(args.channel) &&
    !!args.checkOutDate &&
    args.checkOutDate >= todayYmd
  );
}

/** The rate to display/act on: manual override wins over auto-detection. */
export function effectiveRateType(r: {
  rateType?: RateType | null;
  rateTypeOverride?: RateType | null;
}): RateType | null {
  return r.rateTypeOverride ?? r.rateType ?? null;
}

/**
 * Best-effort rate-type detection from Beds24 booking signals.
 *
 * ⚠️ CALIBRATION NEEDED — the exact field Booking.com/Airbnb populate with the
 * rate-plan name is not yet confirmed against live data (Beds24's public wiki is
 * auth-walled). This scans every plausible text signal we fetch. Use
 * `GET /api/bookings?debugRates=true` to dump those fields for real bookings,
 * then tighten the literals below. The manual override + "rate type missing"
 * alert are the safety net so the operator is never blocked or silently
 * misinformed while detection is being calibrated.
 *
 * Returns null when no plan can be inferred → triggers the alert / prompts a
 * manual set. Long Booking.com stays are the expected miss (Beds24 truncates the
 * source text past a char limit), exactly as the operator predicted.
 *
 * Matching is literal-first against the property's actual plan names
 * ("Flexi", "Weekly", …) to avoid false positives from generic words.
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

  // Non-refundable applies to both channels — check first (most specific).
  if (has(/non[\s-]?refundable|non[\s-]?ref\b|\bnonref/)) return "Non-Refundable";

  if (input.channel === "Airbnb") {
    // Airbnb has only two plans; non-refundable handled above, so the rest is
    // the (default) Standard rate. LoS discounts ride on Standard — same type.
    return "Standard";
  }

  // Booking.com — match the property's literal plan names.
  if (has(/\bflexi\b/)) return "Flexi";
  if (has(/\bweekly\b|\bweek\s*rate\b/)) return "Weekly";
  if (has(/\bone[\s-]?night\b|\b1[\s-]?night\b|single[\s-]?night/)) return "One-Night";
  if (has(/\bstandard\b/)) return "Standard";

  return null; // unknown / truncated → alert + manual override
}
