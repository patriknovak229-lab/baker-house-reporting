import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { Voucher } from '@/types/voucher';

const KEY = 'baker:vouchers';

function getRedis(): Redis {
  return new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

// DELETE /api/vouchers/[id] — soft-delete (set status to 'deleted')
// Cannot delete a used voucher.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  const redis = getRedis();
  const vouchers = await redis.get<Voucher[]>(KEY) ?? [];
  const idx = vouchers.findIndex((v) => v.id === id);

  if (idx === -1) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (vouchers[idx].status === 'used') {
    return NextResponse.json({ error: 'Cannot delete a used voucher' }, { status: 400 });
  }

  vouchers[idx] = { ...vouchers[idx], status: 'deleted' };
  await redis.set(KEY, vouchers);
  return NextResponse.json({ ok: true });
}
