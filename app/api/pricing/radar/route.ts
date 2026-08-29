/**
 * GET /api/pricing/radar?days=180
 *
 * Demand calendar + price-vs-market position for every sellable unit, read
 * entirely from the local `market_daily` snapshot (see data-access/pricing/radar).
 * Never calls PriceLabs — the 06:30 market refresh cron owns that.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readRadar } from '@/data-access/pricing/radar';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const raw = Number(req.nextUrl.searchParams.get('days') ?? 365);
  const days = Number.isFinite(raw) ? Math.min(400, Math.max(30, Math.round(raw))) : 365;

  try {
    const radar = await readRadar(days);
    return NextResponse.json(radar);
  } catch (err) {
    console.error('[pricing-radar]', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
