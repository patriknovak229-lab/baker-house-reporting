/**
 * Refunding a website booking's Stripe checkout from the drawer — the
 * orchestration, with every I/O injected (`WebPaymentDeps`) so it can be tested
 * without Stripe or the database. Real dependencies: utils/webPaymentDeps.ts.
 * Pure rules (matching, refund maths, recording): utils/webPaymentRefund.ts.
 *
 * Money moves in exactly one place — `refundWebPayment` → `stripe.createRefund`
 * — and only after the link, the booking and the live Stripe balance of the
 * charge have been re-checked on the server. Recording the refund on the booking
 * (`platformRefund`) happens right after; if that step fails the refund still
 * stands and the drawer offers "Record" for it (deduped by Stripe refund id).
 */
import type { PlatformRefund, PlatformRefundStripeEntry } from "@/types/reservation";
import { escapeHtml } from "@/utils/telegram";
import {
  countsAsRefunded,
  halToCzk,
  mergeStripeRefund,
  parseRefundAmount,
  recordedButFailed,
  refundableHal,
  resolveWebPayment,
  unrecordedRefunds,
  type StripeRefundLite,
  type WebBookingFacts,
  type WebCheckout,
  type WebPaymentLink,
} from "@/utils/webPaymentRefund";

export interface StripeChargeLite {
  id: string;
  amountHal: number;
  amountRefundedHal: number;
  currency: string;
}

export interface StripeSessionLite {
  id: string;
  paymentStatus: string;     // paid | unpaid | no_payment_required
  currency: string;
  charge: StripeChargeLite | null;
}

export interface WebPaymentStripe {
  retrieveSession(sessionId: string): Promise<StripeSessionLite>;
  listRefunds(chargeId: string): Promise<StripeRefundLite[]>;
  createRefund(
    input: { chargeId: string; amountHal: number; metadata: Record<string, string> },
    idempotencyKey: string,
  ): Promise<StripeRefundLite>;
}

/** How the platform refund was persisted */
export type RecordOutcome =
  | { mode: "server"; written: boolean; platformRefund: PlatformRefund | null }
  /** This store mode can't take a per-row write — the drawer saves it like a manual edit */
  | { mode: "client" };

export interface WebPaymentDeps {
  loadBooking(reservationNumber: string): Promise<WebBookingFacts | null>;
  loadSameGuestBookings(email: string): Promise<WebBookingFacts[]>;
  loadCheckouts(): Promise<WebCheckout[]>;
  loadOverlay(reservationNumber: string): Promise<{ platformRefund?: PlatformRefund | null; nonArrival?: unknown } | null>;
  /** Reservation an AdditionalPayment with this session id belongs to, if any */
  additionalPaymentOwner(sessionId: string): Promise<string | null>;
  /** null when STRIPE_SECRET_KEY isn't configured */
  stripe: WebPaymentStripe | null;
  recordPlatformRefund(
    reservationNumber: string,
    merge: (existing: PlatformRefund | null) => PlatformRefund | null,
  ): Promise<RecordOutcome>;
  notify(html: string): Promise<void>;
  /** YYYY-MM-DD in Prague */
  pragueDate(unixSeconds?: number): string;
  nowIso(): string;
}

export class WebPaymentError extends Error {
  constructor(public status: number, message: string, public extra?: Record<string, unknown>) {
    super(message);
  }
}

export interface RefundView {
  id: string;
  amountCzk: number;
  status: string;
  date: string;          // YYYY-MM-DD Prague
  fromApp: boolean;      // created by this app (refund metadata)
}

export interface WebPaymentState {
  reservationNumber: string;
  link: WebPaymentLink;
  /** Why the refund button isn't offered (still shows what's known) */
  blocked?: string;
  stripe?: {
    sessionId: string;
    chargeId: string;
    paidCzk: number;
    refundedCzk: number;
    refundableCzk: number;
    refunds: RefundView[];
  };
  stripeError?: string;
  recordedCzk: number;
  /** Stripe refunds the booking doesn't count yet — offered as "Record" */
  unrecorded: RefundView[];
  /** Counted on the booking but Stripe says failed / canceled */
  failedButRecorded: RefundView[];
}

