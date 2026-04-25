import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { AdditionalPayment } from '@/types/additionalPayment';
import type { SplitPayment } from '@/types/splitPayment';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

const SCHEDULED_KEY = 'baker:scheduled-split-payments';
const ADDITIONAL_PAYMENTS_KEY = 'baker:additional-payments';

function getRedis(): Redis {
  return new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });
}

/** YYYY-MM-DD in UTC. */
function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Generate a stable random ID. */
function generateId(): string {
  return `sp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface PaymentInput {
  paymentNumber: number;       // 1, 2, 3
  totalPayments: number;       // total count in this split
  amountCzk: number;
  sendDate: string;            // YYYY-MM-DD
}

interface BodyShape {
  reservationNumber: string;
  guestEmail?: string;
  guestPhone?: string;
  guestName?: string;
  payments: PaymentInput[];
}

/**
 * Mint a Stripe Checkout session for a single split payment.
 * Returns the session URL + ID, or throws on failure.
 */
async function mintCheckoutSession(args: {
  description: string;
  amountCzk: number;
  guestEmail?: string;
  reservationNumber: string;
  guestName?: string;
  guestPhone?: string;
  paymentNumber: number;
  totalPayments: number;
}): Promise<{ url: string; id: string }> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz';

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'czk',
          unit_amount: Math.round(args.amountCzk * 100),
          product_data: { name: args.description },
        },
        quantity: 1,
      },
    ],
    success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/payment-success?cancelled=1`,
    customer_email: args.guestEmail || undefined,
    expires_at: Math.floor(Date.now() / 1000) + 23 * 60 * 60, // 23h (Stripe max is 24h)
    metadata: {
      description: args.description,
      guestEmail: args.guestEmail ?? '',
      guestPhone: args.guestPhone ?? '',
      amountCzk: String(args.amountCzk),
      reservationNumber: args.reservationNumber,
      guestName: args.guestName ?? '',
      paymentNumber: String(args.paymentNumber),
      totalPayments: String(args.totalPayments),
      splitPayment: 'true',
    },
  });

  if (!session.url) throw new Error('Stripe returned no checkout URL');
  return { url: session.url, id: session.id };
}

