/**
 * What a failed Stripe charge means for the guest. Pure.
 *
 * Only a real answer from the guest's bank counts as a declined attempt — and
 * only declined attempts can ever lead to a cancellation. Anything that is our
 * problem, Stripe's, or the network's is retried on the next run and alerted,
 * and the guest never hears about it.
 *
 *   decline        → the bank said no (or wants 3-D Secure again). Counts.
 *   retry          → nothing was charged; try again later (outage, rate limit,
 *                    temporary issuer problem). Doesn't count.
 *   needs_admin    → nothing was charged and retrying won't help (bad setup,
 *                    card removed, key mismatch). Doesn't count; alert.
 *   unknown        → we don't know whether Stripe charged (connection dropped,
 *                    Stripe 5xx). Keep the attempt open and replay the SAME
 *                    idempotency key: Stripe then returns the original result.
 */
export type ChargeFailureKind = 'decline' | 'retry' | 'needs_admin' | 'unknown';

export interface ChargeFailure {
  kind: ChargeFailureKind;
  /** Stripe error code or decline code, e.g. 'insufficient_funds'. */
  code: string;
  message: string;
}

/** Bank answers that mean "try again later", not "no" — and Stripe's own throttle. */
const TEMPORARY_DECLINE_CODES = new Set([
  'processing_error',
  'issuer_not_available',
  'try_again_later',
  'reenter_transaction',
  'approve_with_id',
  // Stripe stops further attempts on a card it saw declined too often. That is
  // our retrying, not the guest's bank saying no — it must never count.
  'card_decline_rate_limit_exceeded',
]);

/** Stripe's own decision (our Radar block list), not the guest's bank: an admin looks. */
const OUR_BLOCK_CODES = new Set(['merchant_blacklist']);

interface StripeLikeError {
  type?: string;
  rawType?: string;
  code?: string;
  decline_code?: string;
  statusCode?: number;
  message?: string;
}

export function classifyChargeError(err: unknown): ChargeFailure {
  const e = (err ?? {}) as StripeLikeError;
  const message = typeof e.message === 'string' && e.message ? e.message : String(err);
  const code = e.decline_code || e.code || e.type || 'unknown';

  const isCard = e.type === 'StripeCardError' || e.rawType === 'card_error';
  if (isCard) {
    if (TEMPORARY_DECLINE_CODES.has(e.decline_code ?? '') || TEMPORARY_DECLINE_CODES.has(e.code ?? '')) {
      return { kind: 'retry', code, message };
    }
    if (OUR_BLOCK_CODES.has(e.decline_code ?? '')) return { kind: 'needs_admin', code, message };
    return { kind: 'decline', code, message };
  }
  // Off-session charges that need the cardholder again surface as this code.
  if (e.code === 'authentication_required') return { kind: 'decline', code: 'authentication_required', message };
  // Our replayed request is still being processed by Stripe: the answer is coming, not a failure.
  if (e.code === 'idempotency_key_in_use') return { kind: 'unknown', code: e.code, message };

  switch (e.type) {
    case 'StripeRateLimitError':
      return { kind: 'retry', code, message };
    case 'StripeInvalidRequestError':
    case 'StripeIdempotencyError':
    case 'StripeAuthenticationError':
    case 'StripePermissionError':
      return { kind: 'needs_admin', code, message };
    case 'StripeConnectionError':
    case 'StripeAPIError':
      return { kind: 'unknown', code, message };
  }
  if (typeof e.statusCode === 'number') {
    if (e.statusCode === 429) return { kind: 'retry', code, message };
    if (e.statusCode >= 500) return { kind: 'unknown', code, message };
    if (e.statusCode >= 400) return { kind: 'needs_admin', code, message };
  }
  // A timeout or anything else we can't read: assume Stripe may have charged.
  return { kind: 'unknown', code, message };
}

/** Plain-language reason for the guest email and the ops alert. */
export function declineReason(code: string, lang: 'cs' | 'en'): string {
  const cs: Record<string, string> = {
    insufficient_funds: 'na kartě není dostatek prostředků',
    expired_card: 'platnost karty vypršela',
    authentication_required: 'banka vyžaduje ověření platby',
    card_declined: 'banka platbu zamítla',
    do_not_honor: 'banka platbu zamítla',
    lost_card: 'karta je blokovaná',
    stolen_card: 'karta je blokovaná',
    card_velocity_exceeded: 'byl překročen limit karty',
    withdrawal_count_limit_exceeded: 'byl překročen limit karty',
  };
  const en: Record<string, string> = {
    insufficient_funds: 'the card has insufficient funds',
    expired_card: 'the card has expired',
    authentication_required: 'your bank needs you to confirm the payment',
    card_declined: 'your bank declined the payment',
    do_not_honor: 'your bank declined the payment',
    lost_card: 'the card is blocked',
    stolen_card: 'the card is blocked',
    card_velocity_exceeded: 'the card limit was exceeded',
    withdrawal_count_limit_exceeded: 'the card limit was exceeded',
  };
  const table = lang === 'cs' ? cs : en;
  return table[code] ?? (lang === 'cs' ? 'banka platbu zamítla' : 'your bank declined the payment');
}
