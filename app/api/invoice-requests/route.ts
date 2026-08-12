/**
 * GET  /api/invoice-requests                       → all pending requests
 *      /api/invoice-requests?reservationNumber=X   → just one reservation's
 * POST /api/invoice-requests/[id]                  → accept or reject (handler in [id] route)
 *
 * Pending invoice requests are auto-detected by /api/messages whenever the
 * drawer fetches a guest's thread. The Transactions list reads them via this
 * endpoint and merges them onto the reservation so the drawer can show an
 * Accept/Reject banner.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { readAllInvoiceRequests } from '@/utils/invoiceRequestsStore';

export async function GET(req: NextRequest) {
  const guard = await requireRole(['admin', 'super', 'viewer', 'accountant']);
  if ('error' in guard) return guard.error;

  const reservationNumber = req.nextUrl.searchParams.get('reservationNumber');
  const all = await readAllInvoiceRequests();

  const filtered = reservationNumber
    ? all.filter((r) => r.reservationNumber === reservationNumber)
    : all;

  return NextResponse.json(filtered);
}
