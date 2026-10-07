/**
 * Rules that decide whether a guest's invoice can go out unattended
 * (send-due-invoices cron) or must wait for the operator. Shared by the cron
 * and the Beds24 message webhook so both agree on the same definitions.
 *
 * Two rules live here:
 *
 *  1. AGE WINDOW — the cron auto-sends any due invoice task whose checkout is
 *     at most ~6 months old. Guests routinely ask weeks after the stay (their
 *     accountant chases them), so a late request is queued for the next run
 *     like any other. Anything older is alerted and left for manual handling.
 *
 *  2. STATED AMOUNT — when the guest names an amount that isn't the booking
 *     price, the invoice must NOT auto-send at the booking price. Typical
 *     cause on Booking.com: a "Booking.com pays" / Booking Sponsored Benefit
 *     discount. Booking.com funds it from its own margin, so the guest pays
 *     less, but Beds24 only ever carries the gross price. (Verified on
 *     BH-93787214: no Beds24 field holds the guest-paid amount.) The operator
 *     checks the extranet, sets the invoice-amount override and sends it.
 *
 * Everything here is pure (no I/O) so it can be pinned by unit tests.
 */

/** ~6 months. Checkouts older than this are never auto-invoiced. */
export const INVOICE_AUTO_SEND_MAX_AGE_DAYS = 183;

/** Stated amounts within this many CZK of the booking price count as equal (rounding). */
export const AMOUNT_TOLERANCE_CZK = 1;