const SOURCE = "reporting-web-refund";
const fmt = (czk: number) => `${czk.toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;

function view(deps: WebPaymentDeps, r: StripeRefundLite): RefundView {
  return {
    id: r.id,
    amountCzk: halToCzk(r.amountHal),
    status: r.status,
    date: deps.pragueDate(r.created),
    fromApp: r.metadata?.source === SOURCE,
  };
}

interface Resolved {
  booking: WebBookingFacts;
  overlay: { platformRefund?: PlatformRefund | null; nonArrival?: unknown } | null;
  link: WebPaymentLink;
  blocked?: string;
}

async function resolve(deps: WebPaymentDeps, reservationNumber: string): Promise<Resolved> {
  const booking = await deps.loadBooking(reservationNumber);
  if (!booking) throw new WebPaymentError(404, `${reservationNumber} isn't in the bookings archive`);
  if (booking.channel !== "Direct-Web") throw new WebPaymentError(400, "Only website (Direct-Web) bookings are paid by a web checkout");

  const [overlay, checkouts, sameGuest] = await Promise.all([
    deps.loadOverlay(reservationNumber),
    deps.loadCheckouts(),
    booking.email ? deps.loadSameGuestBookings(booking.email) : Promise.resolve([]),
  ]);
  let link = resolveWebPayment(booking, checkouts, sameGuest);
  if (link.status === "linked") {
    const owner = await deps.additionalPaymentOwner(link.checkout.sessionId);
    if (owner && owner !== reservationNumber) {
      link = { status: "ambiguous", reason: `That payment is already linked to ${owner} as a payment` };
    }
  }

  let blocked: string | undefined;
  if (booking.isCancelled) blocked = "Cancelled booking — refund it in the Stripe Dashboard";
  else if (overlay?.nonArrival) blocked = "Marked as non-arrival — its retained price already nets any refund";
  else if (link.status !== "linked") blocked = link.reason;
  else if (!deps.stripe) blocked = "Stripe isn't configured on this server";

  return { booking, overlay, link, blocked };
}

async function loadCharge(deps: WebPaymentDeps, sessionId: string) {
  const stripe = deps.stripe;
  if (!stripe) throw new WebPaymentError(503, "Stripe isn't configured on this server");
  const session = await stripe.retrieveSession(sessionId);
  if (session.id !== sessionId) throw new WebPaymentError(502, "Stripe returned a different checkout session");
  if (session.paymentStatus !== "paid") throw new WebPaymentError(400, `The checkout isn't paid (Stripe: ${session.paymentStatus})`);
  if (session.currency.toLowerCase() !== "czk" || !session.charge || session.charge.currency.toLowerCase() !== "czk") {
    throw new WebPaymentError(400, "The checkout has no CZK charge to refund");
  }
  const refunds = await stripe.listRefunds(session.charge.id);
  return { stripe, charge: session.charge, refunds };
}

export async function getWebPaymentState(deps: WebPaymentDeps, reservationNumber: string): Promise<WebPaymentState> {
  const { overlay, link, blocked } = await resolve(deps, reservationNumber);
  const pr = overlay?.platformRefund ?? null;
  const state: WebPaymentState = {
    reservationNumber,
    link,
    blocked,
    recordedCzk: pr?.amountCzk ?? 0,
    unrecorded: [],
    failedButRecorded: [],
  };
  if (link.status !== "linked" || !deps.stripe) return state;

  try {
    const { charge, refunds } = await loadCharge(deps, link.checkout.sessionId);
    const refundable = refundableHal(charge.amountHal, charge.amountRefundedHal, refunds);
    state.stripe = {
      sessionId: link.checkout.sessionId,
      chargeId: charge.id,
      paidCzk: halToCzk(charge.amountHal),
      refundedCzk: halToCzk(charge.amountHal - refundable),
      refundableCzk: halToCzk(refundable),
      refunds: refunds.map((r) => view(deps, r)),
    };
    state.unrecorded = unrecordedRefunds(refunds, pr).map((r) => view(deps, r));
    state.failedButRecorded = recordedButFailed(refunds, pr).map((r) => view(deps, r));
  } catch (err) {
    state.stripeError = err instanceof Error ? err.message : "Stripe lookup failed";
  }
  return state;
}

export interface RefundResult {
  refund: RefundView;
  entry: PlatformRefundStripeEntry;
  /** server = written here; client = the drawer must save it; failed = see recordError */
  recorded: "server" | "already" | "client" | "failed";
  platformRefund: PlatformRefund | null;
  recordError?: string;
  remainingRefundableCzk: number;
}

async function record(
  deps: WebPaymentDeps,
  booking: WebBookingFacts,
  entry: PlatformRefundStripeEntry,
  reason: string | undefined,
): Promise<Pick<RefundResult, "recorded" | "platformRefund" | "recordError">> {
  try {
    const out = await deps.recordPlatformRefund(booking.reservationNumber, (existing) =>
      mergeStripeRefund(existing, entry, { priceCzk: booking.price, nowIso: deps.nowIso(), reason }));
    if (out.mode === "client") return { recorded: "client", platformRefund: null };
    return { recorded: out.written ? "server" : "already", platformRefund: out.platformRefund };
  } catch (err) {
    console.error("[web-payment] recording the refund failed:", err);
    return { recorded: "failed", platformRefund: null, recordError: err instanceof Error ? err.message : "Recording failed" };
  }
}

function recordLine(recorded: RefundResult["recorded"]): string {
  switch (recorded) {
    case "server": return "📒 Recorded on the booking ✅";
    case "already": return "📒 Already recorded on the booking ✅";
    case "client": return "📒 Recorded from the drawer";
    case "failed": return "⚠️ NOT recorded on the booking — use “Record” in the drawer";
  }
}

