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
 *   - task carries `holdAutoSend`    → leave for the operator. Set by the
 *     (e.g. guest asked for a           webhook when the guest names an amount
 *     different amount)                 that isn't the booking price — typically
 *                                       a "Booking.com pays" discount Beds24
 *                                       never sees. The operator modifies the
 *                                       invoice amount and sends it manually.
 *   - details incomplete (no IČO or  → leave the task open for the operator
 *     VAT, or no billing email)         (same as today).
 *   - checkout older than ~6 months  → leave for the operator (the webhook
 *                                       already Telegrammed it once). Anything
 *                                       younger is sent on the next run, however
 *                                       late the guest asked: accountants chase
 *                                       guests weeks after the stay.
 *   - otherwise                      → generate + email via the SAME util the
 *                                      manual send uses, mark invoiceStatus
 *                                      "Sent", and resolve the task.
 *
 * Failures leave the task unresolved (stays in the operator's pending-tasks
 * banner) and fire a Telegram alert. Idempotency = invoiceStatus + resolved
 * task, so a re-run never double-sends.
 *
 * Auth: platform cron via utils/cronAuth (CRON_SECRET when set, else Vercel's
 * documented header/user-agent); otherwise admin/super for a manual trigger.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { cronAuth } from '@/utils/cronAuth';
import type { InvoiceData, Issue, InvoiceStatus, InvoiceSplit, Reservation } from '@/types/reservation';
import { buildReservationSet } from '@/utils/beds24Reservations';
import { readAllReservationOverrides, writeAllReservationOverrides } from '@/utils/reservationOverridesStore';
import { sendInvoiceEmail } from '@/utils/invoiceSend';
import { sendTelegram } from '@/utils/telegram';
import {
  checkBookingsMirrorHealth,
  bookingsMirrorAlert,
  type BookingsMirrorHealth,
} from '@/utils/bookingsMirrorHealth';
import { writeCronHeartbeat } from '@/data-access/cronHeartbeat';
import { autoSendWindowStart } from '@/utils/invoiceAutoSendRules';

export const maxDuration = 60;

interface OverrideEntry {
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
  issues?: Issue[];
  invoiceSplits?: InvoiceSplit[];
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * A company identifier + a billing email are the mandatory fields to issue an
 * invoice unattended. The identifier is IČO **or** a VAT/DIČ number: foreign
 * companies (Polish, German, Slovak…) have no Czech 8-digit IČO, and requiring
 * one left their invoices sitting unsent even after the guest had given us
 * everything. The invoice PDF prints whichever identifier is present.
 */
function invoiceDataComplete(d: InvoiceData | null | undefined): d is InvoiceData {
  const hasCompanyId = !!d?.ico?.trim() || !!d?.vatNumber?.trim();
  return !!d && hasCompanyId && !!d.billingEmail?.trim();
}

/**
 * Liveness write. Every exit path calls this, including the failures, because
 * an ABSENT heartbeat is how we detect "never invoked" — so a run that starts
 * and then dies must not leave the same trace as one that never happened. That
 * ambiguity is the whole bug this job kept re-teaching us.
 */
function beat(summary: Record<string, unknown>): Promise<void> {
  return writeCronHeartbeat('send-due-invoices', {
    ranAt: new Date().toISOString(),
    summary,
  }).catch((err) => console.error('[cron/send-due-invoices] heartbeat write failed:', err));
}

async function run(req: NextRequest) {
  const { isCron } = cronAuth(req, 'send-due-invoices');
  if (!isCron) {
    const auth = await requireRole(['admin', 'super']);
    if ('error' in auth) return auth.error;
  }

  // Claim the invocation up front, before any work that could throw. Overwritten
  // with the real summary on success; replaced with the error on failure.
  await beat({ phase: 'started' });

  try {
    return await sendDueInvoices();
  } catch (err) {
    // Nothing below re-raises on purpose, so reaching here means an unforeseen
    // throw. Previously that returned a bare 500 with no heartbeat and no
    // Telegram: invisible, and indistinguishable from the cron not firing.
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[cron/send-due-invoices] run failed:', err);
    await beat({ phase: 'failed', error: reason });
    await sendTelegram(
      `⚠️ Invoice auto-send crashed before completing: ${reason}\nNo invoices were sent by this run.`,
    ).catch(() => {});
    return NextResponse.json({ error: reason }, { status: 500 });
  }
}

async function sendDueInvoices() {
  const today = todayUTC();
  // Auto-send window: checkouts up to ~6 months back (INVOICE_AUTO_SEND_MAX_AGE_DAYS).
  // Was 3 days, which silently stranded every request a guest made more than
  // three days after checking out (BH-93787214, 7 Oct 2026).
  const earliest = autoSendWindowStart(today);

  // Fresh bookings (correct amounts/dates) + overrides (invoiceData / status / task).
  let reservations: Reservation[];
  try {
    reservations = await buildReservationSet();
  } catch (err) {
    // Was silent: no heartbeat, no Telegram, just a 502 into Vercel's logs. A
    // Beds24 outage on checkout day would have looked exactly like the cron
    // being dead again.
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[cron/send-due-invoices] buildReservationSet failed:', reason);
    await beat({ phase: 'failed', step: 'buildReservationSet', error: reason });
    await sendTelegram(
      `⚠️ Invoice auto-send could not load bookings: ${reason}\nNo invoices were sent by this run.`,
    ).catch(() => {});
    return NextResponse.json({ error: `Load failed: ${reason}` }, { status: 502 });
  }

  const overrides = await readAllReservationOverrides<OverrideEntry>();
  const byNumber = new Map(reservations.map((r) => [r.reservationNumber, r]));

  let sent = 0;
  let deferred = 0;
  let alreadySent = 0;
  let skippedManual = 0;
  let skippedHeld = 0;
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

    // Held by the webhook (guest named a different amount, e.g. a "Booking.com
    // pays" discount). Auto-sending would bill the booking price the guest
    // says is wrong; the operator sets the amount and sends from the drawer.
    if (issues.some((i) => isOpenInvoiceTask(i) && !!i.holdAutoSend)) {
      skippedHeld += 1;
      continue;
    }

    // Split invoices: the booking is billed to several parties, each with its
    // own customer block and share. Auto-sending would email ONE invoice for
    // the whole stay to whoever happens to sit in `invoiceData` — so this is
    // deliberately the operator's to send from the drawer.
    if ((ov.invoiceSplits?.length ?? 0) > 0) {
      skippedManual += 1;
      continue;
    }

    // Older than the ~6-month window (every due task) → operator.
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

  const result = {
    today,
    sent,
    deferred,
    deferrals: deferrals.length > 0 ? deferrals : undefined,
    alreadySent,
    skippedManual,
    skippedHeld,
    skippedIncomplete,
    skippedStale,
    failed,
    errors: errors.length > 0 ? errors : undefined,
    mirrorHealth,
  };

  // Recorded even when the queue was empty — that case is the point: "ran,
  // nothing due" and "never ran" are otherwise indistinguishable. `alreadySent`
  // and `skippedManual` are in here because without them the first real run
  // (30 Sep) reported all zeros despite resolving three tasks, which reads as
  // "did nothing" when it had in fact done its job.
  await beat({
    phase: 'completed',
    sent,
    deferred,
    failed,
    alreadySent,
    skippedManual,
    skippedHeld,
    skippedStale,
    skippedIncomplete,
  });

  return NextResponse.json(result);
}

// Vercel invokes cron paths with GET (see utils/cronAuth). POST stays for the
// manual/admin trigger, so the schedule and the button share one code path.
export const POST = run;
export const GET = run;