/** Earliest checkout date (YYYY-MM-DD) the cron still auto-sends for. */
export function autoSendWindowStart(todayYmd: string): string {
  const d = new Date(`${todayYmd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - INVOICE_AUTO_SEND_MAX_AGE_DAYS);
  return d.toISOString().slice(0, 10);
}

/** True when a checkout is too old to auto-invoice (alert + manual instead). */
export function isBeyondAutoSendWindow(checkoutYmd: string, todayYmd: string): boolean {
  return !!checkoutYmd && checkoutYmd < autoSendWindowStart(todayYmd);
}

// ─── Stated amounts ──────────────────────────────────────────────────────────

export interface StatedAmount {
  amount: number;
  /** ISO-ish code: 'CZK' or 'EUR'. */
  currency: string;
}

// A number as guests type it: "3509,41", "3 509,41", "3.509,41", "3,509.41",
// "3509", "3 509". Groups of exactly three digits after a separator are
// thousands; a trailing 1–2 digits after the LAST separator is the decimal part.
const NUM = String.raw`\d{1,3}(?:[   .,']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const CUR_BEFORE = String.raw`CZK|Kč|Kc|EUR|€`;
const CUR_AFTER = String.raw`CZK|Kč|Kc|korun\p{L}*|EUR|€|eur\p{L}*`;

// Currency on either side of the number; a number with no currency marker is
// never treated as an amount (dates, IČO, phone numbers stay out).
const AMOUNT_RE = new RegExp(
  String.raw`(?<![\p{L}\d])(${CUR_BEFORE})\s?(${NUM})(?![\d])` +
    '|' +
    String.raw`(?<![\d.,])(${NUM})\s?(?:,-\s?)?(${CUR_AFTER})(?![\p{L}])`,
  'giu',
);

function currencyCode(token: string): string {
  return /^(eur|€)/i.test(token) ? 'EUR' : 'CZK';
}

function parseNumber(raw: string): number | null {
  const s = raw.replace(/[\s  ']/g, '');
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  let normalised: string;
  if (lastSep >= 0 && s.length - lastSep - 1 <= 2) {
    // Trailing 1–2 digits → decimal part; every earlier separator is grouping.
    normalised = `${s.slice(0, lastSep).replace(/[.,]/g, '')}.${s.slice(lastSep + 1)}`;
  } else {
    normalised = s.replace(/[.,]/g, '');
  }
  const n = Number(normalised);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Every money amount (number + currency marker) found in the given messages,
 * de-duplicated. Empty when the guest named no amount.
 */
export function parseStatedAmounts(texts: (string | null | undefined)[]): StatedAmount[] {
  const out: StatedAmount[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(AMOUNT_RE)) {
      const numRaw = m[2] ?? m[3];
      const curRaw = m[1] ?? m[4];
      if (!numRaw || !curRaw) continue;
      const amount = parseNumber(numRaw);
      if (amount === null) continue;
      const currency = currencyCode(curRaw);
      const key = `${currency}:${amount.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ amount, currency });
    }
  }
  return out;
}

/**
 * The stated amounts that do NOT match the booking price. Empty = no reason to
 * hold. A non-CZK amount can't be checked against a CZK price, so it always
 * counts; so does any amount when the booking price is unknown.
 */
export function mismatchedAmounts(
  stated: StatedAmount[],
  bookingPriceCzk: number | null | undefined,
): StatedAmount[] {
  return stated.filter(
    (s) =>
      s.currency !== 'CZK' ||
      bookingPriceCzk == null ||
      Math.abs(s.amount - bookingPriceCzk) > AMOUNT_TOLERANCE_CZK,
  );
}

// ─── Wording (task note, hold reason, Telegram) ──────────────────────────────

/** "3 509,41 Kč" / "150 EUR" — deterministic, independent of the runtime's ICU data. */
export function formatAmount(a: StatedAmount): string {
  const fixed = a.amount.toFixed(2);
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const num = dec === '00' ? grouped : `${grouped},${dec}`;
  return a.currency === 'CZK' ? `${num} Kč` : `${num} ${a.currency}`;
}

const czk = (amount: number): StatedAmount => ({ amount, currency: 'CZK' });

/** Separator between the task's own text and the amount note (lets a re-hold replace the note). */
export const AMOUNT_NOTE_SEPARATOR = ' · ⚠️ ';

/** Short machine-and-human reason stored on the Issue as `holdAutoSend`. */
export function amountHoldReason(
  mismatched: StatedAmount[],
  bookingPriceCzk: number | null | undefined,
): string {
  const asked = mismatched.map(formatAmount).join(' / ');
  return bookingPriceCzk == null
    ? `guest asked for ${asked}`
    : `guest asked for ${asked}, booking price ${formatAmount(czk(bookingPriceCzk))}`;
}

function isBookingCom(channel: string | null | undefined): boolean {
  return /booking/i.test(channel ?? '');
}

/** Appended to the "Send invoice — …" task text so the banner shows why it is held. */
export function amountTaskNote(
  mismatched: StatedAmount[],
  bookingPriceCzk: number | null | undefined,
  channel: string | null | undefined,
): string {
  const asked = mismatched.map(formatAmount).join(' / ');
  const price = bookingPriceCzk == null ? '' : ` (booking ${formatAmount(czk(bookingPriceCzk))})`;
  const cause = isBookingCom(channel) ? ', likely a "Booking.com pays" discount' : '';
  return `${AMOUNT_NOTE_SEPARATOR}Guest asked for ${asked}${price}${cause}. Modify the invoice amount and send manually.`;
}

/** Task text with any previous amount note replaced by the new one. */
export function withAmountNote(taskText: string, note: string): string {
  return `${taskText.split(AMOUNT_NOTE_SEPARATOR)[0]}${note}`;
}

export interface ManualInvoiceAlertInput {
  reservationNumber: string;
  companyName?: string | null;
  channel?: string | null;
  bookingPriceCzk?: number | null;
  /** Amounts the guest named that don't match the booking price. */
  mismatched?: StatedAmount[];
  /** Checkout date when it is beyond the auto-send window. */
  tooOldCheckout?: string | null;
  /** The invoice already went out; `bookingPriceCzk` is then the amount it was sent for. */
  alreadySent?: boolean;
}

/**
 * Telegram body (HTML parse mode) for an invoice the cron will not send.
 * `escape` is injected so this module stays free of the Telegram util's
 * imports; callers pass `escapeHtml` from utils/telegram.
 */
export function manualInvoiceAlert(
  input: ManualInvoiceAlertInput,
  escape: (s: string) => string,
): string {
  const lines = [
    `🧾 <b>Invoice needs a manual send</b> — ${escape(input.reservationNumber)}`,
  ];
  if (input.companyName) lines.push(`🏢 ${escape(input.companyName)}`);

  const mismatched = input.mismatched ?? [];
  if (mismatched.length > 0) {
    const asked = mismatched.map(formatAmount).join(' / ');
    const price =
      input.bookingPriceCzk != null ? formatAmount(czk(input.bookingPriceCzk)) : 'unknown';
    const single = mismatched.length === 1 && mismatched[0].currency === 'CZK' && input.bookingPriceCzk != null;
    const diff = single ? mismatched[0].amount - (input.bookingPriceCzk as number) : null;
    const diffText =
      diff != null ? ` (${diff < 0 ? '−' : '+'}${formatAmount(czk(Math.abs(diff)))})` : '';
    const priceLabel = input.alreadySent ? 'invoice was sent for' : 'booking price';
    lines.push(`💬 Guest asked for ${escape(asked)} · ${priceLabel} ${escape(price)}${escape(diffText)}`);
    if (isBookingCom(input.channel)) {
      lines.push(
        'ℹ️ Booking.com booking: most likely a "Booking.com pays" sponsored discount. It shows only in the extranet price breakdown, never in Beds24.',
      );
    }
    lines.push(
      input.alreadySent
        ? '⚠️ The invoice was already sent for a different amount. Re-issue it with the corrected amount if the guest is right.'
        : '➡️ Auto-send is held. Set the invoice amount in the drawer (Modify Invoice) and send it manually.',
    );
  }

  if (input.tooOldCheckout) {
    lines.push(
      `📅 Checkout ${escape(input.tooOldCheckout)} is more than 6 months ago, so auto-send skips it. Issue it manually if it is still wanted.`,
    );
  }
  return lines.join('\n');
}
