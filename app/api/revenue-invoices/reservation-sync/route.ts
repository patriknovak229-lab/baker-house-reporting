/**
 * POST /api/revenue-invoices/reservation-sync
 *
 * Replaces the whole set of ISSUED revenue invoices for one reservation.
 *
 * Why this exists: a booking used to produce exactly one revenue invoice, at
 * the deterministic id `rev-<reservationNumber>`, so re-issuing simply
 * overwrote it. Split invoices break that — one booking now produces N records
 * (`rev-<reservationNumber>-<seq>`), and the count changes as the operator adds
 * or removes splits. Upserting one at a time would leave the previous shape
 * behind and count the same stay twice in the P&L.
 *
 * So the client sends the full desired set and this route makes reality match:
 * upsert each one, drop the issued records for that reservation that are no
 * longer wanted.
 *
 * Reconciled records are NEVER dropped. Once an invoice is matched to a bank
 * transaction, deleting it would strand that transaction's `revenueInvoiceId`.
 * Those are reported back in `keptReconciled` for the operator to sort out by
 * hand rather than silently unlinked.
 *
 * Body: { reservationNumber, invoices: [{ id, invoiceNumber, invoiceDate, amountCZK, guestName? }] }
 */

import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { syncIssuedRevenueInvoices, type DesiredRevenueInvoice } from '@/utils/revenueInvoiceSync';

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { reservationNumber, invoices: desired } = (await request.json()) as {
    reservationNumber?: string;
    invoices?: DesiredRevenueInvoice[];
  };

  if (!reservationNumber || !Array.isArray(desired)) {
    return NextResponse.json(
      { error: 'Missing required fields: reservationNumber, invoices[]' },
      { status: 400 },
    );
  }
  for (const d of desired) {
    if (!d?.id || !d.invoiceNumber || !d.invoiceDate || typeof d.amountCZK !== 'number') {
      return NextResponse.json(
        { error: 'Each invoice needs id, invoiceNumber, invoiceDate and a numeric amountCZK' },
        { status: 400 },
      );
    }
  }

  // The replace itself (drop what's no longer issued, keep reconciled records,
  // upsert the rest) lives in utils/revenueInvoiceSync so the server-side
  // senders record revenue through the same code.
  return NextResponse.json(await syncIssuedRevenueInvoices(reservationNumber, desired));
}
