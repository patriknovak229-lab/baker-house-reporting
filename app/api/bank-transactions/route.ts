import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction } from '@/types/bankTransaction';

const KEY = 'baker:bank-transactions';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const raw = await redis.get(KEY);
  const transactions = (Array.isArray(raw) ? raw : []) as BankTransaction[];
  transactions.sort((a, b) => b.date.localeCompare(a.date));
  return NextResponse.json(transactions);
}
