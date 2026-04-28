import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import {
  runFullPricingCheck,
  type PricingResult,
} from '@/utils/platformScraper';

export const maxDuration = 300; // Vercel Pro maximum — Booking + Airbnb sequential needs the headroom

const REDIS_KEY_LATEST = 'platform-prices:latest';
const REDIS_KEY_STATUS = 'platform-prices:status';
const RESULT_TTL = 60 * 60 * 36; // 36 hours

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

/**
 * POST /api/platform-prices
 * Triggers a full pricing scrape (all platforms, all date slots).
 * Accepts optional body: { checkIn, checkOut, nights } for a custom single-slot check.
 * The Vercel cron job calls this with no body (uses auto-generated date slots).
 */
export async function POST(req: NextRequest) {
  // Vercel cron requests carry x-vercel-cron header — allow without session auth
  const isCron = req.headers.get('x-vercel-cron') === '1';

  if (!isCron) {
    const authResult = await requireRole(['admin', 'super']);
    if ('error' in authResult) return authResult.error;
  }

  const redis = getRedis();

  // Parse optional custom slot from body
  let customSlots: Array<{ checkIn: string; checkOut: string; nights: 2 | 7 }> | undefined;
  try {
    const body = await req.json().catch(() => null);
    if (body?.checkIn && body?.checkOut && body?.nights) {
      customSlots = [
        { checkIn: body.checkIn, checkOut: body.checkOut, nights: Number(body.nights) as 2 | 7 },
      ];
    } else if (body?.slots && Array.isArray(body.slots)) {
      customSlots = body.slots;
    }
  } catch {
    // no body is fine — use default date slots
  }

  // Mark as running in Redis
  await redis?.set(REDIS_KEY_STATUS, 'running', { ex: 180 });

  try {
    const result: PricingResult = await runFullPricingCheck(customSlots);

    // Store results in Redis only for full scheduled runs (not custom single-slot checks)
    if (!customSlots) {
      await redis?.set(REDIS_KEY_LATEST, JSON.stringify(result), { ex: RESULT_TTL });
    }
    await redis?.set(REDIS_KEY_STATUS, 'idle', { ex: 3600 });

    return NextResponse.json(result);
  } catch (err) {
    await redis?.set(REDIS_KEY_STATUS, 'error', { ex: 3600 });
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/platform-prices
 * Returns the latest cached result from Redis, or triggers a fresh check if none exists.
 */
export async function GET(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const raw = await redis.get<string>(REDIS_KEY_LATEST);
  if (!raw) {
    return new NextResponse(null, { status: 204 });
  }

  const result: PricingResult = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const status = (await redis.get<string>(REDIS_KEY_STATUS)) ?? 'idle';

  return NextResponse.json({ ...result, status });
}
