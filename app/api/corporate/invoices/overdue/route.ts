/**
 * GET /api/corporate/invoices/overdue — corporate invoices whose due date has
 * passed (from the day after) and that are still unpaid, for the "check
 * invoice payment" pill on Transactions. Snoozed ones are left out until their
 * snooze ends.
 *
 * Paid state is synced from Accounting's bank match first, so an invoice the
 * company paid and the bank import matched drops off without anyone clicking.
 *
 * → { invoices: [{ ...CorporateInvoice, companyName, daysPastDue }] }
 * Auth: corporate view — the pill simply doesn't show for anyone else.
 */
import { NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { listInvoicesByStatus } from '@/data-access/corporateInvoices';
import { listAgreements } from '@/data-access/corporate';
import { daysPastDue, needsPaymentCheck } from '@/utils/corporateInvoice';
import { syncPaidFromBank } from '@/utils/corporateInvoiceService';
import { pragueToday } from '@/utils/periodUtils';

export async function GET() {
  const guard = await requireAccess('corporate', 'view');
  if ('error' in guard) return guard.error;
  const today = pragueToday();
  const candidates = (await listInvoicesByStatus(['issued', 'sent'])).filter((i) => needsPaymentCheck(i, today));
  if (candidates.length === 0) return NextResponse.json({ invoices: [] });

  const synced = (await syncPaidFromBank(candidates)).filter((i) => needsPaymentCheck(i, today));
  const companies = new Map((await listAgreements()).map((a) => [a.id, a.companyName]));
  const invoices = synced.map((i) => ({
    ...i,
    companyName: i.billTo?.companyName ?? companies.get(i.agreementId) ?? i.agreementId,
    daysPastDue: daysPastDue(i.dueDate, today),
  }));
  return NextResponse.json({ invoices });
}
