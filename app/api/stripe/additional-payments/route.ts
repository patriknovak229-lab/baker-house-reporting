import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';

const KEY = 'baker:additional-payments';

export async function GET() {
  const guard = await requireRole(['admin', 'super', 'viewer', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = new Redis({
    url:   process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const raw = await redis.get<AdditionalPayment[]>(KEY);
  const payments = Array.isArray(raw) ? raw : [];

  return NextResponse.json(payments);
}
