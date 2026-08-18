/**
 * POST /api/analytics/market/refresh
 *
 * Pulls the PriceLabs market benchmark into the local `market_*` tables. The only
 * route in the app that talks to PriceLabs.
 *
 * READ-ONLY UPSTREAM. This calls PriceLabs' read endpoints and writes nothing back
 * to them. PriceLabs is the property's live pricing engine — it decides what guests
 * are charged — so no rate-changing endpoint is reachable from this app at all (see
 * the scope note in `utils/priceLabs.ts`). The only writes here are into our own
 * snapshot tables, all upserts on natural keys, so re-running is always safe.
 *
 * Auth: Vercel cron sends `x-vercel-cron: 1`. A manual trigger needs admin/super —
 * deliberately narrower than the analytics read roles, because this one spends
 * money (PriceLabs bills per synced listing) and takes tens of seconds.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { pragueToday } from '@/utils/periodUtils';
import { refreshMarketSnapshot } from '@/data-access/analytics/marketRefresh';

// Four listings × three calls each, one of which returns ~540 KB. Comfortably
// inside Vercel Pro's ceiling, nowhere near a default 10s budget.
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

async function run(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') === '1';
  if (!isCron) {
    const guard = await requireRole(['admin', 'super']);
    if ('error' in guard) return guard.error;
  }

  try {
    const result = await refreshMarketSnapshot(pragueToday());
    if (!result.configured) {
      return NextResponse.json(
        { error: 'PRICELABS_API_KEY is not set — no market data to refresh.' },
        { status: 503 },
      );
    }
    // A partial failure is reported, not swallowed: the listings that succeeded
    // have fresh rows and the ones that failed kept their previous vintage.
    const failed = result.listings.filter((l) => l.error);
    return NextResponse.json(result, { status: failed.length === result.listings.length ? 502 : 200 });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('[market-refresh]', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const POST = run;

/** Vercel cron issues GET; keep both so the schedule and the button share a path. */
export const GET = run;
