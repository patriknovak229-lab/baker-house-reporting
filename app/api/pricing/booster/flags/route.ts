/**
 * POST /api/pricing/booster/flags  { date: 'YYYY-MM-DD', commission: 25 | null }
 *
 * Ticks (or unticks, with null) a check-in date as boosted on Booking.com, with
 * the slider level used. Records the operator's action only — nothing is sent to
 * Booking.com; the booster itself is switched in the extranet.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import { readBoostedDates, setBoostedDate } from '@/data-access/pricing/boostedDates';
import { BOOST_LEVELS, isIsoDate } from '@/utils/boosterCandidates';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const guard = await requireAccess('pricing', 'change');
  if ('error' in guard) return guard.error;

  let body: { date?: unknown; commission?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const { date, commission } = body;
  if (!isIsoDate(date)) {
    return NextResponse.json({ error: 'date must be YYYY-MM-DD' }, { status: 400 });
  }
  if (commission !== null && !(typeof commission === 'number' && BOOST_LEVELS.includes(commission))) {
    return NextResponse.json(
      { error: `commission must be null or one of ${BOOST_LEVELS.join(', ')}` },
      { status: 400 },
    );
  }

  try {
    await setBoostedDate(date, commission, guard.email ?? null);
    const flags = await readBoostedDates();
    return NextResponse.json({ ok: true, flag: flags[date] ?? null });
  } catch (err) {
    console.error('[pricing-booster-flags]', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
