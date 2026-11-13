/**
 * GET /api/web-payments              → every pay-later schedule + the mode
 * GET /api/web-payments?reservation=BH-… → one booking's schedule + its event log
 *
 * Read-only views for the drawer and the Pay later panel. Admin + super can
 * look; every action (charge, cancel, mode) is admin only — see [id]/ and settings/.
 */
import { NextRequest, NextResponse } from 'next/server';
import { webPaymentRepo } from '@/data-access/webPayments';
import { requireRole } from '@/utils/authGuard';
import { cronBaseUrl } from '@/utils/cronAuth';
import { readWebPaymentMode } from '@/utils/webPayments/deps';
import { toView } from '@/utils/webPayments/engine';

export const dynamic = 'force-dynamic';

const viewIo = { baseUrl: cronBaseUrl, now: () => new Date() };

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const reservation = req.nextUrl.searchParams.get('reservation');
  if (reservation) {
    let row = await webPaymentRepo.getByReservation(reservation);
    if (!row && /^BH-\d+$/.test(reservation)) row = await webPaymentRepo.findByBookingId(Number(reservation.slice(3)));
    if (!row) return NextResponse.json({ schedule: null });
    const events = await webPaymentRepo.listEvents(row.id);
    return NextResponse.json({ schedule: toView(viewIo, row), events, canAct: guard.role === 'admin' });
  }

  const [mode, rows] = await Promise.all([readWebPaymentMode(), webPaymentRepo.listAll()]);
  return NextResponse.json({ mode, schedules: rows.map((r) => toView(viewIo, r)), canAct: guard.role === 'admin' });
}
