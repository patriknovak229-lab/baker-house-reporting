import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { ComputedSettlement } from '@/utils/commissionCalc';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const KEY = 'baker:commission-settlements';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

export function settlementId(unitId: string, month: string): string {
  return `settle-${unitId}-${month}`;
}

// GET /api/commission — list all issued settlements
export async function GET() {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const settlements = (await redis.get<CommissionSettlement[]>(KEY)) ?? [];
  return NextResponse.json(settlements);
}

// POST /api/commission — issue (persist) a settlement snapshot.
// Body is a ComputedSettlement; server stamps id/status/createdAt/createdBy.
// Re-issuing the same unit+month overwrites the prior snapshot (unless it is
// already reconciled to a bank payout, which is protected).
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in guard) return guard.error;

  const session = await auth();
  const createdBy = session?.user?.email ?? guard.email ?? 'unknown';

  const body = (await req.json()) as ComputedSettlement & { force?: boolean };
  if (!body?.unitId || !body?.month) {
    return NextResponse.json({ error: 'unitId and month are required' }, { status: 400 });
  }

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const existing = (await redis.get<CommissionSettlement[]>(KEY)) ?? [];
  const id = settlementId(body.unitId, body.month);
  const prior = existing.find((s) => s.id === id);

  if (prior && prior.status === 'reconciled' && !body.force) {
    return NextResponse.json(
      { error: 'A reconciled settlement already exists for this apartment and month. Unlink it from the bank before re-issuing.', code: 'reconciled' },
      { status: 409 },
    );
  }

  const { force: _force, ...computed } = body;
  void _force;

  const settlement: CommissionSettlement = {
    ...computed,
    id,
    status: 'issued',
    // preserve a prior bank link only if forcing a recompute of a non-reconciled one
    bankTransactionId: undefined,
    reconciledAt: undefined,
    createdAt: new Date().toISOString(),
    createdBy,
  };

  const next = prior
    ? existing.map((s) => (s.id === id ? settlement : s))
    : [...existing, settlement];

  await redis.set(KEY, next);
  return NextResponse.json(settlement);
}
