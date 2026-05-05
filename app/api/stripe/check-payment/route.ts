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
  // Optional context for the Direct/Direct-Web fallback. The more we have, the
  // higher the confidence on the auto-match.
  const checkInDate    = String(body?.checkInDate ?? '').trim();  // YYYY-MM-DD
  const guestEmail     = String(body?.guestEmail ?? '').trim().toLowerCase();
  const expectedAmount = typeof body?.expectedAmount === 'number' ? body.expectedAmount : undefined;
  // Manual override: operator pasted a Stripe session ID (cs_live_… / cs_test_…)
  // for direct linking. Bypasses the Redis lookup entirely.
  const manualSessionId = String(body?.sessionId ?? '').trim();

  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }

  const redis = getRedis();
  const allPayments = (await redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY)) ?? [];

  const linked = allPayments.filter((p) => p.reservationNumber === reservationNumber);

  // ── Direct/Direct-Web fallback: import a Stripe payment as a paid
  // AdditionalPayment so the fee rolls up into reservation.paymentChargeAmount.
  // Two ways to find it:
  //   1. Auto-match against baker:stripe-payments (scored by reservationNumber,
  //      check-in date, guest email, and amount)
  //   2. Manual: operator pasted a Stripe session ID — fetch it directly from
  //      Stripe, no Redis lookup
  // Either way, the resulting record is flagged isMainPayment=true so the
  // drawer shows it under "Booking Payment", not "Additional Payments".
  if (linked.length === 0 && (checkInDate || manualSessionId)) {
    let webSource:
      | { from: 'redis'; record: StripePaymentRecord }
      | { from: 'manual'; sessionId: string }
      | null = null;

    if (manualSessionId) {
      // Accept either a Checkout Session (cs_…) or a PaymentIntent (pi_…) — the
      // Stripe dashboard shows the PaymentIntent on payment detail pages, so
      // most operators will paste a pi_…. We resolve pi_… to its Checkout
      // Session when one exists; otherwise we'll work with the PaymentIntent
      // directly further down.
      if (manualSessionId.startsWith('cs_')) {
        webSource = { from: 'manual', sessionId: manualSessionId };
      } else if (manualSessionId.startsWith('pi_')) {
        try {
          const sessions = await stripe.checkout.sessions.list({
            payment_intent: manualSessionId,
            limit: 1,
          });
          if (sessions.data.length > 0) {
            // Found the originating Checkout Session — use the same flow as cs_…
            webSource = { from: 'manual', sessionId: sessions.data[0].id };
          } else {
            // No Checkout Session — operator probably means a direct charge
            // (Stripe dashboard manual charge, invoice payment, etc.). Handle
            // it as a PaymentIntent below.
            webSource = { from: 'manual', sessionId: manualSessionId };
          }
        } catch (err) {
          console.error('[check-payment] Stripe sessions.list failed for', manualSessionId, err);
          return NextResponse.json({
            error: 'Stripe could not look up that PaymentIntent. Double-check the ID.',
          }, { status: 502 });
        }
      } else {
        return NextResponse.json(
          { error: 'Invalid Stripe ID — expected "cs_…" (Checkout Session) or "pi_…" (PaymentIntent).' },
          { status: 400 },
        );
      }
    } else {
      // Auto-match: score every record and pick the best above threshold.
      // Threshold of 30 means at least one strong signal is required.
      const rawRecords = (await redis.get<StripePaymentRecord[]>(STRIPE_PAYMENTS_KEY)) ?? [];
      const scored = rawRecords
        .map((r) => {
          let score = 0;
          // Definitive: reservationNumber baked into Stripe metadata
          if (r.reservationNumber && r.reservationNumber === reservationNumber) score += 100;
          // Strong: guest email match (rental site captures customer_email)
          if (guestEmail && r.guestEmail?.toLowerCase() === guestEmail) score += 30;
          // Moderate: check-in date in description ("Web booking YYYY-MM-DD → …")
          if (checkInDate && r.description?.includes(checkInDate)) score += 30;
          // Moderate: amount within 1 Kč of expected
          if (typeof expectedAmount === 'number' && Math.abs(r.amountCzk - expectedAmount) <= 1) score += 30;
          return { r, score };
        })
        .filter((m) => m.score >= 30)
        .sort((a, b) => b.score - a.score);

      const best = scored[0];
      if (best) webSource = { from: 'redis', record: best.r };
    }

    if (!webSource) {
      return NextResponse.json({
        ok: true,
        checked: 0,
        updated: 0,
        status: null,
        message: 'No Stripe payments found for this reservation. Try linking the session ID manually.',
      });
    }

    const sessionId = webSource.from === 'redis' ? webSource.record.sessionId : webSource.sessionId;

    // Avoid double-import — if an AdditionalPayment with this sessionId already
    // exists (even on a different reservationNumber), skip creation.
    const existingByIdAnywhere = allPayments.find((p) => p.id === sessionId);
    if (existingByIdAnywhere) {
      return NextResponse.json({
        ok: true,
        checked: 1,
        updated: 0,
        status: null,
        message: `Stripe session already imported (linked to ${existingByIdAnywhere.reservationNumber}).`,
      });
    }

    // Fetch the Stripe session/PaymentIntent to get the fee + payment details
    let stripeFeeCzk: number | undefined;
    let stripePaymentStatus: string | null = null;
    let sessionAmountCzk = 0;
    let sessionEmail = '';
    let sessionName = '';
    let sessionDescription = '';
    let sessionPaidAt = new Date().toISOString();
    try {
      if (sessionId.startsWith('cs_')) {
        // Checkout Session path — has metadata, customer_details, and payment_intent
        const session = await stripe.checkout.sessions.retrieve(sessionId, {
          expand: ['payment_intent.latest_charge.balance_transaction'],
        });
        stripePaymentStatus = session.payment_status ?? null;
        sessionAmountCzk = typeof session.amount_total === 'number' ? session.amount_total / 100 : 0;
        sessionEmail = session.customer_email ?? session.customer_details?.email ?? '';
        sessionName = session.customer_details?.name ?? '';
        sessionDescription = (session.metadata?.description as string)
          || ((session.metadata?.arrival && session.metadata?.departure)
                ? `Web booking ${session.metadata.arrival} → ${session.metadata.departure}`
                : `Booking payment ${reservationNumber}`);

        const pi = session.payment_intent;
        if (pi && typeof pi !== 'string') {
          const charge = pi.latest_charge;
          if (charge && typeof charge !== 'string') {
            if (charge.created) sessionPaidAt = new Date(charge.created * 1000).toISOString();
            const bt = charge.balance_transaction;
            if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
              stripeFeeCzk = Math.round(bt.fee) / 100;
            }
          }
        }
      } else if (sessionId.startsWith('pi_')) {
        // PaymentIntent path — direct charge with no Checkout Session (manual
        // dashboard charge, invoice payment, etc.). Fetch the PaymentIntent
        // and pull amount + fee from its latest charge.
        const pi = await stripe.paymentIntents.retrieve(sessionId, {
          expand: ['latest_charge.balance_transaction'],
        });
        stripePaymentStatus = pi.status === 'succeeded' ? 'paid' : pi.status;
        sessionAmountCzk = typeof pi.amount === 'number' ? pi.amount / 100 : 0;
        sessionEmail = pi.receipt_email ?? '';
        sessionDescription = (pi.description as string)
          || (pi.metadata?.description as string)
          || `Booking payment ${reservationNumber}`;

        const charge = pi.latest_charge;
        if (charge && typeof charge !== 'string') {
          if (charge.created) sessionPaidAt = new Date(charge.created * 1000).toISOString();
          if (!sessionEmail) sessionEmail = charge.billing_details?.email ?? '';
          if (!sessionName) sessionName = charge.billing_details?.name ?? '';
          const bt = charge.balance_transaction;
          if (bt && typeof bt !== 'string' && typeof bt.fee === 'number') {
            stripeFeeCzk = Math.round(bt.fee) / 100;
          }
        }
      } else {
        // Should never hit this — guarded earlier — but keep for safety
        return NextResponse.json({ error: 'Unknown Stripe ID format.' }, { status: 400 });
      }

      if (stripePaymentStatus !== 'paid') {
        return NextResponse.json({
          ok: false,
          error: `Stripe payment is not in a paid state (status: ${stripePaymentStatus ?? 'unknown'}). Cannot import.`,
        }, { status: 400 });
      }
    } catch (err) {
      console.error('[check-payment] Stripe retrieve failed for', sessionId, err);
      return NextResponse.json({
        ok: false,
        error: webSource.from === 'manual'
          ? 'Stripe could not find that ID. Double-check the value (cs_… or pi_…).'
          : 'Could not retrieve Stripe session for fee lookup.',
      }, { status: 502 });
    }

    // Resolve final values — prefer Redis record fields when available, fall
    // back to live Stripe data (esp. for manual link where there's no Redis row)
    const finalAmount = webSource.from === 'redis' ? webSource.record.amountCzk : sessionAmountCzk;
    const finalEmail  = webSource.from === 'redis' ? webSource.record.guestEmail : sessionEmail;
    const finalName   = webSource.from === 'redis' ? webSource.record.guestName  : sessionName;
    const finalDesc   = webSource.from === 'redis' ? webSource.record.description : sessionDescription;
    const finalPaidAt = webSource.from === 'redis' ? webSource.record.paidAt : sessionPaidAt;

    // Create the AdditionalPayment record
    const newAp: AdditionalPayment = {
      id:                sessionId,
      reservationNumber: reservationNumber,
      description:       finalDesc || `Booking payment ${reservationNumber}`,
      amountCzk:         finalAmount,
      guestEmail:        finalEmail || undefined,
      guestName:         finalName  || undefined,
      status:            'paid',
      createdAt:         finalPaidAt,
      paidAt:            finalPaidAt,
      isMainPayment:     true,
      ...(stripeFeeCzk !== undefined ? { stripeFeeCzk } : {}),
    };

    // Auto-create the matching RevenueInvoice
    const invoiceId = `pay-${sessionId}`;
    const invoiceNumber = `PAY-${sessionId.slice(-8).toUpperCase()}`;
    const invoiceDate = finalPaidAt.slice(0, 10);
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
            amountCZK:         finalAmount,
            reservationNumber: reservationNumber,
            guestName:         finalName || finalEmail || undefined,
            description:       finalDesc,
            createdAt:         finalPaidAt,
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
        sessionId,
        amountCzk:           finalAmount,
        guestEmail:          finalEmail,
        paidAt:              finalPaidAt,
        description:         finalDesc,
        stripeFeeCzk,
        stripePaymentStatus,
      },
      manualLink: webSource.from === 'manual',
      message: stripeFeeCzk !== undefined
        ? `${webSource.from === 'manual' ? 'Linked' : 'Imported'} payment · fee ${stripeFeeCzk.toFixed(2)} Kč captured.`
        : `${webSource.from === 'manual' ? 'Linked' : 'Imported'} payment · Stripe fee not yet available (settlement pending). Try again in a few hours.`,
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
