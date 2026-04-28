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

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';
const REVENUE_INVOICES_KEY = 'baker:revenue-invoices';

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
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }

  const redis = getRedis();
  const allPayments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];

  const linked = allPayments.filter((p) => p.reservationNumber === reservationNumber);
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
