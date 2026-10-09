import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { findDuplicateInvoice, normalizeInvoiceAmounts } from '@/utils/invoiceChecks';

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const invoices = await readAllSupplierInvoices();

  // Return sorted newest first
  invoices.sort((a, b) => b.invoiceDate.localeCompare(a.invoiceDate));

  return NextResponse.json(invoices);
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const body = await request.json() as SupplierInvoice & { force?: boolean };
  if (!body.id || !body.supplierName || !body.invoiceNumber) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const invoices = await readAllSupplierInvoices();

  // Duplicate check (skipped when force === true or when updating an existing invoice by same id).
  // Same supplier (name or IČO) AND same number — or same date + amount, which catches a receipt
  // re-imported under a different / placeholder number.
  if (!body.force) {
    const dup = findDuplicateInvoice(body, invoices);
    if (dup) return NextResponse.json({ code: 'duplicate', existing: dup }, { status: 409 });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { force: _force, ...rest } = body;
  const invoiceBody = normalizeInvoiceAmounts(rest as SupplierInvoice);
  invoices.push(invoiceBody);
  await writeAllSupplierInvoices(invoices);

  return NextResponse.json(invoiceBody, { status: 201 });
}
