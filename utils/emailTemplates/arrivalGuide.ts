/**
 * Arrival-guide email — the emailable twin of the Beds24-chat guide in
 * utils/arrivalGuide.ts, for guests who have no OTA chat thread (direct and
 * direct-phone bookings).
 *
 * The body arrives as plain-text blocks (the same ones the operator edits in
 * the modal's textarea) rather than as structured sections, so whatever they
 * type survives verbatim. A block whose first line opens with one of the
 * guide's emoji markers renders as a section heading; everything else is a
 * paragraph with its line breaks preserved.
 *
 * The page chrome (header, sign-off, footer) intentionally mirrors
 * ./thankYou.ts rather than being factored out of it — the thank-you email is
 * live and shared markup would put every future edit to one at risk of
 * breaking the other. Shared *values* live in ./palette.
 */

import {
  GOLD,
  DARK_BROWN,
  MID_BROWN,
  CURSIVE_FONT_IMPORT,
  CURSIVE_FONT_STACK,
  BODY_FONT_STACK,
} from './palette';
import type { GuideLang } from '@/utils/arrivalGuide';

export interface ArrivalGuideEmailVars {
  /** Guest's first name for the greeting. */
  firstName: string;
  /** Blank-line-separated blocks of the guide, in order. */
  bodyBlocks: string[];
  /** Language of the static chrome (greeting, title). Body text is verbatim. */
  lang?: GuideLang;
}

const I18N = {
  en: {
    greeting: (name: string) => `Dear ${name},`,
    title: 'Your arrival — Baker House Apartments',
    signOff: 'Patrik & Zuzana',
  },
  cs: {
    greeting: (name: string) => `Milý ${name},`,
    title: 'Váš příjezd — Baker House Apartments',
    signOff: 'Patrik & Zuzana',
  },
} as const;

/** Leading markers used by buildArrivalGuide's sections. A block starting with
 *  one of these gets the heading treatment. */
const SECTION_ICONS = ['📍', '🔑', '🚗', '📶', '🧳'];

export function renderArrivalGuideEmail(vars: ArrivalGuideEmailVars): string {
  const lang: GuideLang = vars.lang === 'cs' ? 'cs' : 'en';
  const t = I18N[lang];
  const firstName = (vars.firstName || 'there').trim();

  const bodyHtml = vars.bodyBlocks
    .map((block) => block.trim())
    .filter(Boolean)
    .map(renderBlock)
    .join('\n          ');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(t.title)}</title>
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

        <!-- Greeting + the guide itself -->
        <tr><td style="padding:28px 32px 16px;font-size:15px;color:${DARK_BROWN}">
          <p style="margin:0 0 14px">${escapeHtml(t.greeting(firstName))}</p>
          ${bodyHtml}
        </td></tr>

        <!-- Sign-off -->
        <tr><td style="padding:8px 32px 32px;text-align:center">
          <div style="font-family:${CURSIVE_FONT_STACK};font-size:32px;color:${GOLD};line-height:1.2;margin-top:16px">
            ${escapeHtml(t.signOff)}
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

/** One editor block -> one HTML chunk. Heading blocks get the gold label
 *  treatment; everything else is a paragraph that keeps its line breaks. */
function renderBlock(block: string): string {
  const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
  const [first, ...rest] = lines;
  const isHeading = SECTION_ICONS.some((icon) => first.startsWith(icon));

  if (!isHeading) {
    return `<p style="margin:0 0 14px">${lines.map(linkify).join('<br>')}</p>`;
  }

  const body = rest.length
    ? `<p style="margin:0 0 16px">${rest.map(linkify).join('<br>')}</p>`
    : '';
  return `<div style="font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:${GOLD};margin:0 0 6px">${linkify(first)}</div>
          ${body}`;
}

/** Escape, then turn bare http(s) URLs into links — guests get the maps pin
 *  as something tappable rather than a string to copy out. */
function linkify(line: string): string {
  const escaped = escapeHtml(line);
  return escaped.replace(
    /https?:\/\/[^\s<]+/g,
    (url) => `<a href="${url}" style="color:${GOLD};text-decoration:underline">${url}</a>`,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
