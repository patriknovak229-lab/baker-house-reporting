/**
 * Guest cancellation of a DIRECT booking — the guest cancelled by phone /
 * WhatsApp / email; an admin processes it in one step. Rules: see
 * utils/guestCancellation.ts.
 *
 *   GET  ?reservationNumber=BH-…  → how it was paid + what can be refunded
 *   POST { reservationNumber, refundMode, amountCzk?, sendEmail, emailTo?,
 *          note?, room?, idempotencyKey, retryCancelOnly?, refundedCzk? }
 *
 * POST order:
 *   1. money — Stripe refund (website checkout first, then payment links)
 *      BEFORE the cancel, because the web-refund engine refuses cancelled
 *      bookings. A failed refund stops everything; nothing has changed.
 *   2. cancel in Beds24 (status cancelled, subStatus cancelledByGuest,
 *      Beds24 auto-actions off so the guest gets only our email), whole
 *      package group, verified by reading the rows back.
 *   3. follow-up task (bank refund today / policy refund on check-in) —
 *      created only once the cancel has succeeded, so a retry can't double it.
 *   4. guest email, 5. Telegram.
 *
 * If the refund went through but Beds24 didn't cancel, the response says so
 * and the modal retries with `retryCancelOnly` (+ the refund it already made,
 * for the email) — the money step is skipped entirely, so a retry can never
 * refund twice.
 *
 * Admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { requireRole } from "@/utils/authGuard";
import { getAccessToken } from "@/utils/beds24Auth";
import { getRedis, mapChannel } from "@/utils/beds24Reservations";
import { sendTelegram, escapeHtml } from "@/utils/telegram";
import { sendGuestEmail } from "@/utils/guestEmail";
import { readAllEmailSendLog, writeAllEmailSendLog } from "@/utils/emailSendLogStore";
import { createGeneralTask } from "@/data-access/team";
import { pragueToday } from "@/utils/periodUtils";
import { WebPaymentError, type RefundResult } from "@/utils/webPaymentServer";
import { loadBookingPayments, refundPaymentLink, refundWebCheckout } from "@/utils/guestCancelPayments";
import {
  allocateRefund,
  buildCancellationEmailHTML,
  cancellationEmailSubject,
  czkText,
  emailRefundFor,
  isDirectChannel,
  planRefund,
  REFUND_MODE_LABEL,
  REFUND_MODES,
  refundTaskText,
  type GuestCancelRefundMode,
  type RefundPlan,
} from "@/utils/guestCancellation";

const BEDS24_API_BASE = "https://beds24.com/api/v2";
const BOOKINGS_CACHE_KEY = "baker:beds24-bookings-cache";

interface Beds24Booking {
  id: number;
  roomId: number;
  arrival: string;
  departure: string;
  status: string;
  firstName?: string;
  lastName?: string;
  price?: number;
  deposit?: number;
  apiSource?: string;
  referer?: string;
  comments?: string;
  bookingGroup?: { master?: number; ids?: number[] } | null;
}

function asArray(json: unknown): Beds24Booking[] {
  if (Array.isArray(json)) return json as Beds24Booking[];
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Beds24Booking[]) : [];
}

async function fetchByIds(token: string, ids: number[]): Promise<Beds24Booking[]> {
  const params = new URLSearchParams();
  for (const id of ids) params.append("id", String(id));
  for (const s of ["confirmed", "new", "request", "cancelled", "black"]) params.append("status", s);
  params.set("includeBookingGroup", "true");
  const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: "no-store" });
  if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
  return asArray(await res.json());
}

/** Flip the cached rows to cancelled so the dashboard shows it on the next read. */
async function patchBookingsCache(ids: number[]): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  try {
    const cached = await redis.get<Record<string, { status?: string }>>(BOOKINGS_CACHE_KEY);
    if (!cached) return;
    let touched = false;
    for (const id of ids) {
      const entry = cached[String(id)];
      if (entry) {
        entry.status = "cancelled";
        touched = true;
      }
    }
    if (touched) await redis.set(BOOKINGS_CACHE_KEY, cached);
  } catch {
    // Best effort — the next Beds24 sync corrects it.
  }
}

const bad = (status: number, error: string, extra: Record<string, unknown> = {}) =>
  NextResponse.json({ error, ...extra }, { status });

