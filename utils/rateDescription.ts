/**
 * Reading Beds24's `rateDescription` — which rate plan a booking sat on, which
 * promotion rewrote its price, and what a cancelled booking was worth.
 *
 * Pure and client-safe: no imports, so it can be unit-tested against real lines
 * copied out of the archive (see `rateDescription.test.ts`).
 *
 * THE FORMAT
 * ----------
 * Booking.com bookings carry one line per night:
 *
 *   2026-08-10 (66698026 Flexible Urban 1KK rewritten from  Early Booker Deal) CZK 2149.16 genius
 *              └ Beds24 rate id + name ┘                  └ the promotion ┘     └ night ┘ └ Genius ┘
 *
 * Booking.com sends a promotional booking under the PROMOTION's name; Beds24
 * rewrites it onto the parent rate plan and keeps the promotion after
 * "rewritten from". Three shapes need care:
 *   - the name can be missing ("(65571709 rewritten from  Early Booker Deal)"),
 *     so the plan is recovered from the rate id via other bookings that name it;
 *   - the promotion name can contain brackets ("Mobile(App) Rate"), so the
 *     promotion runs to the LAST ") CZK", not the first ")";
 *   - "rewritten from 60681829 Non-refundable Rate-…" is a rate rewritten onto
 *     another rate, not a promotion — the guest bought the rate after "from".
 *
 * Airbnb bookings carry "Cancel policy <name>" plus "Base Price <x> CZK" for the
 * whole stay. Direct bookings carry nothing useful.
 */

export type RatePlanFamily =
  | 'Non-refundable'
  | 'Standard'
  | 'Flexible'
  | 'One-night'
  | 'Weekly'
  | 'Unspecified';

/** Display order — the three cancellation tiers first, then the length-of-stay plans. */
export const RATE_PLAN_ORDER: RatePlanFamily[] = [
  'Non-refundable',
  'Standard',
  'Flexible',
  'One-night',
  'Weekly',
  'Unspecified',
];

export type PromoFamily =
  | 'No promotion'
  | 'Early Booker Deal'
  | 'Last Minute Deal'
  | 'Super Last Minute'
  | 'Mobile rate'
  | 'Limited Time Deal'
  | 'Seasonal deal'
  | 'Other promotion';

/**
 * The promotions that run for a fixed window and are switched on by hand — the
 * ones the "are the limited-time deals working?" question is about. Standing
 * promotions (Early Booker, Last Minute, Mobile) are always on.
 */
export const TIME_LIMITED_PROMOS: PromoFamily[] = ['Limited Time Deal', 'Seasonal deal'];

export interface ParsedRateLine {
  /** Beds24 rate id, when the line carries one. */
  rateId: string | null;
  /** The plan named on the line, or null when only the id is there. */
  plan: RatePlanFamily | null;
  /** The promotion exactly as written (trimmed), or null for none. */
  promoName: string | null;
  promo: PromoFamily;
  genius: boolean;
}

/** Map a rate NAME (Beds24 or channel wording) to a plan family, or null. */
export function planFromName(name: string): RatePlanFamily | null {
  const s = name.toLowerCase();
  if (/non[\s-]?ref/.test(s) || s.includes('non_refundable')) return 'Non-refundable';
  if (s.includes('one night')) return 'One-night';
  if (s.includes('weekly')) return 'Weekly';
  if (/flexib?l/.test(s)) return 'Flexible';
  if (s.includes('standard')) return 'Standard';
  return null;
}

/**
 * Airbnb cancellation policy → plan family. Airbnb has no rate plans; its
 * policies sit on the same ladder: non-refundable, a firm/strict "standard"
 * policy, and moderate/flexible ones that refund until close to arrival.
 */
function planFromAirbnbPolicy(policy: string): RatePlanFamily {
  const s = policy.toLowerCase();
  if (s.includes('non_refundable') || s.includes('non-refundable')) return 'Non-refundable';
  if (s.includes('moderate') || s.includes('flexible')) return 'Flexible';
  return 'Standard';
}

export function promoFamily(name: string | null): PromoFamily {
  if (!name) return 'No promotion';
  const s = name.toLowerCase();
  if (s.includes('super last minute')) return 'Super Last Minute';
  if (s.includes('last minute')) return 'Last Minute Deal';
  if (s.includes('early booker')) return 'Early Booker Deal';
  if (s.includes('mobile')) return 'Mobile rate';
  if (s.includes('limited time')) return 'Limited Time Deal';
  // Operator-named seasonal campaigns ("August Deal", "Sezonni nabidka - Aug/Sept").
  if (/(deal|nab[ií]dka|sez[oó]nn|season|akce|sleva)/.test(s)) return 'Seasonal deal';
  return 'Other promotion';
}

/** The first line only — every night of a booking carries the same plan and promotion. */
export function firstLine(rateDescription: string | null | undefined): string {
  return (rateDescription ?? '').split('\n')[0].replace(/\r$/, '');
}

