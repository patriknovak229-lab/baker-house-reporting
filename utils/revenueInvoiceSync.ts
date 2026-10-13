/**
 * SERVER ONLY. Make the ISSUED revenue invoices for one reservation match the
 * documents the booking actually issued.
 *
 * Extracted verbatim from POST /api/revenue-invoices/reservation-sync so the
 * server-side senders (the New Booking modal's "send invoice now", the 09:00
 * cron for an invoice scheduled with payment details) record the revenue
 * exactly the way the drawer does — through the same function, not a copy.
 *
 * Why a whole-set replace rather than one upsert: a booking produces one
 * invoice (`rev-<reservationNumber>`) or one per split (`rev-<n>-<seq>`), and
 * the count changes as the operator adds or removes splits. Upserting one at a
 * time would leave the previous shape behind and count the same stay twice in
 * the P&L. So the caller sends the full desired set; records the booking no
 * longer issues are dropped.
 *
 * Reconciled records are NEVER dropped. Once an invoice is matched to a bank
 * transaction, deleting it would strand that transaction's `revenueInvoiceId`.
 * Those come back in `keptReconciled` for the operator to sort out by hand.
 */
import type { RevenueInvoice } from '@/types/revenueInvoice';
import { readAllRevenueInvoices, writeAllRevenueInvoices } from '@/utils/revenueInvoicesStore';

export interface DesiredRevenueInvoice {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  amountCZK: number;
  guestName?: string;
}

export interface RevenueInvoiceSyncResult {
  written: number;
  removed: string[];
  keptReconciled: string[];
}

export async function syncIssuedRevenueInvoices(
  reservationNumber: string,
  desired: DesiredRevenueInvoice[],
): Promise<RevenueInvoiceSyncResult> {
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

  return { written: desired.length, removed, keptReconciled };
}
