import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { RevenueInvoice } from '@/types/revenueInvoice';

const KEY            = 'baker:additional-payments';
const INVOICES_KEY   = 'baker:revenue-invoices';

function getRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

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

  const redis = getRedis();
  const payments = await redis.get<AdditionalPayment[]>(KEY) ?? [];
  const idx = payments.findIndex((p) => p.id === id);

  if (idx === -1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  payments[idx] = {
    ...payments[idx],
    status,
    paidAt: status === 'paid' ? (payments[idx].paidAt ?? new Date().toISOString()) : undefined,
  };

  await redis.set(KEY, payments);
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

  const redis = getRedis();
  const payments = await redis.get<AdditionalPayment[]>(KEY) ?? [];
  const filtered = payments.filter((p) => p.id !== id);

  if (filtered.length === payments.length) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Remove the corresponding auto-created revenue invoice (id: pay-{sessionId})
  const invoiceId = `pay-${id}`;
  const invoices = await redis.get<RevenueInvoice[]>(INVOICES_KEY) ?? [];
  const filteredInvoices = invoices.filter((inv) => inv.id !== invoiceId);

  await Promise.all([
    redis.set(KEY, filtered),
    filteredInvoices.length !== invoices.length
      ? redis.set(INVOICES_KEY, filteredInvoices)
      : Promise.resolve(),
  ]);

  return NextResponse.json({ ok: true });
}
