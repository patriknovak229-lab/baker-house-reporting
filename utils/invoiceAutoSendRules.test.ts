import { describe, expect, it } from 'vitest';
import {
  amountHoldReason,
  amountTaskNote,
  autoSendWindowStart,
  formatAmount,
  invoiceConfirmationKind,
  isBeyondAutoSendWindow,
  manualInvoiceAlert,
  mismatchedAmounts,
  parseStatedAmounts,
  withAmountNote,
} from './invoiceAutoSendRules';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('auto-send age window', () => {
  it('reaches back ~6 months, not 3 days', () => {
    expect(autoSendWindowStart('2026-10-07')).toBe('2026-04-07');
  });

  it('a request a month after checkout is still auto-sendable', () => {
    expect(isBeyondAutoSendWindow('2026-09-07', '2026-10-07')).toBe(false);
    // The real case that started this: checkout 30 Sep, details on 7 Oct.
    expect(isBeyondAutoSendWindow('2026-09-30', '2026-10-07')).toBe(false);
  });

  it('a checkout older than 6 months is left for manual', () => {
    expect(isBeyondAutoSendWindow('2026-04-06', '2026-10-07')).toBe(true);
    expect(isBeyondAutoSendWindow('2025-10-07', '2026-10-07')).toBe(true);
  });

  it('missing checkout is never "too old"', () => {
    expect(isBeyondAutoSendWindow('', '2026-10-07')).toBe(false);
  });
});

describe('parseStatedAmounts', () => {
  it('reads the verbatim guest message from BH-93787214', () => {
    const msg =
      'Dobrý den, prosíme o fakturu ubytování ze dne 28.9. - 30.9. s částkou 3509,41Kč. Děkujeme';
    expect(parseStatedAmounts([msg])).toEqual([{ amount: 3509.41, currency: 'CZK' }]);
  });

  it.each([
    ['na částku 3 509,41 Kč', 3509.41],
    ['celkem 3.509,41 CZK', 3509.41],
    ['amount of CZK 3,509.41 please', 3509.41],
    ['CZK 3509.41', 3509.41],
    ['3509 Kč', 3509],
    ['3 509,- Kč', 3509],
    ['3509 korun', 3509],
    ['3 509,41 Kč', 3509.41],
  ])('%s → %d CZK', (text, amount) => {
    expect(parseStatedAmounts([text])).toEqual([{ amount, currency: 'CZK' }]);
  });

  it('recognises euro amounts', () => {
    expect(parseStatedAmounts(['total 145,50 EUR'])).toEqual([{ amount: 145.5, currency: 'EUR' }]);
    expect(parseStatedAmounts(['€145'])).toEqual([{ amount: 145, currency: 'EUR' }]);
  });

  it('ignores numbers without a currency: dates, IČO, phone numbers', () => {
    expect(
      parseStatedAmounts([
        'Faktura za 28.9. - 30.9.2026, IČO 04291409, DIČ CZ04291409, tel +420 603 796 980',
      ]),
    ).toEqual([]);
  });

  it('de-duplicates across messages and skips empty input', () => {
    expect(parseStatedAmounts(['3509,41 Kč', null, undefined, '', 'částka 3509,41 Kč'])).toEqual([
      { amount: 3509.41, currency: 'CZK' },
    ]);
  });
});

describe('mismatchedAmounts', () => {
  const price = 3776.64;

  it('flags the Booking.com-pays case', () => {
    expect(mismatchedAmounts([{ amount: 3509.41, currency: 'CZK' }], price)).toHaveLength(1);
  });

  it('accepts the booking price, including guest rounding within 1 Kč', () => {
    expect(mismatchedAmounts([{ amount: 3776.64, currency: 'CZK' }], price)).toEqual([]);
    expect(mismatchedAmounts([{ amount: 3777, currency: 'CZK' }], price)).toEqual([]);
  });

  it('a non-CZK amount or an unknown price always needs a human', () => {
    expect(mismatchedAmounts([{ amount: 150, currency: 'EUR' }], price)).toHaveLength(1);
    expect(mismatchedAmounts([{ amount: 3776.64, currency: 'CZK' }], null)).toHaveLength(1);
  });

  it('no stated amount → nothing to hold', () => {
    expect(mismatchedAmounts([], price)).toEqual([]);
  });
});

