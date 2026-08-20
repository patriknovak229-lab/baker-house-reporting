/**
 * Shared invoice generate-and-email logic — the single source of truth used by
 * BOTH the manual send (POST /api/send-invoice) and the automatic checkout-date
 * cron (POST /api/cron/send-due-invoices). Extracted verbatim from the original
 * route so an auto-sent invoice is byte-for-byte identical to a manually-sent
 * one.
 *
 * Pure send: it builds the PDF and emails it. It does NOT touch reservation
 * overrides / invoiceStatus / tasks — each caller records that (the drawer sets
 * invoiceStatus="Sent" client-side; the cron sets it + resolves the task).
 *
 * ── SMTP outcomes (why this isn't just try/catch) ─────────────────────────────
 * Gmail answers a perfectly good message with a transient deferral often enough
 * that treating every throw as "not sent" reported false failures to the
 * operator (`Message failed: 451-4.3.0 Mail server temporarily rejected
 * message`). Nodemailer only produces that exact error from the reply to the
 * END of DATA — i.e. Google already has the whole message and then deferred the
 * acknowledgement, which it usually goes on to deliver anyway. Re-sending in
 * that state is what produces duplicate invoices, so we never retry it.
 *
 * So a send has three outcomes:
 *   'sent'      — 2xx, confirmed accepted.
 *   'deferred'  — transient 4xx AFTER the body was handed over. Delivery is
 *                 likely but unconfirmed. Not retried (duplicate risk), not
 *                 reported as a failure.
 *   throw       — genuinely not accepted: permanent 5xx, auth/config problems,
 *                 or a transient failure BEFORE the body went out that survived
 *                 every retry.
 * Retries only ever happen in the last, pre-DATA case, where nothing was
 * transmitted — so a retry that succeeds cannot duplicate the email.
 */

import nodemailer from 'nodemailer';
import QRCodeLib from 'qrcode';
import type { Reservation, InvoiceModification } from '@/types/reservation';
import {
  buildInvoiceHTML,
  generateInvoiceNumber,
  PAYMENT_IBAN,
} from '@/utils/invoiceUtils';
import { generatePDF } from '@/utils/pdfGenerate';

/** Bounded — total added latency stays well inside the route's maxDuration. */
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1_000, 3_000];

/** Connection-level nodemailer/Node failures worth one more try. */
const TRANSIENT_CODES = new Set([
  'ECONNECTION',
  'ECONNRESET',
  'ESOCKET',
  'ETIMEDOUT',
  'ETIMEOUT',
  'EAI_AGAIN',
  'EDNS',
]);

