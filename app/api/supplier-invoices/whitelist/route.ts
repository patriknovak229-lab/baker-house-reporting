import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { WhitelistedSupplier } from '@/types/supplierInvoice';
import { readAllSupplierWhitelist, writeAllSupplierWhitelist } from '@/utils/supplierWhitelistStore';
import { findKnownSupplier, normalizeIco } from '@/utils/supplierRegistry';

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
  const icoNorm = normalizeIco(supplierICO);
  const known = findKnownSupplier(supplierName, supplierICO);

  // Already whitelisted if the name, the IČO, or the known-supplier identity matches an entry
  const existing = whitelist.find((s) =>
    s.supplierName.trim().toLowerCase() === nameNorm ||
    (!!icoNorm && normalizeIco(s.supplierICO) === icoNorm) ||
    (!!known && findKnownSupplier(s.supplierName, s.supplierICO)?.id === known.id),
  );
  if (existing) {
    // Fill in a missing IČO so future invoices match even when the name is read differently
    if (!existing.supplierICO && icoNorm) {
      const updated = { ...existing, supplierICO: icoNorm };
      await writeAllSupplierWhitelist(whitelist.map((s) => (s.id === existing.id ? updated : s)));
      return NextResponse.json({ ...updated, alreadyListed: true });
    }
    return NextResponse.json({ ...existing, alreadyListed: true });
  }

  const entry: WhitelistedSupplier = {
    id: crypto.randomUUID(),
    supplierName: supplierName.trim(),
    supplierICO: icoNorm || undefined,
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
