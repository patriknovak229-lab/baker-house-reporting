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
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';

interface DesiredInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  amountCZK: number;
  guestName?: string;
}

export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { reservationNumber, invoices: desired } = (await request.json()) as {
    reservationNumber?: string;
    invoices?: DesiredInvoice[];
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

  const all = await readAllRevenueInvoices();
  const now = new Date().toISOString();
  const wanted = new Set(desired.map((d) => d.id));

  const isIssuedForThisBooking = (i: RevenueInvoice) =>
    i.sourceType === 'issued' && i.reservationNumber === reservationNumber;

  // Drop the issued records this reservation no longer wants — except any that
  // a bank transaction already points at.
  const keptReconciled: string[] = [];
  const removed: string[] = [];
  const next = all.filter((i) => {
    if (!isIssuedForThisBooking(i) || wanted.has(i.id)) return true;
    if (i.status === 'reconciled' || i.bankTransactionId) {
      keptReconciled.push(i.invoiceNumber);
      return true;
    }
    removed.push(i.invoiceNumber);
    return false;
  });

  // Upsert the desired set, carrying over everything the accountant owns
  // (status, bank link, Drive file) from any record already at that id.
  for (const d of desired) {
    const idx = next.findIndex((i) => i.id === d.id);
    const prev = idx >= 0 ? next[idx] : undefined;
    const record: RevenueInvoice = {
      id: d.id,
      sourceType: 'issued',
      category: prev?.category ?? 'accommodation_direct',
      status: prev?.status ?? 'pending',
      invoiceNumber: d.invoiceNumber,
      invoiceDate: d.invoiceDate,
      amountCZK: d.amountCZK,
      reservationNumber,
      guestName: d.guestName,
      bankTransactionId: prev?.bankTransactionId,
      reconciledAt: prev?.reconciledAt,
      driveFileId: prev?.driveFileId,
      driveFileName: prev?.driveFileName,
      driveUrl: prev?.driveUrl,
      createdAt: prev?.createdAt ?? now,
    };
    if (idx >= 0) next[idx] = record;
    else next.push(record);
  }

  await writeAllRevenueInvoices(next);

  return NextResponse.json({
    written: desired.length,
    removed,
    keptReconciled,
  });
}
