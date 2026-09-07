import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { publishRatePerksEntry, removeRatePerksEntry } from '@/utils/ratePerksPublish';
import { publishOpsTasksEntry, removeOpsTasksEntry } from '@/utils/opsTasksPublish';
import type { PerkOverrides } from '@/utils/ratePerks';
import type { Issue, RateType } from '@/types/reservation';

/**
 * POST /api/rate-perks — republish ONE reservation's cleaning-facing state:
 * its effective perks AND its ad-hoc operational tasks.
 *
 * Why this exists: both maps are otherwise only rewritten by GET /api/bookings,
 * so an instruction saved in the drawer would sit invisible to the cleaner until
 * the next Transactions load. The drawer calls this right after the override is
 * saved.
 *
 * Body: { reservationNumber, rateType, reservationDate, cancelled? }
 * `rateType` is the EFFECTIVE rate the client already resolved (override wins)
 * and `reservationDate` the booking-made date for the Standard perk date-gate —
 * both are booking facts the client legitimately holds. The perk VALUES are
 * recomputed here from the stored override, and the task list is read from the
 * stored issues, so no text can be spoofed by the request body. A cancelled
 * reservation is REMOVED from every map, the same as the authoritative pass,
 * which skips cancellations outright.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservationNumber, rateType, reservationDate, cancelled } = await req.json();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber required' }, { status: 400 });
  }

  if (cancelled) {
    await Promise.all([
      removeRatePerksEntry(reservationNumber),
      removeOpsTasksEntry(reservationNumber),
    ]);
    return NextResponse.json({ ok: true, perks: null, opsTasks: [] });
  }

  const overrides = await readAllReservationOverrides<{
    perkOverrides?: PerkOverrides;
    issues?: Issue[];
  }>();
  const entry = overrides[reservationNumber];

  // Sequential, not parallel: both patch their own whole-map key, and running
  // them together buys nothing while making a Redis hiccup harder to read.
  const perks = await publishRatePerksEntry(
    reservationNumber,
    (rateType ?? null) as RateType | null,
    reservationDate ?? null,
    entry?.perkOverrides,
  );
  const opsTasks = await publishOpsTasksEntry(reservationNumber, entry?.issues);

  return NextResponse.json({ ok: true, perks, opsTasks });
}
