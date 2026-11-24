/**
 * Scheduled payment links (types/scheduledPaymentLink.ts).
 *
 *   GET                         → all scheduled links
 *   POST  { allocations, description, isMainPayment?, sendDate,
 *           guestEmail, guestName?, guestPhone? }   → schedule one
 *   PATCH { id, action: 'cancel' | 'dismiss' }
 *         cancel  = stop it (a link already out is expired and its unpaid record removed)
 *         dismiss = acknowledge an alert (blocked / unpaid / failed)
 *
 * The daily cron /api/cron/send-scheduled-payments does the sending.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAccess } from '@/utils/authGuard';
import type { PaymentAllocation } from '@/types/additionalPayment';
import type { ScheduledPaymentLink } from '@/types/scheduledPaymentLink';
import { SCHEDULED_LINK_ALERT_STATUSES } from '@/types/scheduledPaymentLink';
import { getScheduledLink, insertScheduledLink, listScheduledLinks, saveScheduledLink } from '@/data-access/scheduledPaymentLinks';
import { readAllAdditionalPayments, writeAllAdditionalPayments } from '@/utils/additionalPaymentsStore';
import { allocationsError } from '@/utils/paymentAllocations';
import { expireCheckoutSession } from '@/utils/paymentLinkServer';
import { pragueToday } from '@/utils/periodUtils';
import { isRelayEmail } from '@/utils/stayChains';

export const dynamic = 'force-dynamic';

const bad = (status: number, error: string) => NextResponse.json({ error }, { status });

export async function GET() {
  const guard = await requireAccess('transactions', 'view');
  if ('error' in guard) return guard.error;
  return NextResponse.json(await listScheduledLinks());
}

export async function POST(req: NextRequest) {
  const guard = await requireAccess('transactions', 'change');
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const description = String(body.description ?? '').trim();
  const sendDate = String(body.sendDate ?? '');
  const guestEmail = String(body.guestEmail ?? '').trim();
  const raw = Array.isArray(body.allocations) ? body.allocations : [];

  if (!description) return bad(400, 'Description is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sendDate)) return bad(400, 'Send date must be YYYY-MM-DD');
  if (sendDate <= pragueToday()) return bad(400, 'Send date must be tomorrow or later — use Generate for today');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guestEmail)) return bad(400, "A scheduled link is emailed — enter the guest's email");
  if (isRelayEmail(guestEmail)) return bad(400, "That's a Booking.com/Airbnb relay address — it needs the guest's own email");

  // One booking is allowed here (allocationsError wants 2+ for a combined link).
  if (raw.length !== 1) {
    const err = allocationsError(raw);
    if (err) return bad(400, err);
  }
  const allocations: PaymentAllocation[] = raw.map((a: { reservationNumber: unknown; amountCzk: unknown }) => ({
    reservationNumber: String(a.reservationNumber ?? '').trim(),
    amountCzk: Math.round(Number(a.amountCzk) * 100) / 100,
  }));
  if (allocations.length === 0 || allocations.some((a) => !a.reservationNumber || !(a.amountCzk >= 1))) {
    return bad(400, 'Every booking needs a reservation number and an amount of at least 1 Kč');
  }

  const link: ScheduledPaymentLink = {
    id: `spl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    reservationNumber: allocations[0].reservationNumber,
    allocations,
    amountCzk: Math.round(allocations.reduce((s, a) => s + a.amountCzk, 0) * 100) / 100,
    description,
    isMainPayment: !!body.isMainPayment,
    sendDate,
    guestEmail,
    guestName: String(body.guestName ?? '').trim() || undefined,
    guestPhone: String(body.guestPhone ?? '').trim() || undefined,
    status: 'scheduled',
    failureCount: 0,
    createdAt: new Date().toISOString(),
    createdBy: guard.email,
  };
  await insertScheduledLink(link);
  return NextResponse.json({ ok: true, link });
}

export async function PATCH(req: NextRequest) {
  const guard = await requireAccess('transactions', 'change');
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const link = await getScheduledLink(String(body.id ?? ''));
  if (!link) return bad(404, 'Scheduled link not found');

  if (body.action === 'dismiss') {
    if (!SCHEDULED_LINK_ALERT_STATUSES.includes(link.status)) return bad(409, 'Nothing to dismiss');
    await saveScheduledLink({ ...link, dismissedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true });
  }

  if (body.action === 'cancel') {
    if (link.status !== 'scheduled' && link.status !== 'sent' && link.status !== 'reminded') {
      return bad(409, `Can't cancel a ${link.status} link`);
    }
    // A link that is already out: kill it and drop its unpaid record.
    if (link.paymentId) {
      await expireCheckoutSession(link.paymentId);
      const payments = await readAllAdditionalPayments();
      const p = payments.find((x) => x.id === link.paymentId);
      if (p?.status === 'paid') return bad(409, 'The guest has already paid this link');
      if (p) await writeAllAdditionalPayments(payments.filter((x) => x.id !== link.paymentId));
    }
    await saveScheduledLink({ ...link, status: 'cancelled', dismissedAt: new Date().toISOString() });
    return NextResponse.json({ ok: true });
  }

  return bad(400, "action must be 'cancel' or 'dismiss'");
}
