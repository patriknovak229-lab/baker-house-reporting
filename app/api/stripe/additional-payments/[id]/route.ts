import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllAdditionalPayments, writeAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';

// PATCH /api/stripe/additional-payments/[id]  — override status
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  const { status } = await req.json() as { status: 'unpaid' | 'paid' };

  if (status !== 'unpaid' && status !== 'paid') {
    return NextResponse.json({ error: 'status must be "unpaid" or "paid"' }, { status: 400 });
  }

  const payments = await readAllAdditionalPayments();
  const idx = payments.findIndex((p) => p.id === id);

  if (idx === -1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  payments[idx] = {
    ...payments[idx],
    status,
    paidAt: status === 'paid' ? (payments[idx].paidAt ?? new Date().toISOString()) : undefined,
  };

  await writeAllAdditionalPayments(payments);
  return NextResponse.json(payments[idx]);
}

// DELETE /api/stripe/additional-payments/[id]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { id } = await params;

  const payments = await readAllAdditionalPayments();
  const filtered = payments.filter((p) => p.id !== id);

  if (filtered.length === payments.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Remove the corresponding auto-created revenue invoice (id: pay-{sessionId})
  const invoiceId = `pay-${id}`;
  const invoices = await readAllRevenueInvoices();
  const filteredInvoices = invoices.filter((inv) => inv.id !== invoiceId);

  await Promise.all([
    writeAllAdditionalPayments(filtered),
    filteredInvoices.length !== invoices.length
      ? writeAllRevenueInvoices(filteredInvoices)
      : Promise.resolve(),
  ]);

  return NextResponse.json({ ok: true });
}
