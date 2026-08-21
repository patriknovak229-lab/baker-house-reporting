/**
 * Cancellation-policy extraction, deadline maths, labels and styling.
 *
 * The operator's question is narrow: "when does this booking stop being
 * cancellable free of charge?" — i.e. when is the revenue locked in. Answering
 * it needs the policy PER BOOKING, not per rate plan: calibrated against 446
 * live cached bookings on 2026-08-21, the same Booking.com plan name carries
 * different policies (12 × "Standard Rate" → free until 7 days out / 50 %
 * penalty, but 3 more → 3 days / 100 %), and one plan literally named
 * "Non-Refundable Urban 1KK rewritten from Super Last Minute" actually grants a
 * 2-day free window. Deriving the deadline from `rateType` would therefore be
 * silently wrong on ~10 % of current bookings — in the direction that misleads.
 *
 * Where each channel keeps it:
 *
 *   Booking.com — `apiMessage`, as prose in the PROPERTY's language (Czech
 *     here), labelled "Podmínky zrušení rezervace:". Present on 43/43
 *     current+future active stays. Beds24 overwrites apiMessage with a
 *     "commissionamount=0…" payload once a booking is cancelled, and drops it
 *     entirely for older arrivals — both irrelevant to a forward-looking
 *     deadline.
 *   Airbnb — first line of `rateDescription`: "Cancel policy <code>". Live
 *     codes: `tiered_pricing_non_refundable`, `moderate`.
 *   Direct (web/phone) — nothing from Beds24; it's our own house policy,
 *     published on the booking site: free cancellation up to 7 days before
 *     check-in. Hard-coded below as HOUSE_FREE_CANCEL_DAYS.
 *
 * Re-calibrate the Booking.com phrasings and Airbnb codes via
 * GET /api/bookings?debugCancellation=true if a channel changes wording.
 */

import type { Channel } from "@/types/reservation";

/** What kind of answer we could give for a booking. */
export type CancellationKind =
  /** A free-cancellation window exists; `freeUntilDate` says until when. */
  | "free-window"
  /** No free window at all — chargeable from the moment of booking. */
  | "non-refundable"
  /** No policy data for this booking (older arrival, cancelled, odd channel). */
  | "unknown";

/** Where the policy came from — shown to the operator so a hard-coded house
 *  default is never mistaken for channel-supplied truth. */
export type CancellationSource = "Booking.com" | "Airbnb" | "House policy";

export interface CancellationPolicy {
  kind: CancellationKind;
  /** Free-cancellation deadline as YYYY-MM-DD, inclusive (see `freeUntilDate`
   *  semantics in freeCancelDaysLeft). null for non-refundable/unknown. */
  freeUntilDate: string | null;
  /** Days before arrival the free window closes (0 = non-refundable). */
  freeDays: number | null;
  /** Share of the total the guest is charged after the window closes. null when
   *  the source doesn't state one (the house policy doesn't). */
  penaltyPercent: number | null;
  /** Free-text penalty description when it isn't a plain percentage. */
  penaltyNote?: string;
  source: CancellationSource;
  /** The raw sentence/code we parsed, so the operator can verify in the drawer. */
  sourceText?: string;
  /**
   * Hours after BOOKING during which the guest can still cancel free regardless
   * of everything above. Airbnb applies a 24-hour cancellation period to every
   * booking of a stay under 28 nights — per Airbnb's own wording it "applies to
   * all bookings for shorter stays", and the non-refundable option "is still
   * subject to" it. So a non-refundable Airbnb booking made an hour ago is NOT
   * yet locked in, even though its policy says no refund.
   * Booking.com states its window relative to arrival only, so this is unset there.
   */
  graceHoursAfterBooking?: number;
}

/**
 * House policy for direct bookings, from the published booking-site terms:
 * "Free cancellation up to 7 days before check-in" (rental-site
 * src/pages/rezervace.astro / en/booking.astro). The site states no penalty for
 * later cancellations, so we don't invent one — penaltyPercent stays null.
 */
export const HOUSE_FREE_CANCEL_DAYS = 7;

// ─── Booking.com ─────────────────────────────────────────────────────────────

/**
 * Pull the cancellation clause out of Booking.com's `apiMessage`. The message is
 * one blob of property-language prose; the clause is delimited by its label and
 * runs to the next section ("Meal Plan", "Room Rservation Id" — Beds24's own
 * typo — or a blank line).
 */
