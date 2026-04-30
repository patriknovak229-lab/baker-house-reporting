/**
 * POST /api/invoice-requests/[id]
 * Body: { action: 'accept' | 'reject' }
 *
 * - accept: marks the request as accepted. The frontend is responsible for
 *   committing the parsed fields (company name, IČO/DIČ, email) onto the
 *   reservation's invoiceData and creating a "Send Invoice" issue with
 *   actionableDate=checkout — that way operator can review/edit before it
 *   commits, and we don't need to load reservations server-side here.
 * - reject: just marks rejected so the banner stops showing.
 *
 * Either way: status flips, processedAt is set.
 */

import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceRequest, InvoiceRequestStatus } from '@/types/invoiceRequest';

const KEY = 'baker:invoice-requests';

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: 'id required' }, { status: 400 });
  }

  const body = await req.json().catch(() => ({}));
  const action = body?.action as 'accept' | 'reject' | undefined;
  if (action !== 'accept' && action !== 'reject') {
    return NextResponse.json({ error: 'action must be "accept" or "reject"' }, { status: 400 });
  }

  const redis = getRedis();
  const all = (await redis.get<InvoiceRequest[]>(KEY)) ?? [];
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) {
    return NextResponse.json({ error: 'Invoice request not found' }, { status: 404 });
  }

  const newStatus: InvoiceRequestStatus = action === 'accept' ? 'accepted' : 'rejected';
  all[idx] = {
    ...all[idx],
    status: newStatus,
    processedAt: new Date().toISOString(),
  };
  await redis.set(KEY, all);

  return NextResponse.json({ ok: true, request: all[idx] });
}
