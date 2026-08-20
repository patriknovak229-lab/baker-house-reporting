/**
 * POST /api/cron/send-due-invoices
 *
 * Daily cron (09:00) — the automatic half of the invoice flow. The chat flow
 * already collects the billing details and creates a "Send invoice" task
 * (Issue category="invoice", actionableDate = checkout) on the reservation.
 * This job issues + emails that invoice on the checkout date and resolves the
 * task.
 *
 * For each reservation with an UNRESOLVED, DUE invoice task:
 *   - invoiceStatus === "Sent"      → already emailed (manually or a prior run);
 *                                      just resolve the task. NEVER re-send.
 *   - invoiceStatus === "Issued"    → operator is mid-handling it → leave alone.
 *   - details incomplete (no IČO /   → leave the task open for the operator
 *     billing email)                   (same as today).
 *   - checkout older than the        → stale backlog → leave for the operator
 *     catch-up window                   (so go-live doesn't blast old invoices).
 *   - otherwise                      → generate + email via the SAME util the
 *                                      manual send uses, mark invoiceStatus
 *                                      "Sent", and resolve the task.
 *
 * Failures leave the task unresolved (stays in the operator's pending-tasks
 * banner) and fire a Telegram alert. Idempotency = invoiceStatus + resolved
 * task, so a re-run never double-sends.
 *
 * Auth: Vercel cron carries "x-vercel-cron: 1"; otherwise admin/super (manual
 * trigger for testing).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { InvoiceData, Issue, InvoiceStatus, Reservation } from '@/types/reservation';
import { buildReservationSet } from '@/utils/beds24Reservations';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { sendInvoiceEmail } from '@/utils/invoiceSend';
import { sendTelegram } from '@/utils/telegram';
import {
  checkBookingsMirrorHealth,
  bookingsMirrorAlert,
  type BookingsMirrorHealth,
} from '@/utils/bookingsMirrorHealth';

export const maxDuration = 60;

// Auto-send when checkout is within this many days of today: sends on the
// checkout date, tolerates a missed cron run, but does NOT reach back and
// invoice stale backlog (guards the first live run).
const CATCHUP_DAYS = 3;

interface OverrideEntry {
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
  issues?: Issue[];
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function ymdDaysAgo(base: string, days: number): string {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** IČO + billing email are the mandatory fields to issue an invoice unattended. */
function invoiceDataComplete(d: InvoiceData | null | undefined): d is InvoiceData {
  return !!d && !!d.ico?.trim() && !!d.billingEmail?.trim();
}

