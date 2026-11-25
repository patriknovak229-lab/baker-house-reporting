/**
 * POST /api/corporate/invoices/action — everything done to one invoice.
 *
 * Body: { id, action, ... }
 *   issue       scheduled → issued today (number, frozen lines, revenue record); not emailed
 *   send        scheduled → issued + emailed now; issued/sent/paid → (re)send.  { to? }
 *   reschedule  scheduled only: { issueDate, dueDate }
 *   cancel      scheduled only — removed, it never existed as a document
 *   void        issued/sent → void; the number stays used, revenue record → "mistake"
 *   markPaid    { paidAt? (default today) }
 *   unmarkPaid  paid → sent (or issued if it was never emailed)
 *   snooze      hide the Transactions payment check for { days } (1–30)
 *
 * In CHROMIUM_ROUTES (next.config.ts): "send" renders the PDF.
 * Auth: corporate change.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { deleteScheduledInvoice, getInvoice, updateInvoice } from '@/data-access/corporateInvoices';
import { InvoiceError, issueInvoice, voidInvoice } from '@/utils/corporateInvoiceService';
import { sendInvoice } from '@/utils/corporateInvoiceSend';
import { addDays, isYmd } from '@/utils/corporateSchedule';
import { optNum, optStr } from '@/utils/corporateInput';
import { pragueToday } from '@/utils/periodUtils';

export const maxDuration = 60;

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
  const id = optStr(body.id, 40);
  if (!id) return bad('id is required');
  const inv = await getInvoice(id);
  if (!inv) return bad('Invoice not found', 404);
  const today = pragueToday();

  try {
    switch (body.action) {
      case 'issue': {
        const issued = await issueInvoice(id, { today });
        return NextResponse.json({ invoice: issued.invoice, notes: issued.preview.notes, revenueError: issued.revenueError });
      }
      case 'send': {
        let notes: string[] = [];
        let revenueError: string | null = null;
        if (inv.status === 'scheduled') {
          const issued = await issueInvoice(id, { today });
          notes = issued.preview.notes;
          revenueError = issued.revenueError;
        }
        const sent = await sendInvoice(id, { to: optStr(body.to, 200) });
        return NextResponse.json({ invoice: sent.invoice, outcome: sent.outcome, notes, revenueError });
      }
      case 'reschedule': {
        if (inv.status !== 'scheduled') return bad('Only a scheduled invoice can be rescheduled — the dates of an issued one are printed on it');
        const { issueDate, dueDate } = body;
        if (!isYmd(issueDate) || !isYmd(dueDate)) return bad('issueDate and dueDate must be YYYY-MM-DD');
        if (issueDate < today) return bad('The issue date cannot be in the past');
        if (dueDate < issueDate) return bad('The due date cannot be before the issue date');
        const invoice = await updateInvoice(id, { issueDate, dueDate, error: null });
        return NextResponse.json({ invoice });
      }
      case 'cancel': {
        if (inv.status !== 'scheduled' || inv.invoiceNumber) return bad('Only a scheduled invoice can be cancelled — void an issued one');
        await deleteScheduledInvoice(id);
        return NextResponse.json({ deleted: true });
      }
      case 'void': {
        if (inv.status === 'scheduled') return bad('Cancel a scheduled invoice instead');
        const invoice = await voidInvoice(id);
        return NextResponse.json({ invoice });
      }
      case 'markPaid': {
        if (inv.status !== 'issued' && inv.status !== 'sent') return bad(`A ${inv.status} invoice can't be marked paid`);
        const paidAt = isYmd(body.paidAt) && body.paidAt <= today ? body.paidAt : today;
        const invoice = await updateInvoice(id, { status: 'paid', paidAt, paidSource: 'manual' });
        return NextResponse.json({ invoice });
      }
      case 'unmarkPaid': {
        if (inv.status !== 'paid') return bad('The invoice is not marked paid');
        const invoice = await updateInvoice(id, { status: inv.sentAt ? 'sent' : 'issued', paidAt: null, paidSource: null });
        return NextResponse.json({ invoice });
      }
      case 'snooze': {
        const days = Math.round(optNum(body.days) ?? 3);
        if (days < 1 || days > 30) return bad('days must be 1–30');
        const invoice = await updateInvoice(id, { paymentCheckSnoozedUntil: addDays(today, days) });
        return NextResponse.json({ invoice });
      }
      default:
        return bad('Unknown action');
    }
  } catch (err) {
    if (err instanceof InvoiceError) return bad(err.message, err.status);
    console.error('[corporate-invoice] action failed:', err);
    return bad(err instanceof Error ? err.message : 'Action failed', 500);
  }
}
