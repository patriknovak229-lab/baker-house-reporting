import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { publishRatePerksEntry, removeRatePerksEntry } from '@/utils/ratePerksPublish';
import { publishOpsTasksEntry, removeOpsTasksEntry } from '@/utils/opsTasksPublish';
import { publishCleaningRequestsEntry, removeCleaningRequestsEntry } from '@/utils/cleaningRequestsPublish';
import type { PerkOverrides } from '@/utils/ratePerks';
import type { Issue, RateType } from '@/types/reservation';

/**
 * POST /api/rate-perks — republish ONE reservation's cleaning-facing state:
 * its effective perks, its ad-hoc operational tasks and its requested
 * mid-stay cleanings.
 *
 * Why this exists: both maps are otherwise only rewritten by GET /api/bookings,
 * so an instruction saved in the drawer would sit invisible to the cleaner until
 * the next Transactions load. The drawer calls this right after the override is
 * saved.
 *
 * Body: { reservationNumber, rateType, reservationDate, apartments?, room,
 *         linkedRooms?, checkInDate, checkOutDate, cancelled? }
 * `rateType` is the EFFECTIVE rate the client already resolved (override wins),
 * `reservationDate` the booking-made date for the Standard perk date-gate, and
 * `apartments` each apartment's own booking number on a multi-apartment
 * reservation (the cleaning app keys cleanings by those), and the room(s) and
 * stay dates a mid-stay cleaning request is placed by — all booking facts
 * the client legitimately holds. The perk VALUES are
 * recomputed here from the stored override, and the task list is read from the
 * stored issues, so no text can be spoofed by the request body. A cancelled
 * reservation is REMOVED from every map, the same as the authoritative pass,
 * which skips cancellations outright.
 */
export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const {
    reservationNumber, rateType, reservationDate, apartments, room, linkedRooms, checkInDate, checkOutDate, cancelled,
  } = await req.json();
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber required' }, { status: 400 });
  }
  if (
    apartments !== undefined &&
    !(Array.isArray(apartments) && apartments.every((a) => typeof a === 'string' && /^BH-\d+$/.test(a)))
  ) {
    return NextResponse.json({ error: 'apartments must be BH- booking numbers' }, { status: 400 });
  }
  const ymd = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '');
  const r = {
    reservationNumber: String(reservationNumber),
    apartmentReservationNumbers: apartments as string[] | undefined,
    room: typeof room === 'string' ? room : '',
    linkedRooms: Array.isArray(linkedRooms) ? linkedRooms.filter((x): x is string => typeof x === 'string') : undefined,
    checkInDate: ymd(checkInDate),
    checkOutDate: ymd(checkOutDate),
  };

  if (cancelled) {
    await Promise.all([removeRatePerksEntry(r), removeOpsTasksEntry(r), removeCleaningRequestsEntry(r)]);
    return NextResponse.json({ ok: true, perks: null, opsTasks: {}, cleaningRequests: {} });
  }

  const overrides = await readAllReservationOverrides<{
    perkOverrides?: PerkOverrides;
    issues?: Issue[];
  }>();
  const entry = overrides[reservationNumber];

  // Sequential, not parallel: both patch their own whole-map key, and running
  // them together buys nothing while making a Redis hiccup harder to read.
  const perks = await publishRatePerksEntry(
    r,
    (rateType ?? null) as RateType | null,
    reservationDate ?? null,
    entry?.perkOverrides,
  );
  const opsTasks = await publishOpsTasksEntry(r, entry?.issues);
  const cleaningRequests = await publishCleaningRequestsEntry(r, entry?.issues);

  return NextResponse.json({ ok: true, perks, opsTasks, cleaningRequests });
}
