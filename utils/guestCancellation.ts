/**
 * Guest cancellation of a DIRECT booking — the operator-side "Guest
 * Cancellation" button for guests who cancel by phone, WhatsApp or email.
 * Admin only.
 *
 * Shared by the drawer modal (components/transactions/GuestCancellation.tsx)
 * and the server route (app/api/bookings/guest-cancel). Pure — no I/O.
 *
 * How the booking was paid decides what a refund means:
 *
 *   Stripe (website checkout and/or payment link)
 *     full    → refund everything still refundable, automatically, now
 *     partial → refund the typed amount, automatically, now
 *     policy  → no automatic refund; a task due ON THE CHECK-IN DATE:
 *               "refund as per property policy"
 *
 *   Invoice (bank transfer — no bank API yet, so always manual)
 *     full    → task due TODAY: send back everything paid
 *     partial → task due TODAY: send back the typed amount
 *     policy  → same check-in-dated task as for Stripe
 */

import { formatDate } from "./formatters";

export type GuestCancelRefundMode = "full" | "partial" | "policy";

export const REFUND_MODES: GuestCancelRefundMode[] = ["full", "partial", "policy"];

export const REFUND_MODE_LABEL: Record<GuestCancelRefundMode, string> = {
  full: "Full refund",
  partial: "Partial refund",
  policy: "As per property policy",
};

/** Is this a channel where the guest cancels with US (not on an OTA)? */
export function isDirectChannel(channel: string | undefined | null): boolean {
  return channel === "Direct" || channel === "Direct-Phone" || channel === "Direct-Web" || channel === "Corporate";
}

/**
 * How the booking was paid, as the server sees it.
 *   stripe  — refundableCzk = what Stripe can still give back across every
 *             Stripe payment on the booking (paid minus refunds already made)
 *   invoice — paidCzk = what came in by bank transfer (Beds24 deposit)
 */
export type PaymentPicture =
  | { method: "stripe"; refundableCzk: number }
  | { method: "invoice"; paidCzk: number };

/** What will happen about money. */
export type RefundPlan =
  | { kind: "stripe"; amountCzk: number }      // refunded automatically now
  | { kind: "bankTask"; amountCzk: number }    // task due today: send it by bank
  | { kind: "policyTask" };                    // task due on check-in

