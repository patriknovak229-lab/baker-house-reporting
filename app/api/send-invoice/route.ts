import { NextRequest, NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import QRCodeLib from 'qrcode';
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import type { Reservation } from '@/types/reservation';
import {
  buildInvoiceHTML,
  generateInvoiceNumber,
  PAYMENT_IBAN,
} from '@/utils/invoiceUtils';

function buildSPDString(iban: string, amountCZK: number, vs: string): string {
  return `SPD*1.0*ACC:${iban}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
}

async function generatePDF(html: string): Promise<Buffer> {
  const executablePath =
    process.env.CHROME_EXECUTABLE_PATH ?? await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '18mm', bottom: '14mm', left: '18mm' },
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}

export async function POST(req: NextRequest) {
  const { reservation, includeQR }: { reservation: Reservation; includeQR?: boolean } = await req.json();

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
      true // forEmail — omits the window.print() script
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