function buildSPDString(iban: string, amountCZK: number, vs: string): string {
  return `SPD*1.0*ACC:${iban}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
}

export interface SendInvoiceOptions {
  includeQR?: boolean;
  modification?: InvoiceModification;
}

export interface SendInvoiceResult {
  invoiceNumber: string;
  /** Address the invoice was sent to. */
  sentTo: string;
  /** 'sent' = server confirmed acceptance; 'deferred' = handed over, ack deferred. */
  outcome: 'sent' | 'deferred';
  /** 1 on the first try. >1 means a pre-DATA failure was retried. */
  attempts: number;
  /** Raw SMTP response, only set when outcome === 'deferred'. */
  deferral?: string;
}

interface SmtpFailure {
  /** Worth retrying if it happened before the body went out. */
  transient: boolean;
  /** The reply came back at the end of DATA → the server already has the message. */
  afterData: boolean;
  response?: string;
}

function classifySmtpError(err: unknown): SmtpFailure {
  const e = err as { responseCode?: unknown; code?: unknown; command?: unknown; response?: unknown };
  const responseCode = typeof e?.responseCode === 'number' ? e.responseCode : undefined;
  const code = typeof e?.code === 'string' ? e.code : undefined;
  const response = typeof e?.response === 'string' ? e.response : undefined;
  return {
    transient:
      responseCode !== undefined
        ? responseCode >= 400 && responseCode < 500
        : !!code && TRANSIENT_CODES.has(code),
    // nodemailer tags the end-of-DATA rejection with command 'DATA'; every
    // earlier stage (greeting / EHLO / AUTH / MAIL FROM / RCPT TO) is tagged
    // with its own command, so the body definitely never left.
    afterData: e?.command === 'DATA',
    response,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Generate the invoice PDF for a reservation and email it to the billing
 * address on `reservation.invoiceData`. Throws only when the message was
 * genuinely not accepted — see the outcome table at the top of this file.
 */
export async function sendInvoiceEmail(
  reservation: Reservation,
  opts: SendInvoiceOptions = {},
): Promise<SendInvoiceResult> {
  if (!reservation.invoiceData) {
    throw new Error('No invoice data on reservation');
  }
  if (!reservation.invoiceData.billingEmail) {
    throw new Error('No billing email on invoice');
  }

  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error('SMTP not configured (SMTP_USER / SMTP_PASS missing)');
  }

  const invoiceNum = generateInvoiceNumber(reservation.reservationNumber);
  const vs = invoiceNum.replace(/\D/g, '');
  // A modification may override the invoice total — the QR must ask for the
  // amount the invoice actually shows, not the booking price.
  const invoiceTotal = opts.modification?.amount ?? reservation.price;

  let payment:
    | { qrDataUrl: string; info: { spdString: string; vs: string; amountCZK: number } }
    | undefined;
  if (opts.includeQR) {
    const spdString = buildSPDString(PAYMENT_IBAN, invoiceTotal, vs);
    const qrDataUrl = await QRCodeLib.toDataURL(spdString, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    payment = { qrDataUrl, info: { spdString, vs, amountCZK: invoiceTotal } };
  }

  const html = buildInvoiceHTML(
    reservation,
    reservation.invoiceData,
    invoiceNum,
    payment,
    true, // forEmail — omits the window.print() script
    opts.modification,
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

  const to = reservation.invoiceData.billingEmail;
  // Built once and reused across retries: identical Message-ID means a
  // recipient that receives both copies (mail-server race) can collapse them,
  // and the ID shows up in Gmail's Sent folder for after-the-fact checking.
  const message = {
    from,
    to,
    messageId: `<${invoiceNum}-${Date.now()}@bakerhouseapartments.cz>`,
    subject: `Invoice ${invoiceNum} – Baker House Apartments`,
    text: `Dear guest,\n\nPlease find your invoice ${invoiceNum} attached.\n\nThank you for staying with us!\n\nPatrik & Zuzana\nBaker House Apartments\nhttps://www.bakerhouseapartments.cz`,
    attachments: [
      {
        filename: `${invoiceNum}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  };

  for (let attempt = 1; ; attempt++) {
    try {
      await transporter.sendMail(message);
      return { invoiceNumber: invoiceNum, sentTo: to, outcome: 'sent', attempts: attempt };
    } catch (err) {
      const { transient, afterData, response } = classifySmtpError(err);

      // Server already had the whole message and only deferred the ack. Almost
      // always delivered; re-sending is the one thing that could duplicate it.
      if (transient && afterData) {
        console.warn(
          `[invoiceSend] ${invoiceNum} deferred by the mail server after DATA (attempt ${attempt}): ${response ?? 'no response'}`,
        );
        return {
          invoiceNumber: invoiceNum,
          sentTo: to,
          outcome: 'deferred',
          attempts: attempt,
          deferral: response ?? (err instanceof Error ? err.message : String(err)),
        };
      }

      // Nothing was transmitted yet → safe to try again.
      if (transient && attempt < MAX_ATTEMPTS) {
        console.warn(
          `[invoiceSend] ${invoiceNum} transient SMTP failure before DATA (attempt ${attempt}), retrying: ${response ?? (err instanceof Error ? err.message : String(err))}`,
        );
        await sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1]);
        continue;
      }

      throw err;
    }
  }
}
