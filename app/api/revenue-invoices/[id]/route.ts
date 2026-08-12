import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { RevenueInvoiceCategory } from '@/types/revenueInvoice';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';

type ActionBody =
  | { action: 'update_category'; category: RevenueInvoiceCategory }
  | { action: 'link_bank'; bankTransactionId: string }
  | { action: 'unlink' };

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  const body = await request.json() as ActionBody;

  const [invoices, transactions] = await Promise.all([readAllRevenueInvoices(), readAllBankTransactions()]);

  const invIdx = invoices.findIndex((i) => i.id === id);
  if (invIdx === -1) return NextResponse.json({ error: 'Revenue invoice not found' }, { status: 404 });

  const now = new Date().toISOString();
  const inv = invoices[invIdx];

  if (body.action === 'update_category') {
    invoices[invIdx] = { ...inv, category: body.category };
    await writeAllRevenueInvoices(invoices);
    return NextResponse.json(invoices[invIdx]);
  }

  if (body.action === 'link_bank') {
    const txIdx = transactions.findIndex((t) => t.id === body.bankTransactionId);
    if (txIdx === -1) return NextResponse.json({ error: 'Bank transaction not found' }, { status: 404 });

    // Clear old link if invoice was previously linked to a different tx
    if (inv.bankTransactionId && inv.bankTransactionId !== body.bankTransactionId) {
      const oldTxIdx = transactions.findIndex((t) => t.id === inv.bankTransactionId);
      if (oldTxIdx !== -1) {
        transactions[oldTxIdx] = { ...transactions[oldTxIdx], revenueInvoiceId: undefined, state: 'revenue', reconciledAt: undefined };
      }
    }

    invoices[invIdx] = {
      ...inv,
      status: 'reconciled',
      bankTransactionId: body.bankTransactionId,
      reconciledAt: now,
    };

    transactions[txIdx] = {
      ...transactions[txIdx],
      revenueInvoiceId: id,
      state: 'reconciled',
      reconciledAt: now,
    };

    await Promise.all([writeAllRevenueInvoices(invoices), writeAllBankTransactions(transactions)]);
    return NextResponse.json({ invoice: invoices[invIdx], transaction: transactions[txIdx] });
  }

  if (body.action === 'unlink') {
    // Clear link on bank transaction
    if (inv.bankTransactionId) {
      const txIdx = transactions.findIndex((t) => t.id === inv.bankTransactionId);
      if (txIdx !== -1) {
        transactions[txIdx] = { ...transactions[txIdx], revenueInvoiceId: undefined, state: 'revenue', reconciledAt: undefined };
      }
    }

    invoices[invIdx] = {
      ...inv,
      status: 'pending',
      bankTransactionId: undefined,
      reconciledAt: undefined,
    };

    await Promise.all([writeAllRevenueInvoices(invoices), writeAllBankTransactions(transactions)]);
    return NextResponse.json({ invoice: invoices[invIdx] });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