function extractBookingComClause(apiMessage: string): string | null {
  const m = apiMessage.match(
    /(?:Podmínky zrušení rezervace|Cancellation polic(?:y|ies)|Cancellation conditions)\s*:\s*([\s\S]*?)(?:\n\n|Meal Plan|Room Rservation|Podmínky placení|Prepayment|$)/i,
  );
  if (!m) return null;
  const clause = m[1].replace(/\s+/g, " ").trim();
  return clause.length > 0 ? clause : null;
}

/**
 * Parse a Booking.com clause into structured form. The six live phrasings
 * (all Czech, n=339 cached Booking.com bookings) reduce to two shapes:
 *
 *   non-refundable — "V případě zrušení kdykoli po vytvoření rezervace host
 *                     zaplatí 100 % celkové ceny."
 *   free window    — "Host může zrušit rezervaci zdarma do {1|2|3|7|14} {dne|
 *                     dny|dnů|dní} před příjezdem. V případě zrušení … host
 *                     zaplatí {50|100} % …"
 *
 * English equivalents are matched too, in case the property language is ever
 * switched — Booking.com sends this clause in the property's own language.
 */
export function parseBookingComPolicy(apiMessage: string | null | undefined): CancellationPolicy | null {
  if (!apiMessage) return null;
  const clause = extractBookingComClause(apiMessage);
  if (!clause) return null;

  const penaltyMatch = clause.match(/(?:zaplatí|pay|charged)\s+(\d+)\s*%/i);
  const penaltyPercent = penaltyMatch ? Number(penaltyMatch[1]) : null;

  // Non-refundable: chargeable from booking time, so there is no window at all.
  // Must be checked BEFORE the free-window branch — the two never co-occur, but
  // ordering keeps a future mixed phrasing from being read as a free window.
  if (/zrušení kdykoli po vytvoření rezervace|any time after booking|non[\s-]?refundable/i.test(clause)) {
    return {
      kind: "non-refundable",
      freeUntilDate: null,
      freeDays: 0,
      penaltyPercent: penaltyPercent ?? 100,
      source: "Booking.com",
      sourceText: clause,
    };
  }

  // Free window. Czech declines the noun (1 dne / 2 dny / 3 dnů / 7 dní), so
  // match the number and let the unit be anything word-like.
  const freeMatch = clause.match(
    /(?:zdarma\s+do|free\s+of\s+charge\s+until|free\s+until)\s+(\d+)\s*(?:dní|dnů|dny|dne|den|days?|day)/i,
  );
  if (freeMatch) {
    return {
      kind: "free-window",
      freeUntilDate: null, // filled in by deriveCancellationPolicy, which knows the arrival
      freeDays: Number(freeMatch[1]),
      penaltyPercent,
      source: "Booking.com",
      sourceText: clause,
    };
  }

  // A clause we recognise the label of but not the shape — surface it as unknown
  // WITH the text, so the operator reads the real policy instead of a guess.
  return {
    kind: "unknown",
    freeUntilDate: null,
    freeDays: null,
    penaltyPercent,
    source: "Booking.com",
    sourceText: clause,
  };
}

// ─── Airbnb ──────────────────────────────────────────────────────────────────

/**
 * Airbnb's host-side policy codes → free-cancellation window in days before
 * check-in, plus what the guest forfeits afterwards. Airbnb's cutoffs are NOT
 * the same as Booking.com's, and not the same as the plan names suggest — these
 * values are taken from Airbnb's own policy page (help/article/475, checked
 * 2026-08-21), not inferred:
 *
 *   Flexible — "cancel until 24 hours before check-in for a full refund"
 *   Moderate — "cancel until 5 days before check-in for a full refund"
 *   Limited  — "cancel until 14 days before check-in" (bookings from 2025-10-01)
 *   Firm     — "cancel until 30 days before check-in for a full refund"
 *
 * Only `moderate` and `tiered_pricing_non_refundable` appear in live Baker House
 * data (n=34); the others are here so a listing-level policy change doesn't
 * silently fall through to "unknown".
 *
 * `strict` is deliberately absent: it has no days-before-check-in window at all
 * (full refund only inside the 24 h post-booking period), so it can't be
 * expressed as freeDays — it's handled as non-refundable below.
 */
