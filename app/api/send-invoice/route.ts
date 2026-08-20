import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { Reservation, InvoiceModification } from '@/types/reservation';
import { sendInvoiceEmail } from '@/utils/invoiceSend';

// Chromium PDF render + SMTP (+ a bounded retry on a transient pre-DATA
// failure) needs more than the platform default.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const { reservation, includeQR, modification }: {
    reservation: Reservation;
    includeQR?: boolean;
    modification?: InvoiceModification;
  } = await req.json();

  if (!reservation.invoiceData) {
    return NextResponse.json({ error: 'No invoice data on reservation' }, { status: 400 });
  }
  if (!reservation.invoiceData.billingEmail) {
    return NextResponse.json({ error: 'No billing email on invoice' }, { status: 400 });
  }

  try {
    // Generate + email via the shared util (same path the checkout-date cron uses).
    // Only throws when the message was genuinely not accepted — a transient
    // deferral comes back as outcome:'deferred', which is NOT a failure.
    const result = await sendInvoiceEmail(reservation, { includeQR, modification });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
