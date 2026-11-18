/**
 * Server-only: create a Stripe Checkout link for one or more bookings, and
 * email it. Shared by POST /api/stripe/payment-link (operator, now) and the
 * scheduled-link cron (later), so both produce the same session shape and the
 * webhook treats them alike.
 */
import Stripe from 'stripe';
import nodemailer from 'nodemailer';
import type { AdditionalPayment, PaymentAllocation } from '@/types/additionalPayment';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

/** Stripe's maximum is 24 h; 23 h leaves room for clock skew. */
export const LINK_VALID_HOURS = 23;

export interface LinkInput {
  description: string;
  /** One entry = a single booking; 2+ = one payment for a linked stay. */
  allocations: PaymentAllocation[];
  guestEmail?: string;
  guestPhone?: string;
  guestName?: string;
  isMainPayment?: boolean;
  /** Extra metadata (e.g. scheduledLinkId). */
  meta?: Record<string, string>;
}

export interface CreatedLink {
  url: string;
  payment: AdditionalPayment;
}

/**
 * Mint the Checkout session and build the matching unpaid AdditionalPayment
 * (NOT saved — the caller stores it). A combined payment shows one line per
 * booking so the guest sees what they pay for.
 */
export async function createPaymentLink(input: LinkInput): Promise<CreatedLink> {
  const allocations = input.allocations.map((a) => ({ reservationNumber: a.reservationNumber.trim(), amountCzk: Math.round(a.amountCzk * 100) / 100 }));
  const amountCzk = Math.round(allocations.reduce((s, a) => s + a.amountCzk, 0) * 100) / 100;
  const combined = allocations.length > 1;
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz';
  const description = input.description.trim();

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    line_items: (combined ? allocations : [{ reservationNumber: '', amountCzk }]).map((a) => ({
      price_data: {
        currency: 'czk',
        unit_amount: Math.round(a.amountCzk * 100), // haléře
        product_data: { name: a.reservationNumber ? `${description} — ${a.reservationNumber}` : description },
      },
      quantity: 1,
    })),
    success_url: `${baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${baseUrl}/payment-success?cancelled=1`,
    customer_email: input.guestEmail || undefined,
    expires_at: Math.floor(Date.now() / 1000) + LINK_VALID_HOURS * 60 * 60,
    metadata: {
      description,
      guestEmail: input.guestEmail ?? '',
      guestPhone: input.guestPhone ?? '',
      amountCzk: String(amountCzk),
      // The webhook keys on this; the full split lives on the AdditionalPayment.
      reservationNumber: allocations[0]?.reservationNumber ?? '',
      guestName: input.guestName ?? '',
      ...(combined ? { reservationNumbers: allocations.map((a) => a.reservationNumber).join(',') } : {}),
      ...(input.meta ?? {}),
    },
  });
  if (!session.url) throw new Error('Stripe returned no checkout URL');

  const payment: AdditionalPayment = {
    id: session.id,
    reservationNumber: allocations[0].reservationNumber,
    description,
    amountCzk,
    guestEmail: input.guestEmail || undefined,
    guestName: input.guestName || undefined,
    status: 'unpaid',
    createdAt: new Date().toISOString(),
    ...(input.isMainPayment ? { isMainPayment: true } : {}),
    ...(combined ? { allocations } : {}),
  };
  return { url: session.url, payment };
}

/** Expire an open Checkout session so an old link can't be paid after a new one went out. Best-effort. */
export async function expireCheckoutSession(sessionId: string): Promise<void> {
  try {
    const s = await stripe.checkout.sessions.retrieve(sessionId);
    if (s.status === 'open') await stripe.checkout.sessions.expire(sessionId);
  } catch (err) {
    console.warn('[paymentLinkServer] expire failed for', sessionId, err);
  }
}

/** Has this Checkout session been paid? (Backstop for a missed webhook.) */
export async function isSessionPaid(sessionId: string): Promise<boolean> {
  const s = await stripe.checkout.sessions.retrieve(sessionId);
  return s.payment_status === 'paid';
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Email a payment link to the guest. `reminder` changes the wording only. */
export async function emailPaymentLink(args: {
  to: string;
  guestName?: string;
  description: string;
  amountCzk: number;
  url: string;
  reminder?: boolean;
}): Promise<void> {
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpUser || !smtpPass) throw new Error('SMTP not configured (SMTP_USER / SMTP_PASS missing)');

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT ?? '587'),
    secure: false,
    auth: { user: smtpUser, pass: smtpPass },
  });
  const from = `"Baker House Apartments" <${process.env.SMTP_FROM ?? smtpUser}>`;

  const greeting = args.guestName ? `Dear ${args.guestName},` : 'Dear guest,';
  const amountLabel = `${Math.round(args.amountCzk).toLocaleString('cs-CZ')} Kč`;
  const intro = args.reminder
    ? `This is a friendly reminder that the payment for your stay is still open: ${args.description}.`
    : `We have prepared a payment request for you: ${args.description}.`;
  const validity = 'The link is valid for 23 hours — please complete the payment today.';

  const text = [
    greeting, '', intro, `Amount: ${amountLabel}`, '',
    'Please complete your payment using the secure link below:', args.url, '', validity, '',
    'Thank you,', 'Patrik & Zuzana', 'Baker House Apartments', 'https://www.bakerhouseapartments.cz',
  ].join('\n');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a">
      <p>${esc(greeting)}</p>
      <p>${esc(intro)}</p>
      <p>Amount: <strong>${amountLabel}</strong></p>
      <p style="margin:24px 0">
        <a href="${args.url}" style="background:#4f46e5;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Pay now</a>
      </p>
      <p style="font-size:13px;color:#666">Or copy this link: <a href="${args.url}">${args.url}</a></p>
      <p style="font-size:12px;color:#999">${validity}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0"/>
      <p style="font-size:13px;color:#666">Patrik &amp; Zuzana<br/>Baker House Apartments</p>
    </div>`;

  await transporter.sendMail({
    from,
    to: args.to,
    subject: `${args.reminder ? 'Reminder: payment' : 'Payment request'} — ${args.description} · Baker House Apartments`,
    text,
    html,
  });
}