const AIRBNB_POLICIES: Record<string, { freeDays: number; note: string }> = {
  flexible: { freeDays: 1, note: "Full refund up to 24 h before check-in. After that the host is paid for nights stayed plus one additional night." },
  moderate: { freeDays: 5, note: "Full refund up to 5 days before check-in. After that the host is paid for nights stayed, plus one additional night, plus 50 % of the unspent nights." },
  limited:  { freeDays: 14, note: "Full refund up to 14 days before check-in; 50 % refund from 14 to 7 days out; pro-rated taxes only inside 7 days." },
  firm:     { freeDays: 30, note: "Full refund up to 30 days before check-in; 50 % refund from 30 to 7 days out; pro-rated taxes only inside 7 days." },
};

/**
 * Airbnb switches to its LONG-TERM policies at 28+ nights, and they are not the
 * same rules under the same names — the post-cutoff economics differ (the host
 * is paid for nights spent plus the next 30 nights, rather than a 50 % tier).
 * Two consequences worth knowing before changing the listing settings:
 *   - "Limited" does not exist for 28+ night stays; only Firm and Strict do.
 *   - The non-refundable option is likewise offered only under 28 nights.
 * The free-cancellation CUTOFF for long-term Firm is still 30 days, so only the
 * explanatory note changes — the countdown in the table is unaffected.
 */
const AIRBNB_LONG_TERM_POLICIES: Record<string, { freeDays: number; note: string }> = {
  firm: {
    freeDays: 30,
    note: "Long-term stay (28+ nights): full refund only if cancelled at least 30 days before check-in. After that the host is paid for all nights spent plus the next 30 nights (or all remaining nights, if fewer than 30 remain).",
  },
};

/** Airbnb applies its long-term policy variants from this stay length up. */
const AIRBNB_LONG_TERM_MIN_NIGHTS = 28;

/**
 * Airbnb's universal post-booking cancellation period for stays under 28
 * nights — free to cancel within 24 h of booking whatever the policy says,
 * including the non-refundable option.
 */
export const AIRBNB_GRACE_HOURS = 24;

/**
 * Parse Airbnb's policy from `rateDescription`, whose first line is
 * "Cancel policy <code>". `tiered_pricing_non_refundable` is the guest opting
 * into Airbnb's discounted non-refundable rate.
 */
export function parseAirbnbPolicy(
  rateDescription: string | null | undefined,
  opts: { nights?: number } = {},
): CancellationPolicy | null {
  if (!rateDescription) return null;
  const m = rateDescription.match(/Cancel policy\s+(\S+)/i);
  if (!m) return null;
  const code = m[1].toLowerCase();
  const isLongTerm = (opts.nights ?? 0) >= AIRBNB_LONG_TERM_MIN_NIGHTS;
  // Airbnb's 24-hour cancellation period covers every booking of a stay under
  // 28 nights, whatever the policy. Long-term stays have their own rules
  // (48 h of booking for Strict) already folded into their notes.
  const grace = isLongTerm ? undefined : { graceHoursAfterBooking: AIRBNB_GRACE_HOURS };

  if (/non[\s_-]?refundable/.test(code)) {
    return {
      kind: "non-refundable",
      freeUntilDate: null,
      freeDays: 0,
      penaltyPercent: 100,
      penaltyNote:
        "Guest took Airbnb's discounted non-refundable rate — not subject to the standard " +
        "cancellation policy, so if they cancel they get no refund and the host keeps the entire " +
        "payout for all nights booked. Pro-rated taxes still go back to the guest inside 7 days " +
        "of check-in, and Airbnb's own service fee is never refunded — neither reduces the payout.",
      source: "Airbnb",
      sourceText: m[0],
      ...grace,
    };
  }

  // Strict: no days-before-check-in free window exists — a full refund is only
  // possible inside the window right after booking, so for the operator's
  // purposes the booking is locked from the start.
  if (code.includes("strict")) {
    return {
      kind: "non-refundable",
      freeUntilDate: null,
      freeDays: 0,
      penaltyPercent: null,
      penaltyNote: isLongTerm
        ? "Long-term Strict (28+ nights): full refund only if cancelled within 48 h of booking AND at least 28 days before check-in. After that the host is paid for nights spent plus the next 30 nights."
        : "Strict: no full refund after Airbnb's 24 h post-booking period. 50 % refund if cancelled 7+ days before check-in, pro-rated taxes only inside 7 days.",
      source: "Airbnb",
      sourceText: m[0],
      ...grace,
    };
  }

  // Match the longest known code contained in the string, so Airbnb's
  // "tiered_pricing_moderate"-style variants resolve to their base policy.
  // Long-term variants are consulted first for 28+ night stays.
  const table = isLongTerm ? { ...AIRBNB_POLICIES, ...AIRBNB_LONG_TERM_POLICIES } : AIRBNB_POLICIES;
  const key = Object.keys(table)
    .filter((k) => code.includes(k))
    .sort((a, b) => b.length - a.length)[0];
  if (!key) {
    return {
      kind: "unknown",
      freeUntilDate: null,
      freeDays: null,
      penaltyPercent: null,
      source: "Airbnb",
      sourceText: m[0],
    };
  }

  const p = table[key];
  return {
    kind: "free-window",
    freeUntilDate: null,
    freeDays: p.freeDays,
    penaltyPercent: null,
    penaltyNote: p.note,
    source: "Airbnb",
    sourceText: m[0],
    ...grace,
  };
}

