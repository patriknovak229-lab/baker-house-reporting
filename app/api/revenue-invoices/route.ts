import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const invoices = await readAllRevenueInvoices();

  // Return sorted newest first
  invoices.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

  return NextResponse.json(invoices);
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const body = await request.json() as Partial<RevenueInvoice>;

  if (!body.invoiceNumber || body.amountCZK == null || !body.invoiceDate) {
    return NextResponse.json({ error: 'Missing required fields: invoiceNumber, amountCZK, invoiceDate' }, { status: 400 });
  }

  const invoices = await readAllRevenueInvoices();

  const now = new Date().toISOString();
  const id = body.id ?? crypto.randomUUID();

  // Upsert: if invoice with same id already exists, replace it
  const existing = invoices.findIndex((i) => i.id === id);

  const invoice: RevenueInvoice = {
    id,
    sourceType:    body.sourceType    ?? 'manual',
    category:      body.category      ?? (body.sourceType === 'issued' ? 'accommodation_direct' : 'other_services'),
    status:        body.status        ?? 'pending',
    invoiceNumber: body.invoiceNumber,
    invoiceDate:   body.invoiceDate,
    amountCZK:     body.amountCZK,
    reservationNumber: body.reservationNumber,
    guestName:         body.guestName,
    clientName:        body.clientName,
    description:       body.description,
    bankTransactionId: body.bankTransactionId,
    reconciledAt:      body.reconciledAt,
    createdAt: existing >= 0 ? invoices[existing].createdAt : now,
  };

  if (existing >= 0) {
    invoices[existing] = invoice;
  } else {
    invoices.push(invoice);
  }

  await writeAllRevenueInvoices(invoices);

  return NextResponse.json(invoice, { status: existing >= 0 ? 200 : 201 });
}
