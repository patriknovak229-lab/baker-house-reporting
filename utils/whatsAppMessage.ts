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

export type WhatsAppLang = 'en' | 'cs';

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
  /** Language for static copy (greeting, voucher labels, sign-off, redemption
   *  CTA). Defaults to 'en'. `bodyParagraphs` are emitted verbatim. */
  lang?: WhatsAppLang;
}

export const DEFAULT_WHATSAPP_BODY = [
  'Thank you for staying with us at Baker House Apartments — and especially for the wonderful rating you left us. It genuinely means a lot to our small family-run team.',
  'As a small token of our appreciation, please accept the voucher below. Use it on your next stay with us, or pass it on to a friend or family member.',
];

/** Czech-language equivalent of DEFAULT_WHATSAPP_BODY. Mirrors the same two
 *  paragraphs in the email template — keep them in sync if either changes. */
export const DEFAULT_WHATSAPP_BODY_CS = [
  'Děkujeme, že jste si pobyt vybrali u nás v Baker House Apartments — a obzvlášť za skvělé hodnocení, které jste nám zanechali. Pro náš malý rodinný tým to opravdu hodně znamená.',
  'Jako malé poděkování přijměte prosím poukaz níže. Můžete ho využít při svém příštím pobytu u nás, nebo ho předat příteli či rodinnému příslušníkovi.',
];

/** Pick the right default body for the chosen language. */
export function defaultWhatsAppBodyForLang(lang: WhatsAppLang): string[] {
  return lang === 'cs' ? DEFAULT_WHATSAPP_BODY_CS : DEFAULT_WHATSAPP_BODY;
}

const REDEMPTION_URL = 'https://www.bakerhouseapartments.cz/';

/** Per-language string table for WhatsApp. Same shape as the email i18n
 *  object so changes stay obviously parallel. */
const I18N_WA = {
  en: {
    greeting: (name: string) => `Dear ${name},`,
    voucherHeading: '🎁 *Your voucher*',
    voucherLine: (code: string, amount: string) => `\`\`\`${code}\`\`\`  (${amount} off)`,
    validUntil: (date: string) => `Valid until ${date}`,
    redemptionLine: `Redeem at ${REDEMPTION_URL}`,
    disclaimer:
      '_The voucher is only redeemable through our official website above — it cannot be used on Booking.com, Airbnb, or other channels._',
    signOffLine: 'Warm regards,',
    signOff: 'Patrik & Zuzana',
  },
  cs: {
    greeting: (name: string) => `Milý ${name},`,
    voucherHeading: '🎁 *Váš poukaz*',
    voucherLine: (code: string, amount: string) => `\`\`\`${code}\`\`\`  (sleva ${amount})`,
    validUntil: (date: string) => `Platnost do ${date}`,
    redemptionLine: `Uplatněte na ${REDEMPTION_URL}`,
    disclaimer:
      '_Poukaz lze uplatnit pouze na našem oficiálním webu výše — nelze ho použít na Booking.com, Airbnb ani jiných kanálech._',
    signOffLine: 'S přátelským pozdravem,',
    signOff: 'Patrik & Zuzana',
  },
} as const;

/** Render the WhatsApp message body. Pure function — no side effects. */
export function renderWhatsAppMessage(vars: WhatsAppMessageVars): string {
  const lang: WhatsAppLang = vars.lang === 'cs' ? 'cs' : 'en';
  const t = I18N_WA[lang];
  const firstName = (vars.firstName || 'there').trim();
  const expiry = formatExpiry(vars.voucherExpiresAt, lang);
  const paragraphs = (vars.bodyParagraphs ?? defaultWhatsAppBodyForLang(lang))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const body = paragraphs.join('\n\n');

  // WhatsApp markup: *text* = bold, _text_ = italic, ```text``` = monospace.
  // The voucher code uses monospace so it stands out as something to copy.
  return [
    t.greeting(firstName),
    '',
    body,
    '',
    t.voucherHeading,
    t.voucherLine(vars.voucherCode, vars.voucherAmount),
    t.validUntil(expiry),
    '',
    t.redemptionLine,
    '',
    t.disclaimer,
    '',
    t.signOffLine,
    t.signOff,
    'Baker House Apartments',
  ].join('\n');
}

/**
 * Build a WhatsApp deeplink that opens with the given recipient + text
 * pre-filled. The operator still has to tap Send inside WhatsApp — this
 * is intentionally not a silent-send mechanism.
 *
 * Defaults to `https://web.whatsapp.com/send?...` rather than `wa.me/...`
 * because the operator runs WhatsApp Business inside Chrome (a separate
 * profile from the personal Desktop app). `wa.me` is the universal short
 * link, but macOS/Windows hand it off to the registered native handler —
 * which on this machine is the personal WhatsApp Desktop. `web.whatsapp.com`
 * is a plain HTTPS URL with no native handler, so the browser keeps it in
 * the current tab/profile — i.e. whichever Chrome profile is currently
 * signed in to WhatsApp Business.
 *
 * To pick the Business profile reliably, the operator should run the
 * reporting dashboard inside that same Chrome profile — link clicks open
 * in the profile they originated from.
 *
 * Override via `NEXT_PUBLIC_WHATSAPP_URL_BASE` if you ever want to switch
 * back to wa.me or use a different host (e.g. for testing). Valid values:
 *   - "web.whatsapp.com" (default, browser-only)
 *   - "wa.me"            (universal, may hand off to native app)
 *   - "api.whatsapp.com" (legacy API host, behaves like wa.me)
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
  const host = (process.env.NEXT_PUBLIC_WHATSAPP_URL_BASE || 'web.whatsapp.com').trim();
  const encodedText = encodeURIComponent(text);
  if (host === 'wa.me') {
    return `https://wa.me/${cleaned}?text=${encodedText}`;
  }
  // web.whatsapp.com and api.whatsapp.com both use ?phone=&text=
  return `https://${host}/send?phone=${cleaned}&text=${encodedText}`;
}

function formatExpiry(iso?: string, lang: WhatsAppLang = 'en'): string {
  const date = iso
    ? new Date(iso)
    : (() => {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 1);
        return d;
      })();
  const fallback = lang === 'cs' ? 'jeden rok od data vystavení' : 'one year from issue date';
  if (Number.isNaN(date.getTime())) return fallback;
  const locale = lang === 'cs' ? 'cs-CZ' : 'en-GB';
  return date.toLocaleDateString(locale, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}
