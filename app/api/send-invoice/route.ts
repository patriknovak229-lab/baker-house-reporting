import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';
import QRCodeLib from 'qrcode';
import type { Reservation, InvoiceModification } from '@/types/reservation';
import {
  buildInvoiceHTML,
  generateInvoiceNumber,
  PAYMENT_IBAN,
} from '@/utils/invoiceUtils';
import { generatePDF } from '@/utils/pdfGenerate';

function buildSPDString(iban: string, amountCZK: number, vs: string): string {
  return `SPD*1.0*ACC:${iban}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
}


export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservation, includeQR, modification }: {
    reservation: Reservation;
    includeQR?: boolean;
    modification?: InvoiceModification;
  } = await req.json();

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

  try {
    const invoiceNum = generateInvoiceNumber(reservation.reservationNumber);
    const vs = invoiceNum.replace(/\D/g, '');

    let payment: { qrDataUrl: string; info: { spdString: string; vs: string; amountCZK: number } } | undefined;
    if (includeQR) {
      const spdString = buildSPDString(PAYMENT_IBAN, reservation.price, vs);
      const qrDataUrl = await QRCodeLib.toDataURL(spdString, {
        width: 200,
        margin: 1,
        errorCorrectionLevel: 'M',
      });
      payment = { qrDataUrl, info: { spdString, vs, amountCZK: reservation.price } };
    }

    const html = buildInvoiceHTML(
      reservation,
      reservation.invoiceData,
      invoiceNum,
      payment,
      true, // forEmail — omits the window.print() script
      modification
    );

    const pdfBuffer = await generatePDF(html);

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
      text: `Dear guest,\n\nPlease find your invoice ${invoiceNum} attached.\n\nThank you for staying with us!\n\nPatrik & Zuzana\nBaker House Apartments\nhttps://www.bakerhouseapartments.cz`,
      attachments: [
        {
          filename: `${invoiceNum}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
