import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';
import { findAutoMatches, learnCounterparties } from '@/utils/bankInvoiceMatch';

/**
 * "Auto-match" button: pair every unmatched debit with a pending invoice where
 * utils/bankInvoiceMatch is confident (see its header for the rules). Each link
 * records autoMatchReason so it can be reviewed / undone in the drawer.
 */
export async function POST() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const [transactions, invoices] = await Promise.all([readAllBankTransactions(), readAllSupplierInvoices()]);

  const matches = findAutoMatches(transactions, invoices, learnCounterparties(transactions, invoices));
  if (matches.length === 0) return NextResponse.json({ matched: 0, transactions });

  const now = new Date().toISOString();
  const txIdx  = new Map(transactions.map((t, i) => [t.id, i]));
  const invIdx = new Map(invoices.map((inv, i) => [inv.id, i]));

  for (const { tx, invoice, reason } of matches) {
    const ti = txIdx.get(tx.id)!;
    const ii = invIdx.get(invoice.id)!;
    transactions[ti] = {
      ...transactions[ti], state: 'reconciled', invoiceId: invoice.id, invoiceIds: [invoice.id],
      reconciledAt: now, autoMatchReason: reason,
    };
    invoices[ii] = { ...invoices[ii], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
  }

  await Promise.all([writeAllBankTransactions(transactions), writeAllSupplierInvoices(invoices)]);

  return NextResponse.json({ matched: matches.length, transactions });
}
