import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { WhitelistedSupplier } from '@/types/supplierInvoice';
import { readAllSupplierWhitelist, writeAllSupplierWhitelist } from '@/utils/supplierWhitelistStore';

// GET — list all whitelisted suppliers (admin + accountant)
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;
  return NextResponse.json(await readAllSupplierWhitelist());
}

// POST — add a supplier to the whitelist (admin only)
export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { supplierName, supplierICO, category } = await request.json() as {
    supplierName?: string;
    supplierICO?: string;
    category?: string;
  };

  if (!supplierName?.trim()) {
    return NextResponse.json({ error: 'supplierName is required' }, { status: 400 });
  }

  const whitelist = await readAllSupplierWhitelist();
  const nameNorm = supplierName.trim().toLowerCase();
  const icoNorm = (supplierICO ?? '').toLowerCase().replace(/\s+/g, '');

  // Already whitelisted if the name OR the IČO already matches an entry
  if (whitelist.some((s) =>
    s.supplierName.trim().toLowerCase() === nameNorm ||
    (!!icoNorm && (s.supplierICO ?? '').toLowerCase().replace(/\s+/g, '') === icoNorm)
  )) {
    return NextResponse.json({ error: 'Supplier already whitelisted' }, { status: 409 });
  }

  const entry: WhitelistedSupplier = {
    id: crypto.randomUUID(),
    supplierName: supplierName.trim(),
    supplierICO: supplierICO?.trim() || undefined,
    category: category ?? 'other',
    addedAt: new Date().toISOString(),
  };

  await writeAllSupplierWhitelist([...whitelist, entry]);
  return NextResponse.json(entry, { status: 201 });
}

// DELETE — remove a supplier by id (admin only)
export async function DELETE(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { id } = await request.json() as { id?: string };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const whitelist = await readAllSupplierWhitelist();
  await writeAllSupplierWhitelist(whitelist.filter((s) => s.id !== id));
  return NextResponse.json({ ok: true });
}
