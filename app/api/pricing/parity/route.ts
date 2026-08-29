/**
 * Parity monitor for the Pricing tab.
 *
 * GET  — latest grid run + recent custom checks (with results when done).
 * POST — queue a custom price check; the local runner polls the queue and
 *        ingests the answer within a few minutes.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { pragueToday } from '@/utils/periodUtils';
import { queueCheck, readParity } from '@/data-access/pricing/parity';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  try {
    return NextResponse.json(await readParity());
  } catch (err) {
    console.error('[pricing-parity]', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => null);
  const checkIn = typeof body?.checkIn === 'string' ? body.checkIn : null;
  const nights = Number(body?.nights);

  if (!checkIn || !/^\d{4}-\d{2}-\d{2}$/.test(checkIn)) {
    return NextResponse.json({ error: 'checkIn (YYYY-MM-DD) is required' }, { status: 400 });
  }
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) {
    return NextResponse.json({ error: 'nights must be an integer between 1 and 30' }, { status: 400 });
  }
  if (checkIn < pragueToday()) {
    return NextResponse.json({ error: 'checkIn is in the past' }, { status: 400 });
  }

  const result = await queueCheck(checkIn, nights, guard.email ?? null);
  if ('error' in result) {
    return NextResponse.json({ error: result.error }, { status: 429 });
  }
  return NextResponse.json(result, { status: 201 });
}
