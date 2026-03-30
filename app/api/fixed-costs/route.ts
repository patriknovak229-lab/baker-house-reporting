import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';

const KEY_FIXED_COSTS_CONFIG = 'baker:fixed-costs-config';

interface FixedCostItemRaw {
  id: string;
  label: string;
  rooms: Record<string, { enabled: boolean; monthlyAmount: number }>;
}

export interface FixedCostEntry {
  label: string;
  monthlyTotal: number; // sum of all enabled room amounts
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const raw = await redis.get(KEY_FIXED_COSTS_CONFIG);
  const items = (Array.isArray(raw) ? raw : []) as FixedCostItemRaw[];

  const result: FixedCostEntry[] = items
    .map((item) => ({
      label: item.label,
      monthlyTotal: Object.values(item.rooms ?? {})
        .filter((r) => r.enabled && r.monthlyAmount > 0)
        .reduce((s, r) => s + r.monthlyAmount, 0),
    }))
    .filter((c) => c.monthlyTotal > 0);

  return NextResponse.json(result);
}
