import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';

export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const { to, guestName, description, amountCzk, paymentUrl } = await req.json();

  if (!to || !paymentUrl) {
    return NextResponse.json({ error: 'to and paymentUrl are required' }, { status: 400 });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return NextResponse.json({ error: 'SMTP not configured' }, { status: 500 });
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const from = process.env.SMTP_FROM
    ? `"Baker House Apartments" <${process.env.SMTP_FROM}>`
    : `"Baker House Apartments" <${smtpUser}>`;

  const greeting = guestName ? `Dear ${guestName},` : 'Dear guest,';
  const amountLabel = amountCzk ? `${Number(amountCzk).toLocaleString('cs-CZ')} Kč` : '';

  const text = [
    greeting,
    '',
    `We have prepared a payment request for you${description ? `: ${description}` : ''}.`,
    amountLabel ? `Amount: ${amountLabel}` : '',
    '',
    `Please complete your payment using the secure link below:`,
    paymentUrl,
    '',
    'The link is valid for 30 days.',
    '',
    'Thank you,',
    'Patrik & Zuzana',
    'Baker House Apartments',
    'https://www.bakerhouseapartments.cz',
  ].filter((l) => l !== undefined).join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <p>${greeting}</p>
      <p>We have prepared a payment request for you${description ? `: <strong>${description}</strong>` : ''}.</p>
      ${amountLabel ? `<p>Amount: <strong>${amountLabel}</strong></p>` : ''}
      <p style="margin:24px 0">
        <a href="${paymentUrl}"
           style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
          Pay now
        </a>
      </p>
      <p style="font-size:13px;color:#666">Or copy this link: <a href="${paymentUrl}">${paymentUrl}</a></p>
      <p style="font-size:12px;color:#999">This link is valid for 30 days.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:13px;color:#666">Patrik &amp; Zuzana<br/>Baker House Apartments</p>
    </div>
  `;

  await transporter.sendMail({
    from,
    to,
    subject: `Payment request${description ? ` — ${description}` : ''} · Baker House Apartments`,
    text,
    html,
  });

  return NextResponse.json({ ok: true });
}
