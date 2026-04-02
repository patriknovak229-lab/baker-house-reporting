import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';

// All locally managed reservation fields (not stored in Beds24)
// Keyed by reservationNumber (e.g. "BH-12345")
const REDIS_KEY = 'baker:reservation-overrides';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// GET /api/local-state — returns full overrides map
export async function GET() {
  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const raw = await redis.get(REDIS_KEY);
  return NextResponse.json(raw ?? {});
}

// POST /api/local-state — upsert one reservation's overrides
// Body: { reservationNumber: string, fields: Record<string, unknown> }
// Passing an empty fields object removes that reservation's entry.
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) {
    return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });
  }

  const { reservationNumber, fields } = await req.json();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber required' }, { status: 400 });
  }

  // Read → modify → write
  const raw = await redis.get(REDIS_KEY);
  const state: Record<string, unknown> = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  if (fields && Object.keys(fields).length > 0) {
    state[reservationNumber] = fields;
  } else {
    delete state[reservationNumber];
  }

  await redis.set(REDIS_KEY, state);
  return NextResponse.json({ ok: true });
}