export async function refundWebPayment(
  deps: WebPaymentDeps,
  input: { reservationNumber: string; sessionId: string; amountCzk: unknown; reason?: string; idempotencyKey: string; operator: string },
): Promise<RefundResult> {
  const amount = parseRefundAmount(input.amountCzk);
  if ("error" in amount) throw new WebPaymentError(400, amount.error);
  if (!/^[\w-]{8,100}$/.test(input.idempotencyKey ?? "")) throw new WebPaymentError(400, "idempotencyKey is required");
  const reason = input.reason?.trim().slice(0, 300) || undefined;

  const { booking, link, blocked } = await resolve(deps, input.reservationNumber);
  if (blocked) throw new WebPaymentError(409, blocked);
  if (link.status !== "linked" || link.checkout.sessionId !== input.sessionId) {
    throw new WebPaymentError(409, "The payment shown is no longer the one tied to this booking — reload the drawer");
  }

  const { stripe, charge, refunds } = await loadCharge(deps, input.sessionId);

  // A retry of a request that already reached Stripe (lost response, double
  // submit): finish recording that refund instead of creating another one.
  let refund = refunds.find((r) => r.metadata?.idempotencyKey === input.idempotencyKey);
  if (!refund) {
    const refundable = refundableHal(charge.amountHal, charge.amountRefundedHal, refunds);
    if (amount.hal > refundable) {
      throw new WebPaymentError(400, `At most ${fmt(halToCzk(refundable))} can still be refunded`, { refundableCzk: halToCzk(refundable) });
    }
    try {
      refund = await stripe.createRefund({
        chargeId: charge.id,
        amountHal: amount.hal,
        metadata: {
          source: SOURCE,
          reservationNumber: booking.reservationNumber,
          sessionId: input.sessionId,
          operatorEmail: input.operator,
          idempotencyKey: input.idempotencyKey,
          ...(reason ? { operatorNote: reason } : {}),
        },
      }, `web-refund-${input.idempotencyKey}`);
    } catch (err) {
      console.error("[web-payment] stripe refund failed:", err);
      throw new WebPaymentError(502, err instanceof Error ? `Stripe: ${err.message}` : "Stripe refund failed");
    }
  }
  if (!countsAsRefunded(refund)) {
    throw new WebPaymentError(502, `Stripe did not refund (status: ${refund.status})`);
  }

  const entry: PlatformRefundStripeEntry = {
    id: refund.id,
    sessionId: input.sessionId,
    amountCzk: halToCzk(refund.amountHal),
    refundedAt: deps.pragueDate(refund.created),
    by: input.operator,
  };
  const rec = await record(deps, booking, entry, reason);
  // Refunds listed before ours, plus ours (an idempotent replay returns it again)
  const others = refunds.filter((r) => r.id !== refund.id);
  const remaining = refundableHal(charge.amountHal, 0, [...others, refund]);

  await deps.notify([
    "↩️ <b>Web booking refund</b>",
    `🏨 ${booking.reservationNumber}`,
    `💰 ${fmt(entry.amountCzk)} of ${fmt(halToCzk(charge.amountHal))} (Stripe: ${escapeHtml(refund.status)})`,
    recordLine(rec.recorded),
    reason ? `🗒 ${escapeHtml(reason)}` : "",
    `👤 by ${escapeHtml(input.operator)}`,
  ].filter(Boolean).join("\n")).catch(() => undefined);

  return { refund: view(deps, refund), entry, ...rec, remainingRefundableCzk: halToCzk(remaining) };
}

/**
 * Count a refund that exists in Stripe (made in the Dashboard, or whose
 * recording step failed) on the booking. Moves no money.
 */
export async function recordExistingRefund(
  deps: WebPaymentDeps,
  input: { reservationNumber: string; refundId: string; operator: string },
): Promise<Omit<RefundResult, "remainingRefundableCzk">> {
  const { booking, link, blocked } = await resolve(deps, input.reservationNumber);
  if (blocked) throw new WebPaymentError(409, blocked);
  if (link.status !== "linked") throw new WebPaymentError(409, link.reason);

  const { refunds } = await loadCharge(deps, link.checkout.sessionId);
  const refund = refunds.find((r) => r.id === input.refundId);
  if (!refund) throw new WebPaymentError(404, "That refund isn't on this booking's payment");
  if (!countsAsRefunded(refund)) throw new WebPaymentError(400, `Stripe reports that refund as ${refund.status}`);

  const entry: PlatformRefundStripeEntry = {
    id: refund.id,
    sessionId: link.checkout.sessionId,
    amountCzk: halToCzk(refund.amountHal),
    refundedAt: deps.pragueDate(refund.created),
    by: input.operator,
  };
  const reason = refund.metadata?.operatorNote?.trim() || undefined;
  const rec = await record(deps, booking, entry, reason);

  if (rec.recorded === "server" || rec.recorded === "client") {
    await deps.notify([
      "📒 <b>Web booking refund recorded</b>",
      `🏨 ${booking.reservationNumber}`,
      `💰 ${fmt(entry.amountCzk)} refunded in Stripe on ${entry.refundedAt}`,
      `👤 by ${escapeHtml(input.operator)}`,
    ].join("\n")).catch(() => undefined);
  }
  return { refund: view(deps, refund), entry, ...rec };
}