export interface RefundPlanInput {
  mode: GuestCancelRefundMode;
  /** The typed amount — only read for `partial` */
  amountCzk: number | null;
  payment: PaymentPicture;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Turn the operator's choice into a plan, or say why it can't go ahead.
 * Runs in the modal (Confirm is disabled with this reason) and again on the
 * server against freshly loaded payments — the client's numbers are never
 * trusted. Stripe also refuses anything above the charge, a last safety net.
 */
export function planRefund(input: RefundPlanInput): RefundPlan | { error: string } {
  const { mode, payment } = input;

  // Policy: no money moves now, whatever was typed. Someone decides later.
  if (mode === "policy") return { kind: "policyTask" };

  // The ceiling: what can still come back through Stripe, or what the guest
  // actually transferred. Never the booking price — an unpaid or half-paid
  // booking must not promise more than came in.
  const ceiling = round2(payment.method === "stripe" ? payment.refundableCzk : payment.paidCzk);
  if (!(ceiling > 0)) {
    return {
      error:
        payment.method === "stripe"
          ? "Nothing left to refund in Stripe — choose As per property policy."
          : "Nothing paid on this booking — choose As per property policy.",
    };
  }

  let amount: number;
  if (mode === "full") {
    amount = ceiling;
  } else {
    const typed = input.amountCzk;
    if (typed == null || !Number.isFinite(typed) || typed <= 0) {
      return { error: "Enter the amount to refund." };
    }
    amount = round2(typed);
    if (amount > ceiling) {
      return {
        error:
          payment.method === "stripe"
            ? `At most ${czkText(ceiling)} can still be refunded through Stripe.`
            : `The guest paid ${czkText(ceiling)} — the refund can't be more.`,
      };
    }
  }

  return payment.method === "stripe"
    ? { kind: "stripe", amountCzk: amount }
    : { kind: "bankTask", amountCzk: amount };
}

/**
 * Split a Stripe refund over the booking's payments (website checkout first,
 * then payment links oldest first), never more than each one can still give.
 */
export function allocateRefund(
  amountCzk: number,
  sources: Array<{ id: string; refundableCzk: number }>,
): Array<{ id: string; amountCzk: number }> | { error: string } {
  let left = round2(amountCzk);
  const out: Array<{ id: string; amountCzk: number }> = [];
  for (const s of sources) {
    if (left <= 0) break;
    const take = round2(Math.min(left, s.refundableCzk));
    if (take <= 0) continue;
    out.push({ id: s.id, amountCzk: take });
    left = round2(left - take);
  }
  if (left > 0) return { error: `Stripe can only refund ${czkText(round2(amountCzk - left))} on this booking.` };
  return out;
}

/** Text of the follow-up task the cancellation leaves behind. */
export function refundTaskText(
  plan: Exclude<RefundPlan, { kind: "stripe" }>,
  b: { reservationNumber: string; guest: string; room: string; checkInDate: string; checkOutDate: string; method: PaymentPicture["method"] },
): string {
  const stay = `${b.reservationNumber} · ${b.guest} · ${b.room} ${formatDate(b.checkInDate)}–${formatDate(b.checkOutDate)} (cancelled)`;
  if (plan.kind === "bankTask") {
    return `Refund ${czkText(plan.amountCzk)} by bank transfer — ${stay}`;
  }
  return `Refund as per property policy (${b.method === "stripe" ? "paid via Stripe" : "paid by bank transfer"}) — ${stay}`;
}

// ── Guest email ──────────────────────────────────────────────────────────────

const GOLD = "#B08D57";
const DARK_BROWN = "#3B2F2F";
const MID_BROWN = "#6b5b4e";

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function czkText(n: number): string {
  return `${n.toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} Kč`;
}

/** What the email says about money — follows the plan. */
export type EmailRefund =
  | { kind: "processed"; amountCzk: number }   // Stripe refund done
  | { kind: "pending"; amountCzk: number }     // bank refund to be sent
  | { kind: "policy" };

export function emailRefundFor(plan: RefundPlan): EmailRefund {
  if (plan.kind === "stripe") return { kind: "processed", amountCzk: plan.amountCzk };
  if (plan.kind === "bankTask") return { kind: "pending", amountCzk: plan.amountCzk };
  return { kind: "policy" };
}

export interface CancellationEmailInput {
  firstName: string;
  lastName: string;
  reservationNumber: string;
  room: string;
  checkInDate: string;
  checkOutDate: string;
  refund: EmailRefund;
}

/** Bilingual refund sentence. */
export function refundLines(refund: EmailRefund): { cs: string; en: string } {
  if (refund.kind === "processed") {
    return {
      cs: `Vrácení částky ${czkText(refund.amountCzk)} bylo zpracováno.`,
      en: `A refund of ${czkText(refund.amountCzk)} has been processed.`,
    };
  }
  if (refund.kind === "pending") {
    return {
      cs: `Vrácení částky ${czkText(refund.amountCzk)} právě zpracováváme.`,
      en: `A refund of ${czkText(refund.amountCzk)} is being processed.`,
    };
  }
  return {
    cs: "Vrácení platby proběhne v souladu s pravidly ubytování.",
    en: "Any refund will be processed as per the property rules.",
  };
}

export function cancellationEmailSubject(reservationNumber: string): string {
  return `Zrušení rezervace / Booking cancelled — ${reservationNumber}`;
}

export function buildCancellationEmailHTML(input: CancellationEmailInput): string {
  const name = esc(`${input.firstName} ${input.lastName}`.trim() || "Guest");
  const refund = refundLines(input.refund);
  const stay = `${esc(input.room)} · ${formatDate(input.checkInDate)} → ${formatDate(input.checkOutDate)}`;

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>Booking cancelled — ${esc(input.reservationNumber)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet" />
</head>
<body style="margin:0;padding:0;font-family:sans-serif;background:#fff;color:${DARK_BROWN}">
<div style="max-width:640px;margin:0 auto">
  <div style="font-family:'Great Vibes',cursive;font-size:48px;color:${GOLD};text-align:center;padding:18px 24px 4px;line-height:1.1">
    Baker House Apartments
  </div>
  <div style="border-bottom:2px solid ${GOLD};padding:8px 20px 12px;text-align:center">
    <div style="font-size:15px;font-weight:bold;letter-spacing:1px;text-transform:uppercase">Zrušení rezervace / Booking cancelled</div>
  </div>

  <div style="padding:20px 24px;font-size:14px;line-height:1.6">
    <p style="margin:0 0 12px">Dobrý den, ${name},</p>
    <p style="margin:0 0 12px">potvrzujeme, že Vaše rezervace <strong>${esc(input.reservationNumber)}</strong> (${stay}) byla zrušena.</p>
    <p style="margin:0 0 20px"><strong>${esc(refund.cs)}</strong></p>

    <div style="border-top:1px solid #eee;padding-top:16px;color:${MID_BROWN}">
      <p style="margin:0 0 12px">Dear ${name},</p>
      <p style="margin:0 0 12px">we confirm that your booking <strong>${esc(input.reservationNumber)}</strong> (${stay}) has been cancelled.</p>
      <p style="margin:0 0 20px"><strong>${esc(refund.en)}</strong></p>
    </div>

    <p style="margin:16px 0 0">S pozdravem / Kind regards,<br/>Patrik &amp; Zuzana</p>
  </div>

  <div style="border-top:1px solid ${GOLD};padding:12px 24px;text-align:center;font-size:11px;color:${MID_BROWN}">
    <a href="https://bakerhouseapartments.cz" style="color:${GOLD};text-decoration:none">bakerhouseapartments.cz</a>
    · reservations@bakerhouseapartments.cz
  </div>
</div>
</body>
</html>`;
}
