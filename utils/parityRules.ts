/**
 * Operator-configurable parity alert rules — client-safe module.
 *
 * The monitor works with four prices per stay:
 *   web             — our site (Beds24 offers)
 *   airbnb          — anonymous Airbnb price
 *   bookingAnon     — anonymous Booking.com price
 *   bookingComputed — derived Booking Genius/app price (member floor)
 *
 * A rule is one pairwise comparison with a tolerance: "LEFT must not be
 * ABOVE/BELOW RIGHT by more than N%". Severity decides what firing means:
 * major = red block + Telegram (grid runs), minor = yellow block only,
 * off = kept in the list but ignored.
 *
 * Rules are configured PER STAY LENGTH in the Pricing tab UI and stored in
 * app_settings under `parity:alert-rules`. Checks are prospective by design:
 * the calendar colours and the next grid run's Telegram diff simply follow
 * whatever the config says right now — history is never re-judged.
 */

export type PriceKey = 'web' | 'airbnb' | 'bookingAnon' | 'bookingComputed';

export const PRICE_LABEL: Record<PriceKey, string> = {
  web: 'Web (our site)',
  airbnb: 'Airbnb',
  bookingAnon: 'Booking.com anonymous',
  bookingComputed: 'Booking.com Genius/app',
};

export interface ParityRule {
  left: PriceKey;
  op: 'above' | 'below';
  right: PriceKey;
  /** Allowed slack in percent before the rule fires. */
  tolerancePct: number;
  /**
   * Optional replacement tolerance when the Booking offer carries a
   * "Booking.com pays" discount (Booking-funded, out of host control) — the
   * usual reason a web-vs-Booking rule fires through no fault of our setup.
   * null/absent = base tolerance applies. 100 effectively disables the rule
   * in that context.
   */
  tolerancePctBookingFunded?: number | null;
  /**
   * Same, when an operator-triggered campaign deal (Getaway / Limited-time /
   * Smart) is on the Booking offer — the operator ran the campaign on
   * purpose, so a wider band is usually intended.
   */
  tolerancePctCampaign?: number | null;
  severity: 'major' | 'minor' | 'off';
}

/** Offer context that can widen a rule's tolerance. */
export interface RuleContext {
  bookingFunded: boolean;
  campaign: boolean;
}

export type StayLengthKey = '1' | '2' | '3' | '7';
export const STAY_LENGTHS: StayLengthKey[] = ['1', '2', '3', '7'];

export type ParityRuleConfig = Record<StayLengthKey, ParityRule[]>;

/**
 * Defaults = the rules that were previously hardcoded (operator specs
 * 2026-08-30): the direct site must never be the expensive option; Airbnb
 * must sit inside Booking's Genius↔anonymous corridor; a Genius/app price
 * below our site is worth seeing but not alerting on.
 */
const BASE_RULES: ParityRule[] = [
  // Web above Booking is tolerated when Booking itself funds the discount
  // ("Booking.com pays") or the operator runs a campaign deal — override
  // tolerance 100 = rule effectively off in that context (operator outcomes,
  // 2026-08-30: those two cases are expected; everything else is not).
  {
    left: 'web', op: 'above', right: 'bookingAnon', tolerancePct: 1,
    tolerancePctBookingFunded: 100, tolerancePctCampaign: 100, severity: 'major',
  },
  { left: 'web', op: 'above', right: 'airbnb', tolerancePct: 1, severity: 'major' },
  { left: 'airbnb', op: 'above', right: 'bookingAnon', tolerancePct: 5, severity: 'major' },
  { left: 'airbnb', op: 'below', right: 'bookingComputed', tolerancePct: 5, severity: 'major' },
  { left: 'bookingComputed', op: 'below', right: 'web', tolerancePct: 1, severity: 'minor' },
];

export function defaultParityRules(): ParityRuleConfig {
  return Object.fromEntries(
    STAY_LENGTHS.map((k) => [k, BASE_RULES.map((r) => ({ ...r }))]),
  ) as ParityRuleConfig;
}

export function rulesForNights(config: ParityRuleConfig, nights: number): ParityRule[] {
  return config[String(nights) as StayLengthKey] ?? [];
}

/** Stable identity for alert dedup across runs — survives reordering. */
export function ruleKey(rule: ParityRule): string {
  return `${rule.left}~${rule.op}~${rule.right}`;
}

