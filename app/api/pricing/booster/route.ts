/**
 * GET /api/pricing/booster
 *
 * Visibility Booster candidates: upcoming check-in dates with open rooms, the
 * chance each would sell anyway, and whether boosting the date pays (see
 * utils/boosterCandidates.ts). A Postgres read — no Beds24 or PriceLabs call.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readBoosterCandidates } from '@/data-access/pricing/boosterCandidates';

export const dynamic = 'force-dynamic';

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  try {
    return NextResponse.json(await readBoosterCandidates());
  } catch (err) {
    console.error('[pricing-booster]', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
