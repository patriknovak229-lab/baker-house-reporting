/**
 * POST /api/bookings/initial-invoice
 *
 * The invoice half of the New Booking modal. Runs right after the modal has
 * created the booking: stores the customer's billing details on it and, on
 * request, emails the invoice now or schedules it.
 *
 * Body: {
 *   reservationNumbers: string[];          // what POST /api/bookings returned
 *   invoiceData: InvoiceData;
 *   delivery: 'save' | 'now' | 'schedule';
 *   sendDate?: string;                     // 'schedule' only — YYYY-MM-DD, after today (Prague)
 *   includeQR?: boolean;                   // bank details + payment QR on the invoice
 * }
 *
 *   save      → invoiceData on the reservation, nothing issued — the drawer's
 *               "Save details".
 *   schedule  → invoiceData + an open "Send invoice" task due on `sendDate`.
 *               The 09:00 send-due-invoices cron sends it that morning, with
 *               payment details when the task says so. Same pipeline as the
 *               chat agent's invoice requests, so it shows in the drawer and
 *               the pending-tasks bar like any other invoice task.
 *   now       → invoiceData, then the invoice goes out through the same
 *               sendInvoiceEmail the drawer's Send button uses, the booking is
 *               marked Sent, and — with payment details — the issued revenue
 *               invoice is recorded exactly as the drawer records it.
 *
 * 'now' reads the booking back from Beds24 (forced sync) rather than trusting
 * the modal's copy: the unit Beds24 allocated, the price it stored and the
 * guest names in its comment are what the invoice must print.
 *
 * The booking already exists when this runs. Every failure therefore says what
 * WAS saved (`saved`), so the modal never reads as "the booking failed" — a
 * retry of the booking would create a duplicate.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceData, InvoiceStatus, Issue, Reservation } from '@/types/reservation';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { buildReservationSet } from '@/utils/beds24Reservations';
import { sendInvoiceEmail } from '@/utils/invoiceSend';
import { revenueInvoiceId } from '@/utils/invoiceUtils';
import { syncIssuedRevenueInvoices } from '@/utils/revenueInvoiceSync';
import { pragueToday } from '@/utils/periodUtils';
import { parseNewBookingInvoice, scheduledInvoiceTask } from '@/utils/newBookingInvoice';

// Forced Beds24 sync + Chromium PDF render + SMTP (with its bounded pre-DATA
// retry) needs more than the platform default.
export const maxDuration = 60;

interface OverrideEntry {
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
  issues?: Issue[];
  [field: string]: unknown;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Read-modify-write ONE reservation's override entry, keeping every other field. */
async function patchOverride(reservationNumber: string, patch: (entry: OverrideEntry) => OverrideEntry) {
  const overrides = await readAllReservationOverrides<OverrideEntry>();
  overrides[reservationNumber] = patch(overrides[reservationNumber] ?? {});
  await writeAllReservationOverrides(overrides);
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const parsed = parseNewBookingInvoice(await req.json().catch(() => null), pragueToday());
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error, saved: false }, { status: 400 });
  }
  const { reservationNumber, reservationNumbers, invoiceData, delivery, sendDate, includeQR } = parsed.value;

  // 1. Details (and the scheduled task) first, so they survive anything below.
  try {
    await patchOverride(reservationNumber, (entry) => ({
      ...entry,
      invoiceData,
      ...(delivery === 'schedule' && sendDate
        ? { issues: [...(entry.issues ?? []), scheduledInvoiceTask(invoiceData, sendDate, includeQR)] }
        : {}),
    }));
  } catch (err) {
    console.error('[initial-invoice] saving details failed:', err);
    return NextResponse.json(
      { error: `Could not save the invoice details: ${errMsg(err)}`, saved: false },
      { status: 500 },
    );
  }

  if (delivery === 'save') {
    return NextResponse.json({ ok: true, status: 'saved', reservationNumber });
  }
  if (delivery === 'schedule') {
    return NextResponse.json({ ok: true, status: 'scheduled', reservationNumber, sendDate, includeQR });
  }

  // 2. 'now' — the booking as the dashboard will show it, fresh from Beds24.
  let reservation: Reservation | undefined;
  try {
    const all = await buildReservationSet({ fullSync: true });
    reservation =
      all.find((r) => r.reservationNumber === reservationNumber) ??
      all.find((r) => reservationNumbers.includes(r.reservationNumber));
  } catch (err) {
    console.error('[initial-invoice] reading the booking back failed:', err);
    return NextResponse.json(
      {
        error: `Invoice details saved, but the booking could not be read back from Beds24 (${errMsg(err)}). Send the invoice from the reservation drawer.`,
        saved: true,
        reservationNumber,
      },
      { status: 502 },
    );
  }
  if (!reservation || reservation.isCancelled) {
    return NextResponse.json(
      {
        error: `Invoice details saved, but ${reservationNumber} is not visible in Beds24 yet. Send the invoice from the reservation drawer once it shows up.`,
        saved: true,
        reservationNumber,
      },
      { status: 502 },
    );
  }

  let result: Awaited<ReturnType<typeof sendInvoiceEmail>>;
  try {
    result = await sendInvoiceEmail(
      { ...reservation, invoiceData, invoiceStatus: 'Not Issued' },
      { includeQR },
    );
  } catch (err) {
    console.error(`[initial-invoice] sending ${reservation.reservationNumber} failed:`, err);
    return NextResponse.json(
      {
        error: `Invoice details saved, but sending failed: ${errMsg(err)}. Send it from the reservation drawer.`,
        saved: true,
        reservationNumber: reservation.reservationNumber,
      },
      { status: 502 },
    );
  }

  // 3. Mark it Sent. Re-read first: the send took seconds, and the whole-map
  //    write must not undo anything saved meanwhile. A 'deferred' outcome is
  //    marked Sent too — the server has the message; re-sending is what would
  //    duplicate it (see utils/invoiceSend.ts).
  let statusSaved = true;
  try {
    await patchOverride(reservation.reservationNumber, (entry) => ({
      ...entry,
      invoiceData,
      invoiceStatus: 'Sent',
    }));
  } catch (err) {
    statusSaved = false;
    console.error(`[initial-invoice] ${reservation.reservationNumber} sent but status not saved:`, err);
  }

  // 4. With payment details the guest pays the invoice by bank transfer, so it
  //    needs the issued revenue record bank matching keys on — what the
  //    drawer's syncRevenueInvoices writes when it sends with the QR on.
  let revenueRecorded: boolean | undefined;
  if (includeQR) {
    try {
      await syncIssuedRevenueInvoices(reservation.reservationNumber, [
        {
          id: revenueInvoiceId(reservation.reservationNumber),
          invoiceNumber: result.invoiceNumber,
          invoiceDate: new Date().toISOString().slice(0, 10),
          amountCZK: reservation.price,
          guestName: `${reservation.firstName} ${reservation.lastName}`.trim(),
        },
      ]);
      revenueRecorded = true;
    } catch (err) {
      revenueRecorded = false;
      console.error(`[initial-invoice] revenue record for ${reservation.reservationNumber} failed:`, err);
    }
  }

  return NextResponse.json({
    ok: true,
    status: result.outcome, // 'sent' | 'deferred'
    reservationNumber: reservation.reservationNumber,
    invoiceNumber: result.invoiceNumber,
    sentTo: result.sentTo,
    ...(result.deferral ? { deferral: result.deferral } : {}),
    statusSaved,
    ...(revenueRecorded !== undefined ? { revenueRecorded } : {}),
  });
}
