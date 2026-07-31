/**
 * Shared transactional guest-email sender over SMTP.
 *
 * Extracted so the mass-broadcast route (app/api/messages/broadcast) reuses the
 * exact transporter config the single-guest path uses in
 * app/api/send-guest-email/route.ts (from: reservations@bakerhouseapartments.cz,
 * STARTTLS on 587). That route is intentionally left calling nodemailer inline
 * for now — collapsing it onto this helper is a safe later cleanup.
 *
 * Throws on failure so callers can record a per-recipient error.
 */
import nodemailer from 'nodemailer';

const RESERVATIONS_ALIAS = 'reservations@bakerhouseapartments.cz';

/** Quick-and-dirty HTML → plain text for the multipart text/plain fallback.
 *  Mail clients that strip HTML still see something readable. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendGuestEmailInput {
  to: string;
  subject: string;
  html: string;
  /** Defaults to the reservations alias. */
  replyTo?: string;
}

export async function sendGuestEmail({
  to,
  subject,
  html,
  replyTo,
}: SendGuestEmailInput): Promise<void> {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error('SMTP not configured (SMTP_USER / SMTP_PASS missing)');
  }

  // Trim + falsy-coerce so an empty/whitespace-only env value falls back to the
  // hardcoded alias (?? only falls back on undefined, letting '' slip through).
  const fromAddress = process.env.SMTP_FROM_RESERVATIONS?.trim() || RESERVATIONS_ALIAS;
  const from = `"Baker House Apartments" <${fromAddress}>`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false, // STARTTLS on 587
    auth: { user: smtpUser, pass: smtpPass },
  });

  await transporter.sendMail({
    from,
    to,
    replyTo: replyTo ?? fromAddress,
    subject,
    text: htmlToText(html),
    html,
  });
}
