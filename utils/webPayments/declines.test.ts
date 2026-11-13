import { describe, it, expect } from 'vitest';
import { classifyChargeError, declineReason } from './declines';

describe('classifyChargeError', () => {
  it('a bank decline counts', () => {
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card has insufficient funds.' }))
      .toEqual({ kind: 'decline', code: 'insufficient_funds', message: 'Your card has insufficient funds.' });
    expect(classifyChargeError({ type: 'StripeCardError', code: 'expired_card' }).kind).toBe('decline');
  });

  it('3-D Secure needed again counts as a decline (the guest pays through the link)', () => {
    expect(classifyChargeError({ type: 'StripeCardError', code: 'authentication_required' }).kind).toBe('decline');
    expect(classifyChargeError({ code: 'authentication_required' }).kind).toBe('decline');
  });

  it('temporary bank problems are retried, never counted', () => {
    expect(classifyChargeError({ type: 'StripeCardError', code: 'processing_error' }).kind).toBe('retry');
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'try_again_later' }).kind).toBe('retry');
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'issuer_not_available' }).kind).toBe('retry');
    expect(classifyChargeError({ type: 'StripeRateLimitError', statusCode: 429 }).kind).toBe('retry');
  });

  it('Stripe throttling a card we retried too often is never a bank decline', () => {
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_decline_rate_limit_exceeded' }).kind).toBe('retry');
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'card_decline_rate_limit_exceeded' }).kind).toBe('retry');
  });

  it('our own Radar block list needs an admin, never counted', () => {
    expect(classifyChargeError({ type: 'StripeCardError', code: 'card_declined', decline_code: 'merchant_blacklist' }).kind).toBe('needs_admin');
  });

  it('our own setup problems need an admin, never counted', () => {
    expect(classifyChargeError({ type: 'StripeInvalidRequestError', code: 'resource_missing' }).kind).toBe('needs_admin');
    expect(classifyChargeError({ type: 'StripeIdempotencyError' }).kind).toBe('needs_admin');
    expect(classifyChargeError({ type: 'StripeAuthenticationError' }).kind).toBe('needs_admin');
  });

  it('when Stripe may have charged, the outcome is unknown (replay the same key)', () => {
    expect(classifyChargeError({ type: 'StripeConnectionError' }).kind).toBe('unknown');
    expect(classifyChargeError({ type: 'StripeAPIError', statusCode: 500 }).kind).toBe('unknown');
    expect(classifyChargeError(new Error('The operation was aborted due to timeout')).kind).toBe('unknown');
    expect(classifyChargeError(undefined).kind).toBe('unknown');
  });
});

describe('declineReason', () => {
  it('speaks plainly in both languages, with a safe fallback', () => {
    expect(declineReason('insufficient_funds', 'cs')).toBe('na kartě není dostatek prostředků');
    expect(declineReason('expired_card', 'en')).toBe('the card has expired');
    expect(declineReason('something_new', 'en')).toBe('your bank declined the payment');
  });
});
