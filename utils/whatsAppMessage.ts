/**
 * Plain-text WhatsApp rendering of the Thank You message.
 *
 * Mirrors the HTML email template (utils/emailTemplates/thankYou.ts) but emits
 * a WhatsApp-friendly plain-text body — *bold* / underscores for emphasis,
 * no HTML, no inline CSS. The voucher block is rendered as a clean little
 * box of plain text. The redemption link is included as a bare URL so
 * WhatsApp auto-linkifies it.
 *
 * Used by EmailGuestModal when `channel === 'whatsapp'`.
 */

export interface WhatsAppMessageVars {
  firstName: string;
  voucherCode: string;
  /** Pre-formatted amount label, e.g. "1 000 Kč" or "10%". */
  voucherAmount: string;
  /** Optional ISO date — defaults to "1 year from today" in the rendered text. */
  voucherExpiresAt?: string;
  /** Operator-edited body paragraphs (same array as the email modal feeds the
   *  HTML template). When omitted the default Thank You copy is used. */
  bodyParagraphs?: string[];
}

export const DEFAULT_WHATSAPP_BODY = [
  'Thank you for staying with us at Baker House Apartments — and especially for the wonderful rating you left us. It genuinely means a lot to our small family-run team.',
  'As a small token of our appreciation, please accept the voucher below. Use it on your next stay with us, or pass it on to a friend or family member.',
];

const REDEMPTION_URL = 'https://www.bakerhouseapartments.cz/';

/** Render the WhatsApp message body. Pure function — no side effects. */
export function renderWhatsAppMessage(vars: WhatsAppMessageVars): string {
  const firstName = (vars.firstName || 'there').trim();
  const expiry = formatExpiry(vars.voucherExpiresAt);
  const paragraphs = (vars.bodyParagraphs ?? DEFAULT_WHATSAPP_BODY)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const body = paragraphs.join('\n\n');

  // WhatsApp markup: *text* = bold, _text_ = italic, ```text``` = monospace.
  // The voucher code uses monospace so it stands out as something to copy.
  return [
    `Dear ${firstName},`,
    '',
    body,
    '',
    '🎁 *Your voucher*',
    `\`\`\`${vars.voucherCode}\`\`\`  (${vars.voucherAmount} off)`,
    `Valid until ${expiry}`,
    '',
    `Redeem at ${REDEMPTION_URL}`,
    '',
    '_The voucher is only redeemable through our official website above — it cannot be used on Booking.com, Airbnb, or other channels._',
    '',
    'Warm regards,',
    'Patrik & Zuzana',
    'Baker House Apartments',
  ].join('\n');
}

/**
 * Build a wa.me deeplink that opens WhatsApp (Web or app) with the given
 * recipient + text pre-filled. The operator still has to tap Send inside
 * WhatsApp — wa.me is intentionally not a silent-send mechanism.
 *
 * Phone must be normalised to international digits without the leading `+`.
 * Throws when the phone looks unusable so the UI surfaces an error instead
 * of opening a broken link.
 */
export function buildWhatsAppDeeplink(rawPhone: string, text: string): string {
  const cleaned = (rawPhone || '').replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (cleaned.length < 8) {
    throw new Error(
      `Phone "${rawPhone}" doesn't look like a valid international number`,
    );
  }
  return `https://wa.me/${cleaned}?text=${encodeURIComponent(text)}`;
}

function formatExpiry(iso?: string): string {
  const date = iso
    ? new Date(iso)
    : (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 1);
        return d;
      })();
  if (Number.isNaN(date.getTime())) return 'one year from issue date';
  return date.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
