import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import { readAllSettlementGroups, writeAllSettlementGroups } from '@/utils/settlementGroupsStore';
import { findAutoMatches, learnCounterparties } from '@/utils/bankInvoiceMatch';
import { findIssuedInvoiceMatches, findSettlementPayouts } from '@/utils/bankCreditMatch';

/**
 * "Auto-match" button — three lanes, each only where the match is unambiguous
 * (rules in utils/bankInvoiceMatch + utils/bankCreditMatch):
 *   1. outgoing payments → supplier invoices
 *   2. OTA payouts → settlement reports (exact net)
 *   3. incoming payments → issued invoices (invoice no. on the payment)
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
  const invoiceMatches = findAutoMatches(transactions, invoices, learnCounterparties(transactions, invoices));
  const invIdx = new Map(invoices.map((inv, i) => [inv.id, i]));
  for (const { tx, invoice, reason } of invoiceMatches) {
    patchTx(tx.id, { state: 'reconciled', invoiceId: invoice.id, invoiceIds: [invoice.id], reconciledAt: now, autoMatchReason: reason });
    const ii = invIdx.get(invoice.id)!;
    invoices[ii] = { ...invoices[ii], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
  }

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

  const payoutsLinked = payoutMatches.reduce((s, m) => s + m.payouts.length, 0);
  if (invoiceMatches.length + payoutsLinked + issuedMatches.length > 0) {
    await Promise.all([
      writeAllBankTransactions(transactions),
      invoiceMatches.length > 0 ? writeAllSupplierInvoices(invoices) : null,
      payoutMatches.length > 0 ? writeAllSettlementGroups(groups) : null,
      issuedMatches.length > 0 ? writeAllRevenueInvoices(revenueInvoices) : null,
    ]);
  }

  return NextResponse.json({
    matched: invoiceMatches.length,
    payouts: payoutsLinked,
    settlements: payoutMatches.length,
    issued: issuedMatches.length,
    transactions,
  });
}
