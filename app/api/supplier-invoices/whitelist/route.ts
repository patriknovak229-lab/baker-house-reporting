import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { WhitelistedSupplier } from '@/types/supplierInvoice';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const REDIS_KEY = 'baker:supplier-whitelist';

async function getWhitelist(): Promise<WhitelistedSupplier[]> {
  return (await redis.get<WhitelistedSupplier[]>(REDIS_KEY)) ?? [];
}

// GET — list all whitelisted suppliers (admin + accountant)
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;
  return NextResponse.json(await getWhitelist());
}

// POST — add a supplier to the whitelist (admin only)
export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { supplierName, category } = await request.json() as {
    supplierName?: string;
    category?: string;
  };

  if (!supplierName?.trim()) {
    return NextResponse.json({ error: 'supplierName is required' }, { status: 400 });
  }

  const whitelist = await getWhitelist();
  const nameNorm = supplierName.trim().toLowerCase();

  if (whitelist.some((s) => s.supplierName.toLowerCase() === nameNorm)) {
    return NextResponse.json({ error: 'Supplier already whitelisted' }, { status: 409 });
  }

  const entry: WhitelistedSupplier = {
    id: crypto.randomUUID(),
    supplierName: supplierName.trim(),
    category: category ?? 'other',
    addedAt: new Date().toISOString(),
  };

  await redis.set(REDIS_KEY, [...whitelist, entry]);
  return NextResponse.json(entry, { status: 201 });
}

// DELETE — remove a supplier by id (admin only)
export async function DELETE(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const { id } = await request.json() as { id?: string };
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });

  const whitelist = await getWhitelist();
  await redis.set(REDIS_KEY, whitelist.filter((s) => s.id !== id));
  return NextResponse.json({ ok: true });
}