export function parseRateLine(line: string): ParsedRateLine {
  const genius = /genius/i.test(line);

  // Airbnb: "Cancel policy tiered_pricing_non_refundable"
  const policy = /^Cancel policy\s+(\S+)/i.exec(line);
  if (policy) {
    return { rateId: null, plan: planFromAirbnbPolicy(policy[1]), promoName: null, promo: 'No promotion', genius };
  }

  // Older Beds24 shape: "2026-02-06 Rate (60681828) CZK 1955.34"
  const bare = /^\d{4}-\d{2}-\d{2}\s+Rate\s+\((\d+)\)/.exec(line);
  if (bare) return { rateId: bare[1], plan: null, promoName: null, promo: 'No promotion', genius };

  // "2026-08-10 (<id> <name> rewritten from <promo>) CZK …" — the bracket runs to
  // the LAST ") CZK" so a promotion like "Mobile(App) Rate" survives intact.
  const m = /^\d{4}-\d{2}-\d{2}\s+\((\d+)\s*(.*)\)\s*CZK/.exec(line);
  if (!m) return { rateId: null, plan: null, promoName: null, promo: 'No promotion', genius };

  const rateId = m[1];
  const inner = m[2];
  const split = /^(.*?)\s*rewritten from\s+(.*)$/i.exec(inner);
  const rateName = (split ? split[1] : inner).trim();
  let promoName = split ? split[2].replace(/\s+/g, ' ').trim() : null;
  let plan = rateName ? planFromName(rateName) : null;

  // Rewritten from another RATE (an id), not a promotion: the guest bought that rate.
  const fromRate = promoName ? /^(\d{6,})\s+(.*)$/.exec(promoName) : null;
  if (fromRate) {
    plan = planFromName(fromRate[2]) ?? plan;
    promoName = null;
  }

  return { rateId, plan, promoName: promoName || null, promo: promoFamily(promoName || null), genius };
}

/**
 * Rate id → plan, learned from every line that names its plan.
 *
 * Built across the whole archive (not just the window) so a nameless line in a
 * quiet month can still be resolved from a named one elsewhere. Majority vote
 * per id, in case an id was ever renamed across plan families.
 */
export function buildRateIdPlanMap(lines: ParsedRateLine[]): Map<string, RatePlanFamily> {
  const votes = new Map<string, Map<RatePlanFamily, number>>();
  for (const l of lines) {
    if (!l.rateId || !l.plan) continue;
    const forId = votes.get(l.rateId) ?? new Map<RatePlanFamily, number>();
    forId.set(l.plan, (forId.get(l.plan) ?? 0) + 1);
    votes.set(l.rateId, forId);
  }
  const out = new Map<string, RatePlanFamily>();
  for (const [id, forId] of votes) {
    const best = [...forId.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out.set(id, best[0]);
  }
  return out;
}

/**
 * The plan a booking sat on, by the best evidence available: the named plan on
 * the line, else the plan its rate id is known by, else the archive's
 * `rate_type` column (which Beds24 fills for only part of the book).
 */
export function resolvePlan(
  parsed: ParsedRateLine,
  rateType: string | null,
  idPlans: Map<string, RatePlanFamily>,
): RatePlanFamily {
  if (parsed.plan) return parsed.plan;
  if (parsed.rateId && idPlans.has(parsed.rateId)) return idPlans.get(parsed.rateId)!;
  if (rateType) {
    const fromType = planFromName(rateType === 'Flexi' ? 'flexible' : rateType);
    if (fromType) return fromType;
  }
  return 'Unspecified';
}

/**
 * What one night of a booking was worth before it was cancelled.
 *
 * Beds24 zeroes `price` on a cancelled booking, so the value has to be read back
 * from the description: the per-night "CZK x" lines (Booking.com — on live
 * bookings they reconcile to `price` exactly), or Airbnb's whole-stay "Base
 * Price" spread over the nights. The MEAN of the night lines, not their sum ÷
 * nights: Beds24 truncates the description on long stays, so a 30-night booking
 * can carry fewer lines than nights. Null when neither is there (direct).
 */
export function originalNightly(
  rateDescription: string | null | undefined,
  spanNights: number,
): number | null {
  const text = rateDescription ?? '';
  let total = 0;
  let lines = 0;
  for (const raw of text.split('\n')) {
    const m = /^\d{4}-\d{2}-\d{2}\s.*\sCZK\s+([0-9]+(?:\.[0-9]+)?)/.exec(raw.replace(/\r$/, ''));
    if (m) {
      total += Number(m[1]);
      lines += 1;
    }
  }
  if (lines > 0) return total / lines;
  const base = /Base Price\s+([0-9]+(?:\.[0-9]+)?)\s*CZK/i.exec(text);
  return base && spanNights > 0 ? Number(base[1]) / spanNights : null;
}