describe('wording', () => {
  const asked = [{ amount: 3509.41, currency: 'CZK' }];

  it('formats Czech-style amounts deterministically', () => {
    expect(formatAmount({ amount: 3509.41, currency: 'CZK' })).toBe('3 509,41 Kč');
    expect(formatAmount({ amount: 12000, currency: 'CZK' })).toBe('12 000 Kč');
    expect(formatAmount({ amount: 145.5, currency: 'EUR' })).toBe('145,50 EUR');
  });

  it('hold reason names both amounts', () => {
    expect(amountHoldReason(asked, 3776.64)).toBe(
      'guest asked for 3 509,41 Kč, booking price 3 776,64 Kč',
    );
  });

  it('task note names the likely cause only for Booking.com', () => {
    expect(amountTaskNote(asked, 3776.64, 'Booking.com')).toContain('Booking.com pays');
    expect(amountTaskNote(asked, 3776.64, 'Airbnb')).not.toContain('Booking.com pays');
  });

  it('a re-hold replaces the previous note instead of stacking it', () => {
    const base = 'Send invoice — FreshSmart Service';
    const once = withAmountNote(base, amountTaskNote(asked, 3776.64, 'Booking.com'));
    const twice = withAmountNote(once, amountTaskNote([{ amount: 3500, currency: 'CZK' }], 3776.64, 'Booking.com'));
    expect(twice.startsWith(base)).toBe(true);
    expect(twice).toContain('3 500 Kč');
    expect(twice).not.toContain('3 509,41 Kč');
  });

  it('Telegram alert: held amount on a Booking.com booking', () => {
    const text = manualInvoiceAlert(
      {
        reservationNumber: 'BH-93787214',
        companyName: 'FreshSmart <Service>',
        channel: 'Booking.com',
        bookingPriceCzk: 3776.64,
        mismatched: asked,
      },
      esc,
    );
    expect(text).toContain('BH-93787214');
    expect(text).toContain('FreshSmart &lt;Service&gt;');
    expect(text).toContain('3 509,41 Kč');
    expect(text).toContain('3 776,64 Kč');
    expect(text).toContain('−267,23 Kč');
    expect(text).toContain('Booking.com pays');
    expect(text).toContain('Auto-send is held');
  });

  it('Telegram alert: already sent, and too-old checkout', () => {
    const sent = manualInvoiceAlert(
      { reservationNumber: 'BH-1', bookingPriceCzk: 1000, mismatched: [{ amount: 900, currency: 'CZK' }], alreadySent: true },
      esc,
    );
    expect(sent).toContain('already sent');
    expect(sent).toContain('invoice was sent for 1 000 Kč');
    const old = manualInvoiceAlert({ reservationNumber: 'BH-2', tooOldCheckout: '2025-09-30' }, esc);
    expect(old).toContain('more than 6 months');
    expect(old).not.toContain('Guest asked');
  });
});

describe('invoiceConfirmationKind', () => {
  const today = '2026-10-08';
  const kind = (checkoutDate: string, invoiceAlreadySent = false) =>
    invoiceConfirmationKind({ checkoutDate, todayYmd: today, invoiceAlreadySent });

  it('before or on checkout day → "after your checkout on X"', () => {
    expect(kind('2026-10-12')).toBe('before-checkout');
    expect(kind('2026-10-08')).toBe('before-checkout');
  });

  it('late requests get a confirmation too (the old rule was silent after 3 days)', () => {
    expect(kind('2026-10-07')).toBe('after-checkout');
    // BH-93787214: checkout 30 Sep, details 7 Oct → used to get nothing.
    expect(kind('2026-09-30')).toBe('after-checkout');
    expect(kind('2026-04-08')).toBe('after-checkout');
  });

  it('unknown checkout → the dateless wording', () => {
    expect(kind('')).toBe('after-checkout');
  });

  it('beyond the 6-month window → no message, the operator replies personally', () => {
    expect(kind('2026-04-07')).toBeNull();
    expect(kind('2025-10-01')).toBeNull();
  });

  it('invoice already sent by hand → no "we will send it" message', () => {
    expect(kind('2026-10-12', true)).toBeNull();
    expect(kind('2026-09-30', true)).toBeNull();
  });
});
