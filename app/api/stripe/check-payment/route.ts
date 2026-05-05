/**
 * POST /api/stripe/check-payment
 *
 * Operator-triggered fallback for the case where the Stripe webhook didn't fire
 * (or fired but didn't reach us). For a given reservation, walks every linked
 * AdditionalPayment that's still "unpaid", asks Stripe directly for the
 * Checkout Session's payment_status, flips local state if Stripe says paid,
 * and recomputes the reservation's paymentStatusOverride.
 *
 * Body: { reservationNumber: "BH-12345" }
 *
 * Response:
 *   { ok: true, checked: N, updated: M, status: "Paid" | "Partially Paid" | null,
 *     paidSum, bookingPrice, details: [{ id, status, paid, amountCzk }] }
 */

import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import { recomputePaymentOverride } from '@/utils/paymentReconcile';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { StripePaymentRecord } from '@/app/api/stripe/webhook/route';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const ADDITIONAL_PAYMENTS_KEY  = 'baker:additional-payments';
const REVENUE_INVOICES_KEY     = 'baker:revenue-invoices';
const STRIPE_PAYMENTS_KEY      = 'baker:stripe-payments';

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

interface DetailRow {
  id: string;
  amountCzk: number;
  description: string;
  before: 'unpaid' | 'paid';
  after: 'unpaid' | 'paid';
  stripeStatus: string | null;
  changed: boolean;
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const body = await req.json().catch(() => ({}));
  const reservationNumber = String(body?.reservationNumber ?? '').trim();
  // checkInDate is passed for Direct-Web reservations so we can match against
  // baker:stripe-payments records (those don't carry a reservationNumber —
  // the Beds24 booking is created after the Stripe session completes).
  const checkInDate = String(body?.checkInDate ?? '').trim();  // YYYY-MM-DD

  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }

  const redis = getRedis();
  const allPayments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];

  const linked = allPayments.filter((p) => p.reservationNumber === reservationNumber);

  // ── Direct/Direct-Web fallback: no payment links were created in the reporting
  // app, but a payment may have landed via the rental-site Stripe checkout (or
  // been processed before AdditionalPayment records existed). Look for a
  // matching record in baker:stripe-payments, retrieve the Stripe fee from the
  // BalanceTransaction, and persist as a paid AdditionalPayment so the fee
  // rolls up into reservation.paymentChargeAmount and the "fee missing"
  // warning clears. The resulting record is flagged isMainPayment=true so the
  // drawer shows it under "Booking Payment", not "Additional Payments".
  if (linked.length === 0 && checkInDate) {
    const rawRecords = (await redis.get<StripePaymentRecord[]>(STRIPE_PAYMENTS_KEY)) ?? [];
    const webRecord = rawRecords.find((r) =>
      (r.reservationNumber && r.reservationNumber === reservationNumber) ||
      r.description?.includes(checkInDate),
    );

    if (!webRecord) {
      return NextResponse.json({
        ok: true,
        checked: 0,
        updated: 0,
        status: null,
        message: 'No Stripe payments found for this reservation.',
      });
    }

    // Avoid double-import — if an AdditionalPayment with this sessionId already
    // exists (even on a different reservationNumber), skip creation.
    const existingByIdAnywhere = allPayments.find((p) => p.id === webRecord.sessionId);
    if (existingByIdAnywhere) {
      return NextResponse.json({
        ok: true,
        checked: 1,
        updated: 0,
        status: null,
        message: `Web payment found, already imported (linked to ${existingByIdAnywhere.reservationNumber}).`,
      });
    }

    // Fetch the Stripe session to get the fee from BalanceTransaction
    let stripeFeeCzk: number | undefined;
    let stripePaymentStatus: string | null = null;
    try {
      const session = await stripe.checkout.sessions.retrieve(webRecord.sessionId, {
        expand: ['payment_intent.latest_charge.balance_transaction'],
      });
      stripePaymentStatus = session.payment_status ?? null;
      const pi = session.payment_intent;
      if (pi && typeof pi !== 'string') {
        const charge = pi.latest_charge;
        if (charge && typeof charge !== 'string') {
          const bt = charge.balance_transaction;
          if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
            stripeFeeCzk = Math.round(bt.fee) / 100;
          }
        }
      }
    } catch (err) {
      console.error('[check-payment] Stripe retrieve failed for web session', webRecord.sessionId, err);
      return NextResponse.json({
        ok: false,
        error: 'Could not retrieve Stripe session for fee lookup.',
      }, { status: 502 });
    }

    // Create the AdditionalPayment record (isMainPayment so it's shown under
    // "Booking Payment" in the drawer, not "Additional Payments")
    const newAp: AdditionalPayment = {
      id:                webRecord.sessionId,
      reservationNumber: reservationNumber,
      description:       webRecord.description || `Booking payment ${reservationNumber}`,
      amountCzk:         webRecord.amountCzk,
      guestEmail:        webRecord.guestEmail || undefined,
      guestName:         webRecord.guestName || undefined,
      status:            'paid',
      createdAt:         webRecord.paidAt,
      paidAt:            webRecord.paidAt,
      isMainPayment:     true,
      ...(stripeFeeCzk !== undefined ? { stripeFeeCzk } : {}),
    };

    // Auto-create the matching RevenueInvoice
    const invoiceId = `pay-${webRecord.sessionId}`;
    const invoiceNumber = `PAY-${webRecord.sessionId.slice(-8).toUpperCase()}`;
    const invoiceDate = webRecord.paidAt.slice(0, 10);
    const invoices = (await redis.get<RevenueInvoice[]>(REVENUE_INVOICES_KEY)) ?? [];
    const invoiceExists = invoices.some((i) => i.id === invoiceId);
    const updatedInvoices = invoiceExists
      ? invoices
      : [
          ...invoices,
          {
            id:                invoiceId,
            sourceType:        'issued' as const,
            category:          'other_services' as const,
            status:            'pending' as const,
            invoiceNumber,
            invoiceDate,
            amountCZK:         webRecord.amountCzk,
            reservationNumber: reservationNumber,
            guestName:         webRecord.guestName || webRecord.guestEmail || undefined,
            description:       webRecord.description,
            createdAt:         webRecord.paidAt,
          },
        ];

    if (!invoiceExists) {
      newAp.invoiceId = invoiceId;
    }

    // Persist
    try {
      await Promise.all([
        redis.set(ADDITIONAL_PAYMENTS_KEY, [...allPayments, newAp]),
        ...(invoiceExists ? [] : [redis.set(REVENUE_INVOICES_KEY, updatedInvoices)]),
      ]);
    } catch (err) {
      console.error('[check-payment] Redis write failed (web import):', err);
      return NextResponse.json({ error: 'Persist failed' }, { status: 500 });
    }

    // Recompute payment override now that we've recorded a paid amount
    const reconcile = await recomputePaymentOverride(redis, reservationNumber);

    return NextResponse.json({
      ok: true,
      checked: 1,
      updated: 1,
      status: reconcile.status,
      paidSum: reconcile.paidSum,
      bookingPrice: reconcile.bookingPrice,
      webPayment: {
        sessionId:    webRecord.sessionId,
        amountCzk:    webRecord.amountCzk,
        guestEmail:   webRecord.guestEmail,
        paidAt:       webRecord.paidAt,
        description:  webRecord.description,
        stripeFeeCzk,
        stripePaymentStatus,
      },
      message: stripeFeeCzk !== undefined
        ? `Imported web payment · fee ${stripeFeeCzk.toFixed(2)} Kč captured.`
        : 'Imported web payment · Stripe fee not yet available (settlement pending). Try again in a few hours.',
    });
  }

  if (linked.length === 0) {
    return NextResponse.json({
      ok: true,
      checked: 0,
      updated: 0,
      status: null,
      message: 'No Stripe payments linked to this reservation.',
    });
  }

  const details: DetailRow[] = [];
  let updated = 0;
  let mutatedAdditional = false;
  let mutatedInvoices = false;
  const paymentsCopy = [...allPayments];
  const invoices = (await redis.get<RevenueInvoice[]>(REVENUE_INVOICES_KEY)) ?? [];
  const invoicesCopy = [...invoices];

  for (const p of linked) {
    const detail: DetailRow = {
      id: p.id,
      amountCzk: p.amountCzk,
      description: p.description,
      before: p.status,
      after: p.status,
      stripeStatus: null,
      changed: false,
    };

    if (p.status === 'paid' && p.stripeFeeCzk !== undefined) {
      // Already paid locally and fee already captured — skip Stripe call to save quota.
      // (If fee is missing on a paid record, fall through to fetch it as a backfill.)
      details.push(detail);
      continue;
    }

    // Expand to grab the Stripe processing fee in the same call (BalanceTransaction
    // sits at session → payment_intent → latest_charge → balance_transaction).
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(p.id, {
        expand: ['payment_intent.latest_charge.balance_transaction'],
      });
    } catch (err) {
      console.error('[check-payment] Stripe retrieve failed for', p.id, err);
      detail.stripeStatus = 'error';
      details.push(detail);
      continue;
    }

    detail.stripeStatus = session.payment_status ?? null;

    if (session.payment_status === 'paid') {
      // Extract fee (in haléř) → CZK. May be undefined if BalanceTransaction not yet ready.
      let stripeFeeCzk: number | undefined;
      const pi = session.payment_intent;
      if (pi && typeof pi !== 'string') {
        const charge = pi.latest_charge;
        if (charge && typeof charge !== 'string') {
          const bt = charge.balance_transaction;
          if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
            stripeFeeCzk = Math.round(bt.fee) / 100;
          }
        }
      }

      const idx = paymentsCopy.findIndex((x) => x.id === p.id);
      if (idx !== -1) {
        const wasUnpaid = p.status !== 'paid';
        if (wasUnpaid) {
          // Mirror the webhook: flip to paid + auto-create RevenueInvoice
          const paidAt = new Date().toISOString();
          const invoiceId = `pay-${p.id}`;
          paymentsCopy[idx] = {
            ...paymentsCopy[idx],
            status: 'paid',
            paidAt,
            invoiceId,
            ...(stripeFeeCzk !== undefined ? { stripeFeeCzk } : {}),
          };
          detail.after = 'paid';
          detail.changed = true;
          updated += 1;
          mutatedAdditional = true;

          const invoiceNumber = `PAY-${p.id.slice(-8).toUpperCase()}`;
          const alreadyExists = invoicesCopy.some((i) => i.id === invoiceId);
          if (!alreadyExists) {
            invoicesCopy.push({
              id: invoiceId,
              sourceType: 'issued',
              category: 'other_services',
              status: 'pending',
              invoiceNumber,
              invoiceDate: paidAt.slice(0, 10),
              amountCZK: p.amountCzk,
              reservationNumber: p.reservationNumber,
              guestName: p.guestName || p.guestEmail || undefined,
              description: p.description,
              createdAt: paidAt,
            });
            mutatedInvoices = true;
          }
        } else if (stripeFeeCzk !== undefined && p.stripeFeeCzk === undefined) {
          // Backfill: payment already marked paid but fee never captured.
          paymentsCopy[idx] = { ...paymentsCopy[idx], stripeFeeCzk };
          detail.changed = true;
          mutatedAdditional = true;
        }
      }
    }

    details.push(detail);
  }

  // Persist mutations atomically (best effort — Upstash has no transactions)
  const writes: Promise<unknown>[] = [];
  if (mutatedAdditional) writes.push(redis.set(ADDITIONAL_PAYMENTS_KEY, paymentsCopy));
  if (mutatedInvoices) writes.push(redis.set(REVENUE_INVOICES_KEY, invoicesCopy));
  if (writes.length > 0) {
    try {
      await Promise.all(writes);
    } catch (err) {
      console.error('[check-payment] Redis write failed:', err);
      return NextResponse.json(
        { error: 'Persist failed — payments may be in inconsistent state' },
        { status: 500 },
      );
    }
  }

  // Always recompute override at the end, even if no AdditionalPayment changed
  // (covers the case where webhook updated AdditionalPayment but reconcile failed)
  const reconcile = await recomputePaymentOverride(redis, reservationNumber);

  return NextResponse.json({
    ok: true,
    checked: linked.length,
    updated,
    status: reconcile.status,
    paidSum: reconcile.paidSum,
    bookingPrice: reconcile.bookingPrice,
    details,
  });
}
