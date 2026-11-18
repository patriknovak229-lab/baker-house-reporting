"use client";

/**
 * "Guest Cancellation" — for direct bookings the guest cancelled by phone,
 * WhatsApp or email. Admin only. One button → a confirm modal with the refund
 * choice (Full by default / Partial + amount / As per property policy).
 *
 * The server decides how the booking was paid (Stripe vs invoice/bank) and:
 *   Stripe  full/partial → refunds automatically, policy → task on check-in
 *   Invoice full/partial → task due today,          policy → task on check-in
 * then cancels in Beds24 (nights back on sale) and emails the guest.
 * Rules: utils/guestCancellation.ts. Server: app/api/bookings/guest-cancel.
 */

import { useEffect, useMemo, useState } from "react";
import type { PlatformRefund, Reservation } from "@/types/reservation";
import { formatDate } from "@/utils/formatters";
import { freeCancelDaysLeft } from "@/utils/cancellationPolicy";
import { pragueToday } from "@/utils/periodUtils";
import { mergeStripeRefund } from "@/utils/webPaymentRefund";
import type { RefundResult } from "@/utils/webPaymentServer";
import {
  czkText,
  emailRefundFor,
  planRefund,
  REFUND_MODE_LABEL,
  REFUND_MODES,
  refundLines,
  type GuestCancelRefundMode,
  type PaymentPicture,
} from "@/utils/guestCancellation";

interface PaymentInfo {
  channel: string;
  picture: PaymentPicture;
  stripeSources: Array<{ label: string; refundableCzk: number }>;
  webNote: string | null;
}

type RefundRecord = Pick<RefundResult, "recorded" | "platformRefund" | "entry">;

/** OTA conduit addresses can't be written to. */
function guestEmailFor(r: Reservation): string {
  const candidates = [r.additionalEmail, r.email].map((e) => (e ?? "").trim());
  return candidates.find((e) => e && !/@(guest\.booking\.com|guest\.airbnb\.com)$/i.test(e)) ?? "";
}

function newKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function GuestCancellation({
  reservation,
  onCancelled,
}: {
  reservation: Reservation;
  /** Patch the drawer's copy: cancelled + any refund the server recorded */
  onCancelled: (patch: { platformRefund?: PlatformRefund | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (done) {
    return (
      <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
        🚫 {done}
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50"
      >
        🚫 Guest Cancellation
      </button>
      {open && (
        <GuestCancellationModal
          reservation={reservation}
          onClose={() => setOpen(false)}
          onDone={(summary, patch) => {
            setOpen(false);
            setDone(summary);
            onCancelled(patch);
          }}
        />
      )}
    </>
  );
}

function GuestCancellationModal({
  reservation: r,
  onClose,
  onDone,
}: {
  reservation: Reservation;
  onClose: () => void;
  onDone: (summary: string, patch: { platformRefund?: PlatformRefund | null }) => void;
}) {
  const [idempotencyKey] = useState(newKey);
  const [info, setInfo] = useState<PaymentInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);

  const [mode, setMode] = useState<GuestCancelRefundMode>("full");
  const [partial, setPartial] = useState("");
  const [sendEmail, setSendEmail] = useState(true);
  const [emailTo, setEmailTo] = useState(() => guestEmailFor(r));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set when the refund went through but Beds24 didn't cancel — retry cancels only */
  const [halfDone, setHalfDone] = useState<{ refundedCzk: number; record: RefundRecord | null } | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/bookings/guest-cancel?reservationNumber=${encodeURIComponent(r.reservationNumber)}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!alive) return;
        if (res.ok) setInfo(json as PaymentInfo);
        else setInfoError(json.error ?? `Couldn't load the payment (${res.status})`);
      })
      .catch(() => alive && setInfoError("Couldn't load the payment"));
    return () => {
      alive = false;
    };
  }, [r.reservationNumber]);

  const amountCzk = mode === "partial" && partial.trim() !== "" ? Number(partial.replace(/\s/g, "").replace(",", ".")) : null;
  const plan = useMemo(
    () => (info ? planRefund({ mode, amountCzk, payment: info.picture }) : null),
    [info, mode, amountCzk],
  );
  const planError = plan && "error" in plan ? plan.error : null;
  const emailInvalid = sendEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTo.trim());

  const policy = r.cancellationPolicy;
  const daysLeft = freeCancelDaysLeft(policy, pragueToday());
  const isStripe = info?.picture.method === "stripe";
  const fullAmount = info ? (info.picture.method === "stripe" ? info.picture.refundableCzk : info.picture.paidCzk) : 0;

  /** One line on what will happen about money. */
  let outcome: string | null = null;
  if (halfDone) {
    outcome = `${czkText(halfDone.refundedCzk)} already refunded via Stripe — the retry only cancels the booking.`;
  } else if (plan && !("error" in plan)) {
    if (plan.kind === "stripe") outcome = `💳 ${czkText(plan.amountCzk)} is refunded automatically via Stripe, now.`;
    else if (plan.kind === "bankTask") outcome = `🏦 A task due today: send ${czkText(plan.amountCzk)} back by bank transfer.`;
    else outcome = `📋 No refund now — a task "refund as per property policy" due on check-in (${formatDate(r.checkInDate)}).`;
  }
  const lines = plan && !("error" in plan)
    ? refundLines(halfDone ? { kind: "processed", amountCzk: halfDone.refundedCzk } : emailRefundFor(plan))
    : null;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings/guest-cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: r.reservationNumber,
          refundMode: mode,
          amountCzk,
          sendEmail,
          emailTo: emailTo.trim(),
          note,
          room: r.room,
          idempotencyKey,
          ...(halfDone ? { retryCancelOnly: true, refundedCzk: halfDone.refundedCzk } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (json.stage === "cancel" && Number(json.refundedCzk) > 0) {
          setHalfDone({ refundedCzk: Number(json.refundedCzk), record: json.refundRecord ?? null });
        }
        setError(json.error ?? `Failed (${res.status})`);
        return;
      }

      // Carry a server-recorded website refund into the drawer's copy — it
      // re-saves that copy on every edit and would otherwise drop it.
      const rec: RefundRecord | null = json.refundRecord ?? halfDone?.record ?? null;
      let platformRefund: PlatformRefund | null | undefined;
      if (rec?.recorded === "server" || rec?.recorded === "already") platformRefund = rec.platformRefund;
      else if (rec?.recorded === "client") {
        platformRefund = mergeStripeRefund(r.platformRefund, rec.entry, {
          priceCzk: r.price,
          nowIso: new Date().toISOString(),
          reason: "Guest cancellation",
        });
      }

      const p = json.plan as { kind: string; amountCzk?: number };
      const parts = [
        "Cancelled in Beds24 — nights back on sale.",
        p.kind === "stripe"
          ? `${czkText(p.amountCzk ?? 0)} refunded via Stripe.`
          : json.task
            ? `Task created, due ${formatDate(json.task.dueDate)}.`
            : `⚠️ Task NOT created: ${json.taskError} — add it by hand.`,
        !sendEmail ? "No email sent." : json.emailSent ? `Guest emailed (${emailTo.trim()}).` : `⚠️ Email failed: ${json.emailError}`,
      ];
      onDone(parts.join(" "), platformRefund !== undefined ? { platformRefund } : {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !busy && !!info && (halfDone != null || !planError) && !emailInvalid;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={busy ? undefined : onClose}>
      <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-base font-semibold text-gray-900">Guest cancellation</h3>
        <p className="mt-1 text-sm text-gray-600">
          Cancel <span className="font-medium">{r.reservationNumber}</span> · {r.firstName} {r.lastName} · {r.room},{" "}
          {formatDate(r.checkInDate)} → {formatDate(r.checkOutDate)}? The booking is cancelled in Beds24 and the nights
          go back on sale. This can&apos;t be undone from the app.
        </p>

        {policy?.freeUntilDate && (
          <p className="mt-2 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs text-gray-600">
            Policy: free cancellation until <span className="font-medium">{formatDate(policy.freeUntilDate)}</span>
            {daysLeft != null && daysLeft >= 0 ? ` (${daysLeft}d left)` : " — the free window has passed"}.
          </p>
        )}

        {/* Paid how */}
        <p className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">Paid by</p>
        {infoError ? (
          <p className="text-xs text-red-700">{infoError}</p>
        ) : !info ? (
          <p className="text-xs text-gray-500">Checking payments…</p>
        ) : isStripe ? (
          <div className="text-xs text-gray-700">
            💳 Stripe — {czkText(fullAmount)} still refundable
            {info.stripeSources.length > 1 && (
              <ul className="mt-1 list-disc pl-5 text-gray-500">
                {info.stripeSources.map((s, i) => (
                  <li key={i}>{s.label}: {czkText(s.refundableCzk)}</li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <div className="text-xs text-gray-700">
            🏦 Invoice / bank transfer — {czkText(fullAmount)} paid. Refunds are sent by hand (no bank API).
            {info.webNote && <p className="mt-0.5 text-gray-500">Website checkout not refundable here: {info.webNote}</p>}
          </div>
        )}

        {/* Refund */}
        <p className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">Refund</p>
        <div className="space-y-1.5">
          {REFUND_MODES.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm text-gray-800">
              <input type="radio" name="refund-mode" checked={mode === m} disabled={!!halfDone} onChange={() => setMode(m)} />
              {REFUND_MODE_LABEL[m]}
              {m === "full" && info && <span className="text-gray-500">— {czkText(fullAmount)}</span>}
            </label>
          ))}
        </div>
        {mode === "partial" && (
          <input
            type="text"
            inputMode="decimal"
            value={partial}
            disabled={!!halfDone}
            onChange={(e) => setPartial(e.target.value)}
            placeholder="Amount in Kč"
            className="mt-2 w-40 rounded-md border border-gray-300 px-2 py-1 text-sm"
          />
        )}
        {outcome && <p className="mt-2 rounded-md border border-gray-200 px-2.5 py-2 text-xs text-gray-700">{outcome}</p>}

        {/* Email */}
        <p className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">Guest email</p>
        <label className="flex items-center gap-2 text-sm text-gray-800">
          <input type="checkbox" checked={sendEmail} onChange={(e) => setSendEmail(e.target.checked)} />
          Send cancellation email
        </label>
        {sendEmail && (
          <>
            <input
              type="email"
              value={emailTo}
              onChange={(e) => setEmailTo(e.target.value)}
              placeholder="guest@example.com"
              className="mt-1.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
            />
            {lines && (
              <p className="mt-1.5 text-xs text-gray-500">
                Says: &ldquo;{lines.en}&rdquo; <span className="text-gray-400">/ {lines.cs}</span>
              </p>
            )}
          </>
        )}

        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Internal note (optional) — e.g. called on WhatsApp"
          className="mt-4 w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
        />

        {(error || (planError && !halfDone)) && (
          <p className="mt-3 rounded-md bg-red-50 px-2.5 py-1.5 text-xs text-red-700">{error ?? planError}</p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
          >
            {halfDone ? "Close" : "Keep booking"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
          >
            {busy ? "Cancelling…" : halfDone ? "Retry cancellation only" : error ? "Retry" : "Cancel booking"}
          </button>
        </div>
      </div>
    </div>
  );
}