/** Live booking + its channel, refusing anything that isn't a live direct booking. */
async function loadLiveDirectBooking(reservationNumber: string) {
  const bookingId = Number(reservationNumber.replace(/^BH-/, ""));
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    return { error: bad(400, `Bad reservation number: ${reservationNumber}`) };
  }
  let token: string;
  let booking: Beds24Booking | undefined;
  try {
    token = await getAccessToken();
    booking = (await fetchByIds(token, [bookingId])).find((b) => b.id === bookingId);
  } catch (err) {
    return { error: bad(502, err instanceof Error ? err.message : "Beds24 lookup failed") };
  }
  if (!booking) return { error: bad(404, `Booking ${bookingId} not found in Beds24`) };
  if (booking.status === "black") return { error: bad(409, "This is a blackout, not a guest booking.") };
  if (booking.status === "cancelled") return { error: bad(409, "This booking is already cancelled in Beds24.") };
  const channel = mapChannel(booking.apiSource ?? "", booking.referer ?? "", booking.comments ?? "");
  if (!isDirectChannel(channel)) {
    return { error: bad(409, `${channel} booking — the guest cancels on ${channel}, not with us.`) };
  }
  return { token, booking, bookingId, channel };
}

export async function GET(req: NextRequest) {
  const guard = await requireRole(["admin"]);
  if ("error" in guard) return guard.error;
  const reservationNumber = req.nextUrl.searchParams.get("reservationNumber")?.trim() ?? "";
  const live = await loadLiveDirectBooking(reservationNumber);
  if ("error" in live) return live.error;
  const payments = await loadBookingPayments(reservationNumber, live.channel, Number(live.booking.deposit ?? 0));
  return NextResponse.json({
    channel: live.channel,
    picture: payments.picture,
    stripeSources: [
      ...(payments.web ? [{ label: "Website checkout", refundableCzk: payments.web.refundableCzk }] : []),
      ...payments.links.map((l) => ({
        label: `Payment link${l.description ? ` — ${l.description}` : ""}`,
        refundableCzk: l.refundableCzk,
      })),
    ],
    webNote: payments.webNote ?? null,
  });
}