export async function POST(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') === '1';
  if (!isCron) {
    const auth = await requireRole(['admin', 'super']);
    if ('error' in auth) return auth.error;
  }

  const today = todayUTC();
  const earliest = ymdDaysAgo(today, CATCHUP_DAYS);

  // Fresh bookings (correct amounts/dates) + overrides (invoiceData / status / task).
  let reservations: Reservation[];
  try {
    reservations = await buildReservationSet();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[cron/send-due-invoices] buildReservationSet failed:', reason);
    return NextResponse.json({ error: `Load failed: ${reason}` }, { status: 502 });
  }

  const overrides = await readAllReservationOverrides<OverrideEntry>();
  const byNumber = new Map(reservations.map((r) => [r.reservationNumber, r]));

  let sent = 0;
  let deferred = 0;
  let alreadySent = 0;
  let skippedManual = 0;
  let skippedIncomplete = 0;
  let skippedStale = 0;
  let failed = 0;
  const errors: { reservation: string; reason: string }[] = [];
  const deferrals: { reservation: string; reason: string }[] = [];
  let dirty = false;

  const isOpenInvoiceTask = (i: Issue) => i.category === 'invoice' && !i.resolved;
  const resolveInvoiceTasks = (issues: Issue[]) =>
    issues.map((i) => (isOpenInvoiceTask(i) ? { ...i, resolved: true } : i));

  for (const [resNum, ov] of Object.entries(overrides)) {
    const issues = Array.isArray(ov.issues) ? ov.issues : [];
    const due = issues.filter(
      (i) => isOpenInvoiceTask(i) && !!i.actionableDate && i.actionableDate <= today,
    );
    if (due.length === 0) continue;

    // Already emailed (manual or prior run) → close the task, never re-send.
    if (ov.invoiceStatus === 'Sent') {
      ov.issues = resolveInvoiceTasks(issues);
      dirty = true;
      alreadySent += 1;
      continue;
    }

    // Operator has generated it (mid-handling) → don't touch.
    if (ov.invoiceStatus === 'Issued') {
      skippedManual += 1;
      continue;
    }

    // Stale backlog (every due task older than the catch-up window) → operator.
    if (due.every((i) => i.actionableDate < earliest)) {
      skippedStale += 1;
      continue;
    }

    const reservation = byNumber.get(resNum);
    if (!reservation || reservation.isCancelled || reservation.isBlackout) {
      skippedStale += 1; // no live/active booking → leave the task for the operator
      continue;
    }

    if (!invoiceDataComplete(ov.invoiceData)) {
      skippedIncomplete += 1; // missing IČO / billing email → operator handles it
      continue;
    }

    try {
      // A transient deferral comes back as outcome:'deferred' rather than
      // throwing — the mail server already has the message, so we mark it Sent
      // and resolve the task exactly as for a confirmed send. Re-sending
      // tomorrow is the one thing that could duplicate the invoice.
      const result = await sendInvoiceEmail(
        { ...reservation, invoiceData: ov.invoiceData, invoiceStatus: 'Not Issued' },
        { includeQR: false },
      );
      if (result.outcome === 'deferred') {
        deferred += 1;
        deferrals.push({ reservation: resNum, reason: result.deferral ?? 'deferred' });
      }
      ov.invoiceStatus = 'Sent';
      ov.issues = resolveInvoiceTasks(issues);
      dirty = true;
      sent += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[cron/send-due-invoices] send failed for ${resNum}:`, reason);
      errors.push({ reservation: resNum, reason });
      failed += 1;
      // Task stays unresolved → visible in the operator's banner.
    }
  }

  if (dirty) {
    try {
      await writeAllReservationOverrides(overrides);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error('[cron/send-due-invoices] overrides write failed:', reason);
      // We may have emailed invoices but couldn't persist "Sent" → alert loudly
      // so a re-run doesn't double-send before someone checks.
      await sendTelegram(
        `⚠️ Invoice cron sent ${sent} invoice(s) but FAILED to save status (re-send risk): ${reason}`,
      ).catch(() => {});
      return NextResponse.json({ error: `Persist failed after sending ${sent}: ${reason}`, sent }, { status: 500 });
    }
  }

  if (deferred > 0) {
    await sendTelegram(
      `ℹ️ Invoice auto-send: ${deferred} invoice(s) deferred by the mail server (handed over, delivery unconfirmed — check the Sent folder):\n` +
        deferrals.map((d) => `• ${d.reservation}: ${d.reason}`).join('\n'),
    ).catch(() => {});
  }

  if (failed > 0) {
    await sendTelegram(
      `⚠️ Invoice auto-send: ${failed} failed, ${sent} sent.\n` +
        errors.map((e) => `• ${e.reservation}: ${e.reason}`).join('\n'),
    ).catch(() => {});
  }

  // ── Bookings-archive heartbeat ──
  // Piggybacks on this daily run rather than adding a cron (Vercel's cron slots
  // are finite, and this job already fires at 09:00 and already has Telegram).
  // The archive is written as a side effect of the dashboard sync, so it can stop
  // silently — without this nothing would ever tell us. Entirely independent of
  // the invoice work above: it never affects `sent`, and its own failure is
  // swallowed so a health-check bug can't break invoice sending.
  let mirrorHealth: BookingsMirrorHealth | { error: string };
  try {
    mirrorHealth = await checkBookingsMirrorHealth({ persist: true });
    const alert = bookingsMirrorAlert(mirrorHealth);
    if (alert) await sendTelegram(alert).catch(() => {});
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error';
    console.error('[cron] bookings archive health check failed:', err);
    mirrorHealth = { error: reason };
    await sendTelegram(`⚠️ Bookings archive health check could not run: ${reason}`).catch(() => {});
  }

  return NextResponse.json({
    today,
    sent,
    deferred,
    deferrals: deferrals.length > 0 ? deferrals : undefined,
    alreadySent,
    skippedManual,
    skippedIncomplete,
    skippedStale,
    failed,
    errors: errors.length > 0 ? errors : undefined,
    mirrorHealth,
  });
}
