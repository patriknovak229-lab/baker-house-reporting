/**
 * SERVER ONLY. The corporate invoice as a document and an email: HTML/PDF
 * rendering, sending to the company's invoice address, and the 09:00 cron step
 * that issues + emails the scheduled ones.
 *
 * Split from utils/corporateInvoiceService.ts because this half reaches
 * headless Chromium (generatePDF): every route importing it must be listed in
 * CHROMIUM_ROUTES (next.config.ts), and utils/pdfTracing.test.ts checks that.
 */
import QRCodeLib from 'qrcode';
import { getAgreementDetail } from '@/data-access/corporate';
import { getInvoice, listDueScheduledInvoices, updateInvoice } from '@/data-access/corporateInvoices';
import { generatePDF } from '@/utils/pdfGenerate';
import { sendMailWithRetry } from '@/utils/invoiceSend';
import { escapeHtml, invoiceAlertChatId, sendTechnicalAlert, sendTelegram } from '@/utils/telegram';
import { buildCorporateInvoiceHTML, corporateSpdString } from '@/utils/corporateInvoiceHtml';
import { monthLabel, type CorporateInvoice } from '@/utils/corporateInvoice';
import {
  InvoiceError,
  billToFromAgreement,
  describePeriod,
  issueInvoice,
  loadReservationsByNumber,
  previewInvoice,
} from '@/utils/corporateInvoiceService';
import { formatStayDate } from '@/utils/corporateShared';
import { offerDate } from '@/utils/corporateOfferHtml';

// ─── Rendering + sending ─────────────────────────────────────────────────────

export async function renderIssuedInvoiceHtml(inv: CorporateInvoice): Promise<string> {
  if (!inv.invoiceNumber || !inv.lines || !inv.billTo || inv.amountCzk === null) throw new InvoiceError('Invoice is not issued yet');
  const qrDataUrl = inv.includePaymentDetails
    ? await QRCodeLib.toDataURL(corporateSpdString(inv.invoiceNumber, inv.amountCzk), { width: 200, margin: 1, errorCorrectionLevel: 'M' })
    : null;
  return buildCorporateInvoiceHTML({
    invoiceNumber: inv.invoiceNumber,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    periodFrom: inv.periodFrom,
    periodTo: inv.periodTo,
    billedMonth: inv.billedMonth,
    agreementId: inv.agreementId,
    billTo: inv.billTo,
    lines: inv.lines,
    totalCzk: inv.amountCzk,
    payment: inv.includePaymentDetails ? { qrDataUrl } : null,
  });
}

/** HTML preview of a scheduled invoice as it would be issued today (watermarked). */
export async function renderDraftInvoiceHtml(inv: CorporateInvoice, today: string): Promise<string> {
  const agreement = await getAgreementDetail(inv.agreementId);
  if (!agreement) throw new InvoiceError('Agreement not found', 404);
  const preview = await previewInvoice(agreement, inv.periodFrom, inv.periodTo);
  return buildCorporateInvoiceHTML({
    invoiceNumber: 'INV-C—',
    issueDate: inv.issueDate < today ? today : inv.issueDate,
    dueDate: inv.dueDate,
    periodFrom: inv.periodFrom,
    periodTo: inv.periodTo,
    billedMonth: inv.billedMonth,
    agreementId: inv.agreementId,
    billTo: billToFromAgreement(agreement),
    lines: preview.lines,
    totalCzk: preview.totalCzk,
    payment: inv.includePaymentDetails ? { qrDataUrl: null } : null,
    draft: true,
  });
}

function fileSlug(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'invoice';
}

export function invoiceFilename(inv: CorporateInvoice): string {
  return `${inv.invoiceNumber ?? 'invoice'}_${fileSlug(inv.billTo?.companyName ?? '')}.pdf`;
}

export async function renderInvoicePdf(inv: CorporateInvoice): Promise<Buffer> {
  return generatePDF(await renderIssuedInvoiceHtml(inv));
}

function emailText(inv: CorporateInvoice): string {
  const period = describePeriod(inv);
  const amount = `${(inv.amountCzk ?? 0).toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kč`;
  const due = offerDate(inv.dueDate);
  return [
    'Dobrý den,',
    '',
    `v příloze zasíláme fakturu č. ${inv.invoiceNumber} za ubytování (${period}) na částku ${amount}, splatnou ${due}.`,
    inv.includePaymentDetails ? `Platební údaje a QR kód najdete na faktuře (variabilní symbol ${inv.invoiceNumber?.replace(/\D/g, '')}).` : '',
    '',
    'Děkujeme za spolupráci.',
    '',
    '—',
    '',
    'Hello,',
    '',
    `Please find attached invoice ${inv.invoiceNumber} for accommodation (${period}), amount ${amount}, due ${due}.`,
    inv.includePaymentDetails ? `Payment details and a QR code are on the invoice (variable symbol ${inv.invoiceNumber?.replace(/\D/g, '')}).` : '',
    '',
    'Thank you for your business.',
    '',
    'Patrik & Zuzana',
    'Baker House Apartments',
    'https://www.bakerhouseapartments.cz',
  ]
    .filter((l, i, arr) => !(l === '' && arr[i - 1] === ''))
    .join('\n');
}

/**
 * Email an ISSUED invoice to the company's invoice address (or `to`). Records
 * sent/deferred on the invoice; a genuine failure is saved as `error` and
 * rethrown. A paid invoice can be re-sent (copy) without changing its status.
 */
