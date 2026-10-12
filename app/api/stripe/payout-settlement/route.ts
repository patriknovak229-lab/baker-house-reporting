import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllSettlementGroups, writeAllSettlementGroups } from '@/utils/settlementGroupsStore';
import { applyStripeSettlement, isOpenStripeCredit } from '@/utils/stripeSettlement';
import { loadWebBookings, planStripeCredit, stripeClient } from '@/utils/stripePayouts';

export const maxDuration = 60;

/**
 * POST { transactionId, dryRun? } — book a Stripe payout (bank credit) as a
 * settlement of the web bookings it contains (see utils/stripeSettlement).
 * dryRun returns the plan without writing — the drawer shows it for review.
 * Booking requires the payout's contents to tie to the bank credit exactly.
 */
export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { transactionId, dryRun } = await request.json() as { transactionId?: string; dryRun?: boolean };
  if (!transactionId) return NextResponse.json({ error: 'transactionId is required' }, { status: 400 });

  const stripe = stripeClient();
  if (!stripe) return NextResponse.json({ error: 'Stripe is not configured on this server' }, { status: 503 });

  const [transactions, revenueInvoices, supplierInvoices, groups, bookings] = await Promise.all([
    readAllBankTransactions(), readAllRevenueInvoices(), readAllSupplierInvoices(), readAllSettlementGroups(), loadWebBookings(),
  ]);
  const tx = transactions.find((t) => t.id === transactionId);
  if (!tx) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });
  if (!isOpenStripeCredit(tx)) return NextResponse.json({ error: 'Not an open Stripe payout' }, { status: 409 });

  let plan;
  try {
    plan = await planStripeCredit(stripe, tx, revenueInvoices, bookings);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Stripe lookup failed' }, { status: 502 });
  }
  if (dryRun) return NextResponse.json({ plan });
  if (!plan.ties) return NextResponse.json({ error: plan.issues[0], plan }, { status: 409 });

  const data = { transactions, revenueInvoices, supplierInvoices, groups };
  let records;
  try {
    records = applyStripeSettlement(plan, data, crypto.randomUUID(), new Date().toISOString());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not book' }, { status: 409 });
  }
  await Promise.all([
    writeAllBankTransactions(data.transactions),
    writeAllRevenueInvoices(data.revenueInvoices),
    writeAllSupplierInvoices(data.supplierInvoices),
    writeAllSettlementGroups(data.groups),
  ]);
  return NextResponse.json({
    plan,
    group: records.group,
    transaction: data.transactions.find((t) => t.id === transactionId),
  });
}
