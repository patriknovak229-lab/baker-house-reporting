/**
 * Corporate invoices of one agreement.
 *
 *   GET  ?agreementId=CA-…  → { invoices } (paid state synced from Accounting's
 *                             bank match first).
 *   POST                    → create. Two shapes:
 *
 *     Monthly schedule — one scheduled invoice per month, issued + emailed by
 *     the 09:00 cron on its issue date:
 *       { agreementId, mode: 'monthly', includePaymentDetails?, dueRule?,
 *         months: [{ month: 'YYYY-MM', issueDate, dueDate }] }
 *
 *     Ad hoc — one invoice over any range of nights (periodTo = last night):
 *       { agreementId, mode: 'adhoc', periodFrom, periodTo, dueDate, dueRule?,
 *         includePaymentDetails?, delivery: 'send' | 'issue' | 'schedule',
 *         issueDate? (schedule only) }
 *       send     → issued today and emailed to the invoice address now
 *       issue    → issued today (number + PDF), emailed later from the panel
 *       schedule → issued + emailed by the cron on `issueDate`
 *
 * Every new invoice must not overlap the nights of an existing non-void one —
 * the same night is never billed twice.
 *
 * In CHROMIUM_ROUTES (next.config.ts): "send" renders the PDF.
 * Auth: corporate view (GET) / change (POST).
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { getAgreementDetail } from '@/data-access/corporate';
import {
  deleteScheduledInvoice,
  insertInvoices,
  listInvoicesForAgreement,
  newInvoiceId,
} from '@/data-access/corporateInvoices';
import type { CorporateInvoiceInsert } from '@/lib/db/schema/corporate';
import {
  firstDayOfMonth,
  isValidRange,
  isYm,
  lastDayOfMonth,
  missingBillingDetails,
  overlappingInvoice,
  parseDueRule,
} from '@/utils/corporateInvoice';
import { InvoiceError, issueInvoice, syncPaidFromBank } from '@/utils/corporateInvoiceService';
import { sendInvoice } from '@/utils/corporateInvoiceSend';
import { isYmd } from '@/utils/corporateSchedule';
import { optStr } from '@/utils/corporateInput';
import { formatStayDate } from '@/utils/corporateShared';
import { pragueToday } from '@/utils/periodUtils';

export const maxDuration = 60;

const MAX_MONTHS = 24;

export async function GET(req: NextRequest) {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;
  const agreementId = req.nextUrl.searchParams.get('agreementId');
  if (!agreementId) return NextResponse.json({ error: 'agreementId is required' }, { status: 400 });
  const invoices = await syncPaidFromBank(await listInvoicesForAgreement(agreementId));
  return NextResponse.json({ invoices });
}

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: NextRequest) {
  const guard = await requireAccess('corporate', 'change');
  if ('error' in guard) return guard.error;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return bad('Invalid JSON body');
  }
  const agreementId = optStr(body.agreementId, 40);
  if (!agreementId) return bad('agreementId is required');
  const agreement = await getAgreementDetail(agreementId);
  if (!agreement) return bad('Agreement not found', 404);
  const missing = missingBillingDetails(agreement);
  if (missing.length > 0) return bad(`Fill in the billing details first: ${missing.join(', ')}`);

  const today = pragueToday();
  const includePaymentDetails = body.includePaymentDetails !== false;
  const dueRule = parseDueRule(body.dueRule);
  const existing = await listInvoicesForAgreement(agreementId);
  const base = { agreementId, includePaymentDetails, dueRule, createdBy: guard.email };

  // ── Monthly schedule ──
  if (body.mode === 'monthly') {
    if (!Array.isArray(body.months) || body.months.length === 0) return bad('Pick at least one month');
    if (body.months.length > MAX_MONTHS) return bad(`At most ${MAX_MONTHS} months at once`);
    const rows: CorporateInvoiceInsert[] = [];
    for (const raw of body.months) {
      const m = (raw ?? {}) as Record<string, unknown>;
      const month = m.month;
      if (!isYm(month)) return bad('Each month must be YYYY-MM');
      const issueDate = m.issueDate;
      const dueDate = m.dueDate;
      if (!isYmd(issueDate) || !isYmd(dueDate)) return bad(`${month}: issue and due dates must be YYYY-MM-DD`);
      if (issueDate < today) return bad(`${month}: the issue date is in the past — use today or later`);
      if (dueDate < issueDate) return bad(`${month}: due ${formatStayDate(dueDate)} is before the invoice is issued (${formatStayDate(issueDate)})`);
      const periodFrom = firstDayOfMonth(month);
      const periodTo = lastDayOfMonth(month);
      const clash = overlappingInvoice([...existing, ...rows.map((r) => ({ status: 'scheduled' as const, periodFrom: r.periodFrom, periodTo: r.periodTo }))], periodFrom, periodTo);
      if (clash) return bad(`${month} overlaps an invoice that already covers ${formatStayDate(clash.periodFrom)} – ${formatStayDate(clash.periodTo)}`, 409);
      rows.push({ ...base, id: newInvoiceId(Date.now() + rows.length), kind: 'monthly', status: 'scheduled', periodFrom, periodTo, billedMonth: month, issueDate, dueDate });
    }
    await insertInvoices(rows);
    const invoices = await listInvoicesForAgreement(agreementId);
    return NextResponse.json({ invoices, created: rows.length });
  }

  // ── Ad hoc ──
  if (body.mode === 'adhoc') {
    const { periodFrom, periodTo } = body;
    if (!isValidRange(periodFrom, periodTo)) return bad('Pick the first and last night (YYYY-MM-DD, first ≤ last)');
    const delivery = body.delivery;
    if (delivery !== 'send' && delivery !== 'issue' && delivery !== 'schedule') return bad('delivery must be send, issue or schedule');
    const issueDate = delivery === 'schedule' ? body.issueDate : today;
    if (!isYmd(issueDate)) return bad('Pick the date to issue it');
    if (delivery === 'schedule' && issueDate <= today) return bad('A scheduled invoice must be dated after today — use "Send now" for today');
    const dueDate = body.dueDate;
    if (!isYmd(dueDate)) return bad('Pick the due date');
    if (dueDate < issueDate) return bad(`Due ${formatStayDate(dueDate)} is before the issue date ${formatStayDate(issueDate)}`);
    const clash = overlappingInvoice(existing, periodFrom, periodTo as string);
    if (clash) return bad(`These nights overlap an invoice that already covers ${formatStayDate(clash.periodFrom)} – ${formatStayDate(clash.periodTo)}`, 409);

    const id = newInvoiceId();
    await insertInvoices([{ ...base, id, kind: 'adhoc', status: 'scheduled', periodFrom, periodTo: periodTo as string, billedMonth: null, issueDate, dueDate }]);
    if (delivery === 'schedule') {
      return NextResponse.json({ invoices: await listInvoicesForAgreement(agreementId) });
    }

    // Issue now (and send). A failure before numbering leaves nothing behind.
    let issued;
    try {
      issued = await issueInvoice(id, { today });
    } catch (err) {
      await deleteScheduledInvoice(id).catch(() => {});
      const e = err instanceof InvoiceError ? err : new InvoiceError(err instanceof Error ? err.message : String(err), 500);
      return bad(e.message, e.status);
    }
    let sendError: string | null = null;
    let outcome: 'sent' | 'deferred' | null = null;
    if (delivery === 'send') {
      try {
        outcome = (await sendInvoice(id)).outcome;
      } catch (err) {
        sendError = err instanceof Error ? err.message : String(err);
      }
    }
    return NextResponse.json({
      invoices: await listInvoicesForAgreement(agreementId),
      issued: issued.invoice.invoiceNumber,
      notes: issued.preview.notes,
      revenueError: issued.revenueError,
      outcome,
      sendError,
    });
  }

  return bad("mode must be 'monthly' or 'adhoc'");
}
