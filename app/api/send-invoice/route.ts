import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { Reservation, InvoiceModification, InvoiceSplit } from '@/types/reservation';
import { sendInvoiceEmail } from '@/utils/invoiceSend';
import { splitTotals } from '@/utils/invoiceUtils';

// Chromium PDF render + SMTP (+ a bounded retry on a transient pre-DATA
// failure) needs more than the platform default.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservation, includeQR, modification, split }: {
    reservation: Reservation;
    includeQR?: boolean;
    modification?: InvoiceModification;
    /** One part of a split booking. Its own customer block and amount are used. */
    split?: InvoiceSplit;
  } = await req.json();

  // A split carries its own billing party; only the whole-booking invoice
  // needs the reservation-level one.
  const billTo = split?.invoiceData ?? reservation.invoiceData;
  if (!billTo) {
    return NextResponse.json({ error: 'No invoice data on reservation' }, { status: 400 });
  }
  if (!billTo.billingEmail) {
    return NextResponse.json({ error: 'No billing email on invoice' }, { status: 400 });
  }

  // Re-check the total server-side: a drawer left open while the booking price
  // dropped would otherwise email a set of invoices billing more than the stay.
  const splits = reservation.invoiceSplits ?? [];
  if (split) {
    const { allocated, over } = splitTotals(reservation.price, splits);
    if (over) {
      return NextResponse.json({
        error: `Split invoices total ${Math.round(allocated).toLocaleString('cs-CZ')} Kč, more than the booking's ${Math.round(reservation.price).toLocaleString('cs-CZ')} Kč. Adjust the amounts before sending.`,
      }, { status: 400 });
    }
  }

  try {
    // Generate + email via the shared util (same path the checkout-date cron uses).
    // Only throws when the message was genuinely not accepted — a transient
    // deferral comes back as outcome:'deferred', which is NOT a failure.
    const result = await sendInvoiceEmail(reservation, { includeQR, modification, split });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
