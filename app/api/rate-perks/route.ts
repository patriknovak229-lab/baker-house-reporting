import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { publishRatePerksEntry, removeRatePerksEntry } from '@/utils/ratePerksPublish';
import type { PerkOverrides } from '@/utils/ratePerks';
import type { RateType } from '@/types/reservation';

/**
 * POST /api/rate-perks — republish ONE reservation's effective perks to the
 * shared map the cleaning app reads.
 *
 * Why this exists: the perk map is otherwise only rewritten by GET
 * /api/bookings, so an ad-hoc special treatment saved in the drawer would sit
 * invisible to the cleaner until the next Transactions load. The drawer calls
 * this right after the override is saved.
 *
 * Body: { reservationNumber, rateType, reservationDate, cancelled? }
 * `rateType` is the EFFECTIVE rate the client already resolved (override wins)
 * and `reservationDate` the booking-made date for the Standard perk date-gate —
 * both are booking facts the client legitimately holds. The perk VALUES are
 * recomputed here from the stored override, so the note text can't be spoofed
 * by the request body. A cancelled reservation is REMOVED from both maps, the
 * same as the authoritative pass, which skips cancellations outright.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservationNumber, rateType, reservationDate, cancelled } = await req.json();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber required' }, { status: 400 });
  }

  if (cancelled) {
    await removeRatePerksEntry(reservationNumber);
    return NextResponse.json({ ok: true, perks: null });
  }

  const overrides = await readAllReservationOverrides<{ perkOverrides?: PerkOverrides }>();
  const perks = await publishRatePerksEntry(
    reservationNumber,
    (rateType ?? null) as RateType | null,
    reservationDate ?? null,
    overrides[reservationNumber]?.perkOverrides,
  );

  return NextResponse.json({ ok: true, perks });
}