/**
 * POST /api/stripe/split-payments
 * Create a batch of split payments for a reservation.
 *
 * For each payment whose sendDate is today (or before): mint a Stripe Checkout session immediately
 * and create a parallel AdditionalPayment record.  Operator gets the URL back to send via
 * WhatsApp / copy.
 *
 * For each payment whose sendDate is in the future: just store a SplitPayment row with status="scheduled".
 * The daily cron will mint sessions + email guests on the day.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super']);
  if ('error' in authResult) return authResult.error;

  const body = (await req.json()) as BodyShape;
  const { reservationNumber, guestEmail, guestPhone, guestName, payments } = body;

  if (!reservationNumber?.trim()) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }
  if (!Array.isArray(payments) || payments.length < 1 || payments.length > 3) {
    return NextResponse.json({ error: 'payments must be 1–3 entries' }, { status: 400 });
  }
  for (const p of payments) {
    if (!p.amountCzk || p.amountCzk < 1) {
      return NextResponse.json({ error: `payment ${p.paymentNumber}: amount must be at least 1` }, { status: 400 });
    }
    if (!p.sendDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.sendDate)) {
      return NextResponse.json({ error: `payment ${p.paymentNumber}: invalid sendDate` }, { status: 400 });
    }
  }

  const today = todayUTC();
  const redis = getRedis();
  const createdAt = new Date().toISOString();

  // Read existing collections once
  const [scheduled, additional] = await Promise.all([
    redis.get<SplitPayment[]>(SCHEDULED_KEY).then((v) => v ?? []),
    redis.get<AdditionalPayment[]>(ADDITIONAL_PAYMENTS_KEY).then((v) => v ?? []),
  ]);

  type ResultRow = {
    id: string;
    paymentNumber: number;
    totalPayments: number;
    amountCzk: number;
    sendDate: string;
    status: 'sent' | 'scheduled';
    url?: string;
  };
  const results: ResultRow[] = [];
  const newScheduled: SplitPayment[] = [];
  const newAdditional: AdditionalPayment[] = [];

  for (const p of payments) {
    const description = `Baker House — reservation ${reservationNumber} — Payment ${p.paymentNumber} of ${p.totalPayments}`;
    const isImmediate = p.sendDate <= today;
    const id = generateId();

    if (isImmediate) {
      // Mint Stripe session NOW so operator can copy/WhatsApp the link from the modal
      try {
        const { url, id: sessionId } = await mintCheckoutSession({
          description,
          amountCzk: p.amountCzk,
          guestEmail,
          guestPhone,
          guestName,
          reservationNumber,
          paymentNumber: p.paymentNumber,
          totalPayments: p.totalPayments,
        });

        const splitRecord: SplitPayment = {
          id,
          reservationNumber,
          paymentNumber: p.paymentNumber,
          totalPayments: p.totalPayments,
          description,
          amountCzk: p.amountCzk,
          sendDate: p.sendDate,
          guestEmail,
          guestPhone,
          guestName,
          status: 'sent',
          stripeSessionId: sessionId,
          sentAt: createdAt,
          createdAt,
        };
        newScheduled.push(splitRecord);

        const apRecord: AdditionalPayment = {
          id: sessionId,
          reservationNumber,
          description,
          amountCzk: p.amountCzk,
          guestEmail: guestEmail || undefined,
          guestName: guestName || undefined,
          status: 'unpaid',
          createdAt,
        };
        newAdditional.push(apRecord);

        results.push({
          id,
          paymentNumber: p.paymentNumber,
          totalPayments: p.totalPayments,
          amountCzk: p.amountCzk,
          sendDate: p.sendDate,
          status: 'sent',
          url,
        });
      } catch (err) {
        // Couldn't mint Stripe session for an immediate payment — bail out
        console.error('[split-payments] Failed to mint immediate Stripe session:', err);
        return NextResponse.json(
          {
            error: `Failed to create Stripe link for payment ${p.paymentNumber}: ${
              err instanceof Error ? err.message : 'unknown error'
            }`,
          },
          { status: 502 },
        );
      }
    } else {
      // Future payment — store as scheduled
      const splitRecord: SplitPayment = {
        id,
        reservationNumber,
        paymentNumber: p.paymentNumber,
        totalPayments: p.totalPayments,
        description,
        amountCzk: p.amountCzk,
        sendDate: p.sendDate,
        guestEmail,
        guestPhone,
        guestName,
        status: 'scheduled',
        createdAt,
      };
      newScheduled.push(splitRecord);

      results.push({
        id,
        paymentNumber: p.paymentNumber,
        totalPayments: p.totalPayments,
        amountCzk: p.amountCzk,
        sendDate: p.sendDate,
        status: 'scheduled',
      });
    }
  }

  // Persist atomically (best effort — Upstash doesn't have transactions, but two SETs are quick)
  try {
    await Promise.all([
      redis.set(SCHEDULED_KEY, [...scheduled, ...newScheduled]),
      newAdditional.length > 0
        ? redis.set(ADDITIONAL_PAYMENTS_KEY, [...additional, ...newAdditional])
        : Promise.resolve(),
    ]);
  } catch (err) {
    console.error('[split-payments] Redis write failed:', err);
    return NextResponse.json(
      { error: 'Stripe sessions created but DB write failed — check logs' },
      { status: 500 },
    );
  }

  return NextResponse.json({ payments: results });
}

/**
 * GET /api/stripe/split-payments?reservationNumber=BH-12345
 * Lists all SplitPayment records for a reservation.
 */
export async function GET(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super', 'viewer', 'accountant']);
  if ('error' in authResult) return authResult.error;

  const reservationNumber = req.nextUrl.searchParams.get('reservationNumber');
  if (!reservationNumber) {
    return NextResponse.json({ error: 'reservationNumber is required' }, { status: 400 });
  }

  const redis = getRedis();
  const all = (await redis.get<SplitPayment[]>(SCHEDULED_KEY)) ?? [];
  const filtered = all
    .filter((sp) => sp.reservationNumber === reservationNumber)
    .sort((a, b) => a.paymentNumber - b.paymentNumber);
  return NextResponse.json({ payments: filtered });
}
