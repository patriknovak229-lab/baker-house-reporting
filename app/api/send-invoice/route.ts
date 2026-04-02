import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import QRCodeLib from 'qrcode';
import type { Reservation } from '@/types/reservation';
import {
  buildInvoiceHTML,
  generateInvoiceNumber,
  PAYMENT_IBAN,
} from '@/utils/invoiceUtils';

function buildSPDString(iban: string, amountCZK: number, vs: string): string {
  return `SPD*1.0*ACC:${iban}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
}

export async function POST(req: NextRequest) {
  const { reservation }: { reservation: Reservation } = await req.json();

  if (!reservation.invoiceData) {
    return NextResponse.json({ error: 'No invoice data on reservation' }, { status: 400 });
  }
  if (!reservation.invoiceData.billingEmail) {
    return NextResponse.json({ error: 'No billing email on invoice' }, { status: 400 });
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    return NextResponse.json({ error: 'SMTP not configured (SMTP_USER / SMTP_PASS missing)' }, { status: 500 });
  }

  const invoiceNum = generateInvoiceNumber(reservation.reservationNumber);
  const vs = invoiceNum.replace(/\D/g, '');
  const spdString = buildSPDString(PAYMENT_IBAN, reservation.price, vs);

  const qrDataUrl = await QRCodeLib.toDataURL(spdString, {
    width: 200,
    margin: 1,
    errorCorrectionLevel: 'M',
  });

  const html = buildInvoiceHTML(
    reservation,
    reservation.invoiceData,
    invoiceNum,
    { qrDataUrl, info: { spdString, vs, amountCZK: reservation.price } },
    true // forEmail — omits the window.print() script
  );

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false, // STARTTLS on port 587
    auth: { user: smtpUser, pass: smtpPass },
  });

  const from = process.env.SMTP_FROM
    ? `"Baker House Apartments" <${process.env.SMTP_FROM}>`
    : `"Baker House Apartments" <${smtpUser}>`;

  await transporter.sendMail({
    from,
    to: reservation.invoiceData.billingEmail,
    subject: `Invoice ${invoiceNum} – Baker House Apartments`,
    html,
  });

  return NextResponse.json({ ok: true });
}