export async function POST(req: NextRequest) {
  const guard = await requireRole(["admin"]);
  if ("error" in guard) return guard.error;

  let body: {
    reservationNumber?: string;
    refundMode?: string;
    amountCzk?: unknown;
    sendEmail?: boolean;
    emailTo?: string;
    note?: string;
    /** Display label for the email / task (K.202 …) — Beds24 only knows room ids */
    room?: string;
    idempotencyKey?: string;
    /** Second attempt after "refunded, but Beds24 didn't cancel": skip the money step */
    retryCancelOnly?: boolean;
    /** With retryCancelOnly: the Stripe refund the first attempt made (for the email) */
    refundedCzk?: number;
  };
  try {
    body = await req.json();
  } catch {
    return bad(400, "Invalid JSON body");
  }

  const reservationNumber = String(body.reservationNumber ?? "").trim();
  const mode = body.refundMode as GuestCancelRefundMode;
  if (!REFUND_MODES.includes(mode)) return bad(400, "refundMode must be full, partial or policy");
  const idempotencyKey = String(body.idempotencyKey ?? "");
  if (!/^[\w-]{8,100}$/.test(idempotencyKey)) return bad(400, "idempotencyKey is required");
  const note = (body.note ?? "").trim().slice(0, 300);
  const room = (body.room ?? "").trim().slice(0, 40) || "Baker House";
  const sendEmail = body.sendEmail !== false;
  const emailTo = (body.emailTo ?? "").trim();
  if (sendEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo)) {
    return bad(400, "A valid guest email is required (or untick Send email)");
  }
  const amountCzk = body.amountCzk == null || body.amountCzk === "" ? null : Number(body.amountCzk);

  const live = await loadLiveDirectBooking(reservationNumber);
  if ("error" in live) return live.error;
  const { token, booking, bookingId, channel } = live;
  const guest = `${booking.firstName ?? ""} ${booking.lastName ?? ""}`.trim() || `#${bookingId}`;
  const reason = `Guest cancellation${note ? ` — ${note}` : ""}`;

  // ── 1. Money ──
  const payments = await loadBookingPayments(reservationNumber, channel, Number(booking.deposit ?? 0));
  let plan: RefundPlan;
  let refundRecord: Pick<RefundResult, "recorded" | "platformRefund" | "entry"> | null = null;

  const fresh = planRefund({ mode, amountCzk, payment: payments.picture });
  if (body.retryCancelOnly && Number(body.refundedCzk ?? 0) > 0) {
    // The first attempt already refunded through Stripe — never touch money again.
    plan = { kind: "stripe", amountCzk: Number(body.refundedCzk) };
  } else if ("error" in fresh) {
    return bad(400, fresh.error);
  } else {
    plan = fresh;
  }

  if (plan.kind === "stripe" && !body.retryCancelOnly) {
    const sources = [
      ...(payments.web ? [{ id: `web:${payments.web.sessionId}`, refundableCzk: payments.web.refundableCzk }] : []),
      ...payments.links.map((l) => ({ id: `link:${l.id}`, refundableCzk: l.refundableCzk })),
    ];
    const parts = allocateRefund(plan.amountCzk, sources);
    if ("error" in parts) return bad(400, parts.error);

    let done = 0;
    for (const part of parts) {
      try {
        if (part.id.startsWith("web:")) {
          const r = await refundWebCheckout({
            reservationNumber,
            sessionId: part.id.slice(4),
            amountCzk: part.amountCzk,
            reason,
            idempotencyKey,
            operator: guard.email,
          });
          refundRecord = { recorded: r.recorded, platformRefund: r.platformRefund, entry: r.entry };
          done += r.entry.amountCzk;
        } else {
          const r = await refundPaymentLink({
            sessionId: part.id.slice(5),
            amountCzk: part.amountCzk,
            reason,
            idempotencyKey,
            operator: guard.email,
          });
          done += r.amountCzk;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Stripe refund failed";
        const status = err instanceof WebPaymentError ? err.status : 502;
        if (done > 0) {
          await sendTelegram(
            `⚠️ <b>Guest cancellation stopped mid-refund</b> — ${escapeHtml(reservationNumber)}\n` +
              `💰 ${czkText(done)} WAS refunded, the rest failed: ${escapeHtml(msg)}\n` +
              `Booking NOT cancelled.\n👤 ${escapeHtml(guard.email)}`,
          );
        }
        return bad(
          status,
          `${done > 0 ? `${czkText(done)} was refunded, then ` : ""}Stripe failed: ${msg}. The booking was NOT cancelled.`,
          { stage: "refund", refundRecord },
        );
      }
    }
    plan = { kind: "stripe", amountCzk: Math.round(done * 100) / 100 };
  }

  // ── 2. Cancel in Beds24 (whole package group) ──
  const ids = new Set<number>([bookingId]);
  for (const id of booking.bookingGroup?.ids ?? []) if (Number.isFinite(id)) ids.add(Number(id));
  if (booking.bookingGroup?.master) ids.add(Number(booking.bookingGroup.master));
  let targets = [bookingId];
  if (ids.size > 1) {
    try {
      const members = await fetchByIds(token, [...ids]);
      targets = members
        .filter((m) => m.status !== "cancelled" && m.status !== "black")
        .filter((m) => m.arrival === booking.arrival && m.departure === booking.departure)
        .map((m) => m.id);
      if (!targets.includes(bookingId)) targets.push(bookingId);
    } catch {
      targets = [bookingId];
    }
  }

  const refundedNow = plan.kind === "stripe" ? plan.amountCzk : null;
  const infoText =
    `Guest cancellation (${REFUND_MODE_LABEL[mode]}` +
    `${refundedNow ? `, ${czkText(refundedNow)} refunded via Stripe` : ""}) by ${guard.email}` +
    `${note ? ` — ${note}` : ""}`;
  try {
    const res = await fetch(`${BEDS24_API_BASE}/bookings`, {
      method: "POST",
      headers: { token, "Content-Type": "application/json" },
      body: JSON.stringify(
        targets.map((id) => ({
          id,
          status: "cancelled",
          subStatus: "cancelledByGuest",
          // Our email goes out below — no Beds24 auto-email next to it.
          allowAutoAction: "disable",
          infoItems: [{ code: "GUEST_CANCELLED", text: infoText.slice(0, 250) }],
        })),
      ),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${await res.text()}`);
    const after = await fetchByIds(token, targets);
    const still = targets.filter((id) => after.find((b) => b.id === id)?.status !== "cancelled");
    if (still.length > 0) throw new Error(`Beds24 did not cancel ${still.join(", ")}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Beds24 cancel failed";
    await sendTelegram(
      [
        `⚠️ <b>Guest cancellation half-done</b> — ${escapeHtml(reservationNumber)}`,
        refundedNow ? `💰 ${czkText(refundedNow)} WAS refunded via Stripe` : "No money moved",
        `❌ Beds24 cancel failed: ${escapeHtml(msg)}`,
        `👤 ${escapeHtml(guard.email)}`,
      ].join("\n"),
    );
    return bad(
      502,
      `${refundedNow ? `The refund of ${czkText(refundedNow)} went through, but ` : ""}Beds24 didn't cancel the booking: ${msg}`,
      { stage: "cancel", refundedCzk: refundedNow ?? 0, refundRecord },
    );
  }
  await patchBookingsCache(targets);

  // ── 3. Follow-up task (manual refunds) ──
  let task: { id: string; dueDate: string } | null = null;
  let taskError: string | null = null;
  if (plan.kind !== "stripe") {
    const dueDate = plan.kind === "bankTask" ? pragueToday() : booking.arrival;
    try {
      const session = await auth();
      const t = await createGeneralTask({
        assignee: guard.email,
        text: refundTaskText(plan, {
          reservationNumber,
          guest,
          room,
          checkInDate: booking.arrival,
          checkOutDate: booking.departure,
          method: payments.picture.method,
        }),
        dueDate,
        createdBy: guard.email,
        createdByName: session?.user?.name ?? null,
      });
      task = { id: t.id, dueDate };
    } catch (err) {
      taskError = err instanceof Error ? err.message : "Task creation failed";
    }
  }

  // ── 4. Guest email ──
  let emailError: string | null = null;
  if (sendEmail) {
    const subject = cancellationEmailSubject(reservationNumber);
    try {
      await sendGuestEmail({
        to: emailTo,
        subject,
        html: buildCancellationEmailHTML({
          firstName: booking.firstName ?? "",
          lastName: booking.lastName ?? "",
          reservationNumber,
          room,
          checkInDate: booking.arrival,
          checkOutDate: booking.departure,
          refund: emailRefundFor(plan),
        }),
      });
      try {
        const log = await readAllEmailSendLog();
        await writeAllEmailSendLog([
          ...log,
          {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            reservationNumber,
            templateId: "guest-cancellation",
            templateLabel: "Guest cancellation",
            to: emailTo,
            subject,
            sentAt: new Date().toISOString(),
            sentBy: guard.email,
          },
        ]);
      } catch (logErr) {
        console.error("[guest-cancel] send-log append failed:", logErr);
      }
    } catch (err) {
      emailError = err instanceof Error ? err.message : "Email failed";
    }
  }

  // ── 5. Telegram ──
  const moneyLine =
    plan.kind === "stripe"
      ? `💰 ${czkText(plan.amountCzk)} refunded via Stripe`
      : plan.kind === "bankTask"
        ? `🏦 Bank refund of ${czkText(plan.amountCzk)} to send — task due today`
        : `📋 Refund as per property policy — task due ${booking.arrival}`;
  await sendTelegram(
    [
      `🚫 <b>Guest cancellation</b> — nights back on sale`,
      `${escapeHtml(reservationNumber)} · ${escapeHtml(guest)} · ${channel} · ${escapeHtml(room)}`,
      `${booking.arrival} → ${booking.departure}${targets.length > 1 ? ` · ${targets.length} rooms` : ""}`,
      moneyLine,
      taskError ? `⚠️ Task NOT created: ${escapeHtml(taskError)}` : "",
      !sendEmail ? "✉️ No email sent" : emailError ? `⚠️ Email FAILED: ${escapeHtml(emailError)}` : `✉️ Emailed ${escapeHtml(emailTo)}`,
      note ? `📝 ${escapeHtml(note)}` : "",
      `👤 by ${escapeHtml(guard.email)}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );

  return NextResponse.json({
    ok: true,
    cancelledIds: targets,
    plan,
    refundRecord,
    task,
    taskError,
    emailSent: sendEmail && !emailError,
    emailError,
  });
}
