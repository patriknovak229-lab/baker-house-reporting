import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import nodemailer from 'nodemailer';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { SplitPayment } from '@/types/splitPayment';

export const maxDuration = 60;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const SCHEDULED_KEY = 'baker:scheduled-split-payments';
const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';
const MAX_FAILURE_COUNT = 5;

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

async function sendPaymentEmail(args: {
  to: string;
  guestName?: string;
  description: string;
  amountCzk: number;
  paymentUrl: string;
  paymentNumber: number;
  totalPayments: number;
}): Promise<void> {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) {
    throw new Error('SMTP not configured (SMTP_USER / SMTP_PASS missing)');
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });

  const from = process.env.SMTP_FROM
    ? `"Baker House Apartments" <${process.env.SMTP_FROM}>`
    : `"Baker House Apartments" <${smtpUser}>`;

  const greeting = args.guestName ? `Dear ${args.guestName},` : 'Dear guest,';
  const amountLabel = `${Math.round(args.amountCzk).toLocaleString('cs-CZ')} Kč`;
  const splitNote = `This is payment ${args.paymentNumber} of ${args.totalPayments} for your booking.`;

  const text = [
    greeting,
    '',
    splitNote,
    `Amount: ${amountLabel}`,
    '',
    'Please complete your payment using the secure link below:',
    args.paymentUrl,
    '',
    'The link is valid for 23 hours — please complete the payment today.',
    '',
    'Thank you,',
    'Patrik & Zuzana',
    'Baker House Apartments',
    'https://www.bakerhouseapartments.cz',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <p>${greeting}</p>
      <p>${splitNote}</p>
      <p>Amount: <strong>${amountLabel}</strong></p>
      <p style="margin:24px 0">
        <a href="${args.paymentUrl}"
           style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">
          Pay now
        </a>
      </p>
      <p style="font-size:13px;color:#666">Or copy this link: <a href="${args.paymentUrl}">${args.paymentUrl}</a></p>
      <p style="font-size:12px;color:#999">This link is valid for 23 hours — please complete the payment today.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:13px;color:#666">Patrik &amp; Zuzana<br/>Baker House Apartments</p>
    </div>
  `;

  await transporter.sendMail({
    from,
    to: args.to,
    subject: `Payment ${args.paymentNumber}/${args.totalPayments} — ${args.description}`,
    text,
    html,
  });
}

/**
 * POST /api/cron/send-scheduled-payments
 *
 * Daily cron — finds SplitPayment rows where status="scheduled" and sendDate <= today.
 * For each:
 *   1. Mints a Stripe Checkout session (23h validity)
 *   2. Emails the link to the guest
 *   3. Creates a parallel AdditionalPayment record (so the existing webhook flow handles "paid" updates)
 *   4. Flips the SplitPayment row to status="sent"
 *
 * On any failure: increment failureCount and store failureReason. Row stays "scheduled" → retried tomorrow.
 * After MAX_FAILURE_COUNT attempts, row is marked "failed" so it stops retrying.
 *
 * Auth:
 *   - Vercel cron requests carry "x-vercel-cron: 1" header — accepted without session.
 *   - Otherwise requires admin/super (manual trigger from dashboard for testing).
 */
export async function POST(req: NextRequest) {
  const isCron = req.headers.get('x-vercel-cron') === '1';
  if (!isCron) {
    const authResult = await requireRole(['admin', 'super']);
    if ('error' in authResult) return authResult.error;
  }

  const redis = getRedis();
  const today = todayUTC();
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz';

  const [scheduled, additional] = await Promise.all([
    redis.get<SplitPayment[]>(SCHEDULED_KEY).then((v) => v ?? []),
    redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY).then((v) => v ?? []),
  ]);

  const due = scheduled.filter((sp) => sp.status === 'scheduled' && sp.sendDate <= today);

  let succeeded = 0;
  let failed = 0;
  const errors: { id: string; reason: string }[] = [];

  // Mutate the scheduled array in place (we'll write back at the end)
  const additionalNew: AdditionalPayment[] = [...additional];

  for (const sp of due) {
    try {
      if (!sp.guestEmail?.trim()) {
        throw new Error('No guest email on record — cannot send payment link');
      }

      // 1. Mint Stripe session
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'czk',
              unit_amount: Math.round(sp.amountCzk * 100),
              product_data: { name: sp.description },
            },
            quantity: 1,
          },
        ],
        success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${baseUrl}/payment-success?cancelled=1`,
        customer_email: sp.guestEmail,
        expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60,
        metadata: {
          description: sp.description,
          guestEmail: sp.guestEmail,
          guestPhone: sp.guestPhone ?? '',
          amountCzk: String(sp.amountCzk),
          reservationNumber: sp.reservationNumber,
          guestName: sp.guestName ?? '',
          paymentNumber: String(sp.paymentNumber),
          totalPayments: String(sp.totalPayments),
          splitPayment: 'true',
        },
      });

      if (!session.url) throw new Error('Stripe returned no checkout URL');

      // 2. Email guest
      await sendPaymentEmail({
        to: sp.guestEmail,
        guestName: sp.guestName,
        description: sp.description,
        amountCzk: sp.amountCzk,
        paymentUrl: session.url,
        paymentNumber: sp.paymentNumber,
        totalPayments: sp.totalPayments,
      });

      // 3. Create AdditionalPayment record
      additionalNew.push({
        id: session.id,
        reservationNumber: sp.reservationNumber,
        description: sp.description,
        amountCzk: sp.amountCzk,
        guestEmail: sp.guestEmail,
        guestName: sp.guestName,
        status: 'unpaid',
        createdAt: new Date().toISOString(),
      });

      // 4. Flip SplitPayment to "sent" (mutate in place; we wrote a copy by reference)
      sp.status = 'sent';
      sp.stripeSessionId = session.id;
      sp.sentAt = new Date().toISOString();
      delete sp.failureReason;

      succeeded += 1;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[cron/send-scheduled-payments] Failed ${sp.id} (${sp.reservationNumber}, P${sp.paymentNumber}/${sp.totalPayments}):`, reason);
      sp.failureReason = reason;
      sp.failureCount = (sp.failureCount ?? 0) + 1;
      if (sp.failureCount >= MAX_FAILURE_COUNT) {
        sp.status = 'failed';
      }
      failed += 1;
      errors.push({ id: sp.id, reason });
    }
  }

  // Persist updated arrays (scheduled was mutated in place, so updates are reflected)
  try {
    await Promise.all([
      redis.set(SCHEDULED_KEY, scheduled),
      additionalNew.length !== additional.length
        ? redis.set(ADDITIONAL_PAYMENTS_KEY, additionalNew)
        : Promise.resolve(),
    ]);
  } catch (err) {
    console.error('[cron/send-scheduled-payments] Redis write failed:', err);
    return NextResponse.json(
      { error: 'Persist failed', succeeded, failed, errors },
      { status: 500 },
    );
  }

  return NextResponse.json({
    processed: due.length,
    succeeded,
    failed,
    errors: errors.length > 0 ? errors : undefined,
    today,
  });
}
