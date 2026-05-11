/**
 * POST /api/send-guest-email
 *
 * Body: { to: string, subject: string, html: string, reservationNumber?: string }
 *
 * Sends an operator-composed guest email via SMTP. Used by EmailGuestModal to
 * deliver template-rendered HTML (e.g. Thank You + voucher) after operator
 * review. Caller is responsible for rendering the HTML — this route just
 * relays it. Plain-text fallback is auto-derived from the HTML.
 *
 * From: reservations@bakerhouseapartments.cz alias (same as send-confirmation).
 * Auth: admin / super.
 */

import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';

const RESERVATIONS_ALIAS = 'reservations@bakerhouseapartments.cz';

/** Quick-and-dirty HTML → plain text for the multipart text/plain fallback.
 *  Mail clients that strip HTML still see something readable. */
function htmlToText(html: string): string {
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

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  let body: { to?: string; subject?: string; html?: string; reservationNumber?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const to = body.to?.trim();
  const subject = body.subject?.trim();
  const html = body.html?.trim();

  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return NextResponse.json({ error: 'Valid `to` email is required' }, { status: 400 });
  }
  if (!subject) {
    return NextResponse.json({ error: '`subject` is required' }, { status: 400 });
  }
  if (!html) {
    return NextResponse.json({ error: '`html` is required' }, { status: 400 });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return NextResponse.json(
      { error: 'SMTP not configured (SMTP_USER / SMTP_PASS missing)' },
      { status: 500 },
    );
  }

  // Trim + falsy-coerce so empty/whitespace-only env values fall back to the
  // hardcoded alias (?? only falls back on undefined, which lets an empty
  // string slip through and break the send).
  const fromAddress = process.env.SMTP_FROM_RESERVATIONS?.trim() || RESERVATIONS_ALIAS;
  const from = `"Baker House Apartments" <${fromAddress}>`;

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT ?? '587'),
      secure: false, // STARTTLS on 587
      auth: { user: smtpUser, pass: smtpPass },
    });

    await transporter.sendMail({
      from,
      to,
      replyTo: fromAddress,
      subject,
      text: htmlToText(html),
      html,
    });

    return NextResponse.json({
      ok: true,
      sentTo: to,
      reservationNumber: body.reservationNumber,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[send-guest-email] sendMail failed:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