/**
 * Whether a booking is still inside its channel's post-booking grace period —
 * the case where the policy above says "locked" but the guest can in fact still
 * walk away for free. Only Airbnb sets one (24 h, stays under 28 nights).
 *
 * Returns null when the policy has no grace period or the booking timestamp is
 * unusable. `nowMs` is injectable so this stays testable; the default keeps
 * callers from having to reach for the clock themselves.
 */
export function bookingGraceStatus(
  policy: CancellationPolicy | null | undefined,
  bookingTimestamp: string | null | undefined,
  nowMs: number = Date.now(),
): { active: boolean; endsAt: Date } | null {
  const hours = policy?.graceHoursAfterBooking;
  if (!hours || !bookingTimestamp) return null;
  const bookedMs = Date.parse(bookingTimestamp);
  if (Number.isNaN(bookedMs)) return null;
  const endsMs = bookedMs + hours * 3_600_000;
  return { active: nowMs < endsMs, endsAt: new Date(endsMs) };
}

// ─── Dates ───────────────────────────────────────────────────────────────────

/** Shift a YYYY-MM-DD date by N days, staying in plain-date space (no TZ drift). */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD dates (b − a), TZ-safe. */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

// ─── Derivation ──────────────────────────────────────────────────────────────

/**
 * Resolve a booking's cancellation policy from whatever its channel provides.
 *
 * `freeUntilDate` is the LAST day a free cancellation can still be made, i.e.
 * `arrival − freeDays`, treated as inclusive through end of day. Booking.com's
 * own guest-facing wording works exactly that way ("free cancellation until
 * 1 September"). Airbnb technically cuts at the listing's check-in time on that
 * day, so day granularity overstates its window by a few hours — deliberately
 * the safe direction: the operator sees the booking as still cancellable rather
 * than counting revenue that could still walk.
 */
export function deriveCancellationPolicy(input: {
  channel: Channel;
  arrivalDate: string;
  apiMessage?: string | null;
  rateDescription?: string | null;
  /** Stay length — Airbnb applies different policy rules from 28 nights up. */
  nights?: number;
}): CancellationPolicy | null {
  const { channel, arrivalDate } = input;

  let policy: CancellationPolicy | null = null;

  if (channel === "Booking.com") {
    policy = parseBookingComPolicy(input.apiMessage);
  } else if (channel === "Airbnb") {
    policy = parseAirbnbPolicy(input.rateDescription, { nights: input.nights });
  } else {
    // Direct / Direct-Web / Direct-Phone — our own published house policy.
    policy = {
      kind: "free-window",
      freeUntilDate: null,
      freeDays: HOUSE_FREE_CANCEL_DAYS,
      penaltyPercent: null,
      source: "House policy",
      sourceText: `Free cancellation up to ${HOUSE_FREE_CANCEL_DAYS} days before check-in (booking-site terms).`,
    };
  }

  if (!policy) return null;

  if (policy.kind === "free-window" && policy.freeDays != null && arrivalDate) {
    return { ...policy, freeUntilDate: addDays(arrivalDate, -policy.freeDays) };
  }
  return policy;
}

