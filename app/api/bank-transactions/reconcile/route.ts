import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import { readAllSettlementGroups, writeAllSettlementGroups } from '@/utils/settlementGroupsStore';
import { findAutoMatches, learnCounterparties } from '@/utils/bankInvoiceMatch';
import { findCreditNoteRefunds, findIssuedInvoiceMatches, findSettlementPayouts } from '@/utils/bankCreditMatch';
import { applyStripeSettlement, isOpenStripeCredit } from '@/utils/stripeSettlement';
import { loadWebBookings, planStripeCredit, stripeClient } from '@/utils/stripePayouts';

export const maxDuration = 60;

/**
 * "Auto-match" button — four lanes, each only where the match is unambiguous
 * (rules in utils/bankInvoiceMatch + utils/bankCreditMatch):
 *   1. outgoing payments → supplier invoices
 *   2. OTA payouts → settlement reports (exact net)
 *   3. incoming payments → issued invoices (invoice no. on the payment)
 *   4. refunds → supplier credit notes (one refund per credit note)
 *   5. Stripe payouts → Stripe settlements, built from the Stripe API — only when
 *      the payout's contents tie to the bank exactly and nothing needs review;
 *      otherwise left for the drawer's "Stripe payout" preview. Only unlinked
 *      Stripe credits — payouts already tagged by hand (closed months) stay as they are
 * Every link records autoMatchReason so it can be reviewed / undone.
 */
export async function POST() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const [transactions, invoices, revenueInvoices, groups] = await Promise.all([
    readAllBankTransactions(), readAllSupplierInvoices(), readAllRevenueInvoices(), readAllSettlementGroups(),
  ]);

  const now = new Date().toISOString();
  const txIdx = new Map(transactions.map((t, i) => [t.id, i]));
  const patchTx = (id: string, patch: Partial<(typeof transactions)[number]>) => {
    const i = txIdx.get(id)!;
    transactions[i] = { ...transactions[i], ...patch };
  };

  // 1. Supplier invoices
  const memory = learnCounterparties(transactions, invoices);
  const invoiceMatches = findAutoMatches(transactions, invoices, memory);
  const invIdx = new Map(invoices.map((inv, i) => [inv.id, i]));
  for (const { tx, invoice, reason } of invoiceMatches) {
    patchTx(tx.id, { state: 'reconciled', invoiceId: invoice.id, invoiceIds: [invoice.id], reconciledAt: now, autoMatchReason: reason });
    const ii = invIdx.get(invoice.id)!;
    invoices[ii] = { ...invoices[ii], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
  }

  // 5. Stripe payouts → Stripe settlements (before the other credit lanes claim anything)
  let stripeBooked = 0;
  let stripeToReview = 0;
  const openStripe = transactions.filter(isOpenStripeCredit);
  const stripe = openStripe.length > 0 ? stripeClient() : null;
  if (stripe) {
    const bookings = await loadWebBookings();
    for (const tx of openStripe) {
      try {
        const plan = await planStripeCredit(stripe, tx, revenueInvoices, bookings);
        if (!plan.ties || plan.issues.length > 0) { stripeToReview++; continue; }
        applyStripeSettlement(plan, { transactions, revenueInvoices, supplierInvoices: invoices, groups }, crypto.randomUUID(), now);
        stripeBooked++;
      } catch {
        stripeToReview++;
      }
    }
  }
  txIdx.clear();
  transactions.forEach((t, i) => txIdx.set(t.id, i));

  // 2. OTA payouts → settlements (same effect as the drawer's "add payout")
  const payoutMatches = findSettlementPayouts(transactions, groups);
  const grpIdx = new Map(groups.map((g, i) => [g.id, i]));
  for (const { group, payouts, reason } of payoutMatches) {
    const gi = grpIdx.get(group.id)!;
    groups[gi] = { ...groups[gi], transactionIds: [...groups[gi].transactionIds, ...payouts.map((p) => p.id)] };
    for (const p of payouts) patchTx(p.id, { state: 'grouped', settlementGroupId: group.id, autoMatchReason: reason });
  }

  // 3. Incoming payments → issued invoices (same effect as the revenue drawer's "link bank")
  const issuedMatches = findIssuedInvoiceMatches(transactions, revenueInvoices);
  const revIdx = new Map(revenueInvoices.map((r, i) => [r.id, i]));
  for (const { tx, invoice, reason } of issuedMatches) {
    patchTx(tx.id, { state: 'reconciled', revenueInvoiceId: invoice.id, reconciledAt: now, autoMatchReason: reason });
    const ri = revIdx.get(invoice.id)!;
    revenueInvoices[ri] = { ...revenueInvoices[ri], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
  }

  // 4. Refunds → credit notes (same effect as the drawer's "Credit note" tab)
  const refundMatches = findCreditNoteRefunds(transactions, invoices, memory);
  for (const { tx, creditNote, reason } of refundMatches) {
    patchTx(tx.id, { state: 'reconciled', invoiceId: creditNote.id, invoiceIds: [creditNote.id], reconciledAt: now, autoMatchReason: reason });
    const ii = invIdx.get(creditNote.id)!;
    invoices[ii] = { ...invoices[ii], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
  }

  const payoutsLinked = payoutMatches.reduce((s, m) => s + m.payouts.length, 0);
  if (invoiceMatches.length + payoutsLinked + issuedMatches.length + refundMatches.length + stripeBooked > 0) {
    await Promise.all([
      writeAllBankTransactions(transactions),
      invoiceMatches.length + refundMatches.length + stripeBooked > 0 ? writeAllSupplierInvoices(invoices) : null,
      payoutMatches.length + stripeBooked > 0 ? writeAllSettlementGroups(groups) : null,
      issuedMatches.length + stripeBooked > 0 ? writeAllRevenueInvoices(revenueInvoices) : null,
    ]);
  }

  return NextResponse.json({
    matched: invoiceMatches.length,
    payouts: payoutsLinked,
    settlements: payoutMatches.length,
    issued: issuedMatches.length,
    refunds: refundMatches.length,
    stripe: stripeBooked,
    stripeToReview,
    /** Every link made, across all lanes — the banner trusts this, so a page loaded
     *  before a new lane shipped never reports "no matches" when there were some */
    total: invoiceMatches.length + payoutsLinked + issuedMatches.length + refundMatches.length + stripeBooked,
    transactions,
  });
}
