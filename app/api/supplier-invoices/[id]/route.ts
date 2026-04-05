import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const updates = await request.json() as Partial<SupplierInvoice>;

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  const idx = invoices.findIndex((inv) => inv.id === id);
  if (idx === -1) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  invoices[idx] = { ...invoices[idx], ...updates, id };
  await redis.set(KEY, invoices);

  return NextResponse.json(invoices[idx]);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;

  const raw = await redis.get(KEY);
  const invoices = (Array.isArray(raw) ? raw : []) as SupplierInvoice[];

  const filtered = invoices.filter((inv) => inv.id !== id);
  if (filtered.length === invoices.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  await redis.set(KEY, filtered);
  return NextResponse.json({ ok: true });
}