/**
 * Days of free cancellation left as of `todayYmd`:
 *   > 0  — window open, N days remain after today
 *     0  — today is the LAST free day
 *   < 0  — window closed N days ago (revenue locked in)
 *   null — non-refundable or unknown, so "days left" is meaningless
 */
export function freeCancelDaysLeft(
  policy: CancellationPolicy | null | undefined,
  todayYmd: string,
): number | null {
  if (!policy || policy.kind !== "free-window" || !policy.freeUntilDate) return null;
  return dayDiff(todayYmd, policy.freeUntilDate);
}

// ─── Display ─────────────────────────────────────────────────────────────────

export type CancellationTone = "open" | "closing" | "last-day" | "locked" | "non-refundable" | "unknown";

/** Days-left threshold at which the window is treated as closing soon (amber). */
export const CLOSING_SOON_DAYS = 3;

/**
 * Visual/semantic bucket for a booking, given how many free days are left.
 * `stayFinished` collapses past stays to "locked" — a departed guest cannot
 * cancel anything, so a stale countdown would be noise.
 */
export function cancellationTone(
  policy: CancellationPolicy | null | undefined,
  daysLeft: number | null,
  opts: { stayFinished?: boolean } = {},
): CancellationTone {
  if (!policy || policy.kind === "unknown") return "unknown";
  if (policy.kind === "non-refundable") return "non-refundable";
  if (opts.stayFinished) return "locked";
  if (daysLeft == null) return "unknown";
  if (daysLeft < 0) return "locked";
  if (daysLeft === 0) return "last-day";
  if (daysLeft <= CLOSING_SOON_DAYS) return "closing";
  return "open";
}

const TONE_STYLES: Record<CancellationTone, { bg: string; text: string; ring: string }> = {
  "open":            { bg: "bg-emerald-50", text: "text-emerald-700", ring: "ring-emerald-200" },
  "closing":         { bg: "bg-amber-50",   text: "text-amber-800",   ring: "ring-amber-200" },
  "last-day":        { bg: "bg-orange-50",  text: "text-orange-800",  ring: "ring-orange-200" },
  "locked":          { bg: "bg-gray-100",   text: "text-gray-600",    ring: "ring-gray-200" },
  "non-refundable":  { bg: "bg-red-50",     text: "text-red-700",     ring: "ring-red-200" },
  "unknown":         { bg: "bg-gray-50",    text: "text-gray-400",    ring: "ring-gray-200" },
};

/** Chip className for a cancellation tone — mirrors rateChipClasses. */
export function cancellationChipClasses(tone: CancellationTone): string {
  const p = TONE_STYLES[tone];
  return `inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset ${p.bg} ${p.text} ${p.ring}`;
}

/** Dense label for the table column — the operator asked for days remaining. */
export function cancellationShortLabel(tone: CancellationTone, daysLeft: number | null): string {
  switch (tone) {
    case "non-refundable": return "Non-Ref";
    case "locked":         return "Locked";
    case "last-day":       return "Last day";
    case "closing":
    case "open":           return `${daysLeft}d left`;
    case "unknown":        return "—";
  }
}

/** One-line explanation for tooltips and the drawer. */
export function cancellationSummary(
  policy: CancellationPolicy | null | undefined,
  daysLeft: number | null,
  tone: CancellationTone,
): string {
  if (!policy || tone === "unknown") return "No cancellation policy available for this booking.";
  if (tone === "non-refundable") {
    return `Non-refundable — chargeable in full from the moment of booking (${policy.source}).`;
  }
  const until = policy.freeUntilDate;
  const penalty =
    policy.penaltyPercent != null ? ` After that the guest pays ${policy.penaltyPercent} % of the total.`
    : policy.penaltyNote ? ` ${policy.penaltyNote}`
    : "";
  if (tone === "locked") {
    return `Free cancellation ended ${until} — revenue locked in.${penalty}`;
  }
  if (tone === "last-day") {
    return `Today is the last day the guest can cancel free of charge (until end of ${until}).${penalty}`;
  }
  return `Guest can still cancel free of charge for ${daysLeft} more day${daysLeft === 1 ? "" : "s"} — through ${until}.${penalty}`;
}
