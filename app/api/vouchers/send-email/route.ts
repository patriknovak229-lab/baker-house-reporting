import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';

// POST /api/vouchers/send-email — send voucher code to guest via email
export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const { to, guestName, voucherCode, discountType, value } = await req.json();

  if (!to || !voucherCode) {
    return NextResponse.json({ error: 'to and voucherCode are required' }, { status: 400 });
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
  const discountLabel = discountType === 'percentage'
    ? `${value}% off`
    : `${Number(value).toLocaleString('cs-CZ')} Kč`;

  const text = [
    greeting,
    '',
    `We'd like to offer you a special discount for your next stay at Baker House Apartments!`,
    '',
    `Your voucher code: ${voucherCode}`,
    `Discount: ${discountLabel}`,
    '',
    `Enter this code during booking on our website:`,
    'https://www.bakerhouseapartments.cz',
    '',
    'This voucher is valid for 12 months and can be used once.',
    '',
    'We look forward to welcoming you!',
    '',
    'Patrik & Zuzana',
    'Baker House Apartments',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <p>${greeting}</p>
      <p>We'd like to offer you a special discount for your next stay at Baker House Apartments!</p>
      <div style="background:#f5f3ff;border:2px dashed #7c3aed;border-radius:12px;padding:20px;text-align:center;margin:24px 0">
        <p style="font-size:13px;color:#6b21a8;margin:0 0 8px">Your voucher code</p>
        <p style="font-size:28px;font-weight:bold;color:#5b21b6;margin:0;letter-spacing:1px">${voucherCode}</p>
        <p style="font-size:14px;color:#7c3aed;margin:8px 0 0">Discount: <strong>${discountLabel}</strong></p>
      </div>
      <p>Enter this code during booking on our website:</p>
      <p style="margin:16px 0">
        <a href="https://www.bakerhouseapartments.cz"
           style="background:#5b21b6;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
          Book now
        </a>
      </p>
      <p style="font-size:12px;color:#999">This voucher is valid for 12 months and can be used once.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:13px;color:#666">Patrik &amp; Zuzana<br/>Baker House Apartments</p>
    </div>
  `;

  await transporter.sendMail({
    from,
    to,
    subject: `Your discount voucher · Baker House Apartments`,
    text,
    html,
  });

  return NextResponse.json({ ok: true });
}