export async function sendInvoice(
  invoiceId: string,
  opts: { to?: string | null } = {},
): Promise<{ invoice: CorporateInvoice; outcome: 'sent' | 'deferred'; deferral?: string }> {
  const inv = await getInvoice(invoiceId);
  if (!inv) throw new InvoiceError('Invoice not found', 404);
  if (!inv.invoiceNumber || !inv.billTo || inv.status === 'scheduled') throw new InvoiceError('Issue the invoice before sending it');
  if (inv.status === 'void') throw new InvoiceError('This invoice is void');
  const to = (opts.to ?? inv.billTo.billingEmail).trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new InvoiceError('No valid invoice email to send to');

  try {
    const pdf = await renderInvoicePdf(inv);
    const result = await sendMailWithRetry({
      to,
      messageId: `<${inv.invoiceNumber}-${Date.now()}@bakerhouseapartments.cz>`,
      subject: `Faktura / Invoice ${inv.invoiceNumber} – Baker House Apartments`,
      text: emailText(inv),
      attachments: [{ filename: invoiceFilename(inv), content: pdf, contentType: 'application/pdf' }],
      label: inv.invoiceNumber,
    });
    const updated = await updateInvoice(inv.id, {
      status: inv.status === 'paid' ? 'paid' : 'sent',
      sentAt: new Date(),
      sentTo: to,
      sendCount: inv.sendCount + 1,
      error: result.outcome === 'deferred' ? `Mail server deferred the acknowledgement (likely delivered): ${result.deferral ?? ''}`.slice(0, 500) : null,
    });
    return { invoice: updated ?? inv, outcome: result.outcome, deferral: result.deferral };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await updateInvoice(inv.id, { error: `Send failed: ${reason}`.slice(0, 500) }).catch(() => {});
    throw new InvoiceError(`Send failed: ${reason}`, 502);
  }
}

// ─── Cron step (called from /api/cron/send-due-invoices) ────────────────────

export interface CorporateCronResult {
  due: number;
  sent: number;
  deferred: number;
  held: number;
  failed: number;
  details: string[];
}

/**
 * Issue + email every scheduled invoice whose issue date has come. Never
 * throws: the guest-invoice cron it piggybacks on must not be affected. One
 * Telegram summary when anything happened.
 */
export async function sendDueCorporateInvoices(today: string): Promise<CorporateCronResult> {
  const result: CorporateCronResult = { due: 0, sent: 0, deferred: 0, held: 0, failed: 0, details: [] };
  let due: CorporateInvoice[];
  try {
    due = await listDueScheduledInvoices(today);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    result.failed += 1;
    result.details.push(`could not list scheduled invoices: ${reason}`);
    await sendTechnicalAlert(`⚠️ Corporate invoices: could not read the schedule — ${escapeHtml(reason)}`).catch(() => {});
    return result;
  }
  result.due = due.length;
  if (due.length === 0) return result;

  const reservations = await loadReservationsByNumber();
  const lines: string[] = [];
  for (const inv of due) {
    const what = `${inv.billedMonth ? monthLabel(inv.billedMonth) : `${inv.periodFrom} → ${inv.periodTo}`} · ${inv.agreementId}`;
    try {
      const issued = await issueInvoice(inv.id, { today, reservations, requireVerified: true, requireBooked: true });
      const sent = await sendInvoice(issued.invoice.id);
      if (sent.outcome === 'deferred') result.deferred += 1;
      result.sent += 1;
      const company = issued.invoice.billTo?.companyName ?? '';
      lines.push(
        `✅ <b>${escapeHtml(issued.invoice.invoiceNumber ?? '')}</b> ${escapeHtml(company)} — ${escapeHtml(what)} · ${(issued.invoice.amountCzk ?? 0).toLocaleString('cs-CZ')} Kč, due ${formatStayDate(issued.invoice.dueDate)} → ${escapeHtml(sent.invoice.sentTo ?? '')}` +
          (issued.preview.notes.length > 0 ? `\n   ${issued.preview.notes.map(escapeHtml).join('\n   ')}` : '') +
          (issued.revenueError ? `\n   ⚠️ revenue record failed: ${escapeHtml(issued.revenueError)}` : ''),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const current = await getInvoice(inv.id).catch(() => null);
      // Numbered but not emailed → it's 'issued' now; the operator sends it from the panel.
      if (current?.invoiceNumber) {
        result.failed += 1;
        lines.push(`⚠️ <b>${escapeHtml(current.invoiceNumber)}</b> issued but NOT sent — ${escapeHtml(what)}: ${escapeHtml(reason)}`);
      } else {
        result.held += 1;
        // Remember why, once — the row shows it and the next run retries.
        if (current && current.error !== reason) await updateInvoice(inv.id, { error: reason.slice(0, 500) }).catch(() => {});
        if (!current || current.error !== reason) lines.push(`⏸ Held — ${escapeHtml(what)}: ${escapeHtml(reason)}`);
      }
      result.details.push(`${inv.id}: ${reason}`);
    }
  }

  if (lines.length > 0) {
    const msg = `🧾 <b>Corporate invoices</b> (${today})\n${lines.join('\n')}`;
    const ok = await sendTelegram(msg, { chatId: invoiceAlertChatId() }).catch(() => false);
    if (!ok) await sendTechnicalAlert(msg).catch(() => {});
  }
  return result;
}