export interface FiredRule {
  rule: ParityRule;
  /** Signed gap of left vs right, in percent. */
  gapPct: number;
  text: string;
}

const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

export function evaluateParityRules(
  rules: ParityRule[],
  prices: Record<PriceKey, number | null>,
  ctx: RuleContext = { bookingFunded: false, campaign: false },
): FiredRule[] {
  const fired: FiredRule[] = [];
  for (const rule of rules) {
    if (rule.severity === 'off') continue;
    const left = prices[rule.left];
    const right = prices[rule.right];
    if (left === null || right === null || right <= 0) continue;

    // Context overrides replace the base tolerance; when both contexts apply,
    // leniency wins (the wider band).
    const overrides: number[] = [];
    if (ctx.bookingFunded && rule.tolerancePctBookingFunded != null) {
      overrides.push(rule.tolerancePctBookingFunded);
    }
    if (ctx.campaign && rule.tolerancePctCampaign != null) {
      overrides.push(rule.tolerancePctCampaign);
    }
    const tolerancePct = overrides.length > 0 ? Math.max(...overrides) : rule.tolerancePct;
    const overrideNote =
      overrides.length > 0
        ? ` — ${ctx.bookingFunded && rule.tolerancePctBookingFunded != null ? 'Booking.com-pays' : 'campaign'} override`
        : '';

    const tol = tolerancePct / 100;
    const violated = rule.op === 'above' ? left > right * (1 + tol) : left < right * (1 - tol);
    if (!violated) continue;
    const gapPct = ((left - right) / right) * 100;
    fired.push({
      rule,
      gapPct,
      text:
        `${PRICE_LABEL[rule.left]} ${kc(left)} is ${Math.abs(gapPct).toFixed(0)}% ` +
        `${rule.op} ${PRICE_LABEL[rule.right]} ${kc(right)} ` +
        `(allowed ${rule.op === 'above' ? '+' : '−'}${tolerancePct}%${overrideNote})`,
    });
  }
  return fired;
}

/** Derive the override context from a Booking offer's (canonical) labels. */
export function ruleContextFromLabels(bookingLabels: string[]): RuleContext {
  return {
    bookingFunded: bookingLabels.some((l) => l.startsWith('Booking.com pays')),
    campaign: bookingLabels.some((l) =>
      ['Getaway Deal', 'Limited-time Deal', 'Smart Deal'].includes(l),
    ),
  };
}

const PRICE_KEYS: PriceKey[] = ['web', 'airbnb', 'bookingAnon', 'bookingComputed'];

/** Validate an untrusted config (UI POST / stored JSON). Null when unusable. */
export function sanitizeRuleConfig(input: unknown): ParityRuleConfig | null {
  if (input === null || typeof input !== 'object') return null;
  const out = {} as ParityRuleConfig;
  for (const key of STAY_LENGTHS) {
    const list = (input as Record<string, unknown>)[key];
    if (!Array.isArray(list) || list.length > 12) return null;
    const rules: ParityRule[] = [];
    const validPct = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
    for (const item of list) {
      const r = item as Partial<ParityRule>;
      if (
        !PRICE_KEYS.includes(r.left as PriceKey) ||
        !PRICE_KEYS.includes(r.right as PriceKey) ||
        r.left === r.right ||
        (r.op !== 'above' && r.op !== 'below') ||
        !validPct(r.tolerancePct) ||
        (r.tolerancePctBookingFunded != null && !validPct(r.tolerancePctBookingFunded)) ||
        (r.tolerancePctCampaign != null && !validPct(r.tolerancePctCampaign)) ||
        (r.severity !== 'major' && r.severity !== 'minor' && r.severity !== 'off')
      ) {
        return null;
      }
      rules.push({
        left: r.left as PriceKey,
        op: r.op,
        right: r.right as PriceKey,
        tolerancePct: Math.round(r.tolerancePct * 10) / 10,
        tolerancePctBookingFunded:
          r.tolerancePctBookingFunded == null ? null : Math.round(r.tolerancePctBookingFunded * 10) / 10,
        tolerancePctCampaign:
          r.tolerancePctCampaign == null ? null : Math.round(r.tolerancePctCampaign * 10) / 10,
        severity: r.severity,
      });
    }
    out[key] = rules;
  }
  return out;
}
