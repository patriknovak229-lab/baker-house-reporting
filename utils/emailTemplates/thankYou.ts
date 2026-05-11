import {
  GOLD,
  DARK_BROWN,
  MID_BROWN,
  LIGHT_BG,
  CURSIVE_FONT_IMPORT,
  CURSIVE_FONT_STACK,
  BODY_FONT_STACK,
} from './palette';

export interface ThankYouVars {
  /** Required — guest's first name for the greeting. */
  firstName: string;
  /** Optional — the voucher code to include. When omitted the voucher block is hidden. */
  voucherCode?: string;
  /** Optional — voucher amount + unit, e.g. "1 000 Kč" or "10%". When omitted the
   *  voucher block falls back to "Special discount". */
  voucherAmount?: string;
  /** Optional — ISO date YYYY-MM-DD. Defaults to "1 year from today" in the rendered text. */
  voucherExpiresAt?: string;
  /** Optional override — array of paragraph strings replacing the default body copy.
   *  Empty strings are filtered out. Use when operator wants to customise the message. */
  bodyParagraphs?: string[];
}

/** Default body copy used when `bodyParagraphs` is not supplied. Exposed so the
 *  modal can pre-fill its editor with the same text we'd otherwise render. */
export const DEFAULT_THANK_YOU_BODY = [
  'Thank you for staying with us at Baker House Apartments — and especially for the wonderful rating you left us. It genuinely means a lot to our small family-run team.',
  'As a small token of our appreciation, please accept the voucher below. Use it on your next stay with us, or pass it on to a friend or family member.',
];

export const THANK_YOU_SUBJECT = (firstName: string) =>
  `Thank you for staying with Baker House Apartments`
  + (firstName ? ` — ${firstName}` : '');

/** Render the Thank You email HTML with the supplied variables. Pure function:
 *  same input → same output. Safe to call repeatedly during preview editing. */
export function renderThankYouEmail(vars: ThankYouVars): string {
  const firstName = (vars.firstName || 'there').trim();
  const hasVoucher = !!(vars.voucherCode && vars.voucherCode.trim());
  const voucherCode = (vars.voucherCode || '').trim();
  const voucherAmount = (vars.voucherAmount || '').trim() || 'Special discount';
  const expiresAt = formatExpiry(vars.voucherExpiresAt);
  const paragraphs = (vars.bodyParagraphs ?? DEFAULT_THANK_YOU_BODY)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const bodyHtml = paragraphs
    .map((p) => `<p style="margin:0 0 14px">${escapeHtml(p)}</p>`)
    .join('\n          ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Thank you — Baker House Apartments</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${CURSIVE_FONT_IMPORT}">
</head>
<body style="margin:0;padding:0;background:#fff;font-family:${BODY_FONT_STACK};color:${DARK_BROWN};line-height:1.5">
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff;padding:24px 0">
    <tr><td align="center">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="560" style="max-width:560px;width:100%;background:#fff;border:1px solid #eee9e0;border-radius:8px;overflow:hidden">

        <!-- Header -->
        <tr><td style="padding:24px 32px 8px;text-align:center;border-bottom:2px solid ${GOLD}">
          <div style="font-family:${CURSIVE_FONT_STACK};font-size:48px;color:${GOLD};line-height:1.1">
            Baker House Apartments
          </div>
          <div style="font-size:11px;color:${MID_BROWN};letter-spacing:1.5px;text-transform:uppercase;margin-top:4px">
            Brno, Czech Republic
          </div>
        </td></tr>

        <!-- Greeting + body copy -->
        <tr><td style="padding:28px 32px 16px;font-size:15px;color:${DARK_BROWN}">
          <p style="margin:0 0 14px">Dear ${escapeHtml(firstName)},</p>
          ${bodyHtml}
        </td></tr>

        ${hasVoucher ? renderVoucherBlock(voucherCode, voucherAmount, expiresAt) : ''}

        <!-- Sign-off -->
        <tr><td style="padding:8px 32px 32px;text-align:center">
          <div style="font-family:${CURSIVE_FONT_STACK};font-size:32px;color:${GOLD};line-height:1.2;margin-top:16px">
            Patrik &amp; Zuzana
          </div>
          <div style="font-size:11px;color:${MID_BROWN};margin-top:4px;letter-spacing:0.5px">
            Baker House Apartments
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="padding:14px 32px;border-top:1px solid #f0ebe2;text-align:center;font-size:11px;color:#9a8e80">
          <a href="https://www.bakerhouseapartments.cz" style="color:${GOLD};text-decoration:none">bakerhouseapartments.cz</a>
          &nbsp;·&nbsp; reservations@bakerhouseapartments.cz
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function renderVoucherBlock(code: string, amountLabel: string, expiresAt: string): string {
  return `
        <tr><td style="padding:8px 32px 16px">
          <div style="background:${LIGHT_BG};border:1.5px dashed ${GOLD};border-radius:8px;padding:24px;text-align:center">
            <div style="font-size:11px;letter-spacing:2px;color:${MID_BROWN};text-transform:uppercase;margin-bottom:8px">
              Your voucher
            </div>
            <div style="font-family:${CURSIVE_FONT_STACK};font-size:36px;color:${GOLD};line-height:1.1;margin-bottom:14px">
              ${escapeHtml(amountLabel)}
            </div>
            <!-- Code box: large, monospaced, generous padding, user-select:all
                 for one-tap selection in clients that honour CSS. The label
                 below makes copy intent unambiguous. -->
            <div style="display:inline-block;padding:14px 22px;background:#fff;border:1px solid ${GOLD};border-radius:6px;font-family:'Courier New', monospace;font-size:22px;font-weight:bold;color:${DARK_BROWN};letter-spacing:3px;-webkit-user-select:all;user-select:all">
              ${escapeHtml(code)}
            </div>
            <div style="font-size:10px;color:${MID_BROWN};margin-top:6px;letter-spacing:0.5px;text-transform:uppercase">
              Tap or select to copy
            </div>
            <div style="font-size:11px;color:${MID_BROWN};margin-top:14px">
              Valid until ${escapeHtml(expiresAt)}
            </div>
          </div>
        </td></tr>

        <!-- Redemption CTA — explains where to use the code and provides a
             prominent button to the rental site. -->
        <tr><td style="padding:0 32px 24px;text-align:center">
          <div style="font-size:13px;color:${DARK_BROWN};margin-bottom:14px;line-height:1.5">
            Redeem your voucher on our website at checkout:
          </div>
          <a href="https://www.bakerhouseapartments.cz/"
             style="display:inline-block;padding:14px 32px;background:${GOLD};color:#fff;text-decoration:none;font-size:14px;font-weight:600;letter-spacing:1px;border-radius:6px;text-transform:uppercase">
            Book your next stay
          </a>
          <div style="font-size:11px;color:${MID_BROWN};margin-top:10px">
            <a href="https://www.bakerhouseapartments.cz/" style="color:${MID_BROWN};text-decoration:underline">
              www.bakerhouseapartments.cz
            </a>
          </div>
          <div style="font-size:10px;color:#a9968a;margin-top:8px;line-height:1.4">
            The voucher is only redeemable through our official website above —
            it cannot be used on Booking.com, Airbnb, or other channels.
          </div>
        </td></tr>`;
}

/** Sensible default: 1 year from today, formatted as "DD MMM YYYY" in English. */
function formatExpiry(iso?: string): string {
  const date = iso ? new Date(iso) : (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    return d;
  })();
  if (Number.isNaN(date.getTime())) return 'one year from issue date';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
