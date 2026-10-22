"use client";

/**
 * Drawer block for a website (Direct-Web) booking: the Stripe checkout the
 * guest paid with, what has been refunded on it, and "↩︎ Refund via Stripe".
 *
 * A refund is issued AND recorded as the booking's platform refund in one
 * server call (/api/stripe/web-payment/refund); the result comes back through
 * `onPlatformRefund` so the drawer's copy of the booking — which it re-saves
 * on every edit — carries it too. Refunds made outside the app (Stripe
 * Dashboard) are listed with a "Record" button instead of being counted
 * automatically. Server logic: utils/webPaymentServer.ts.
 */

import { useCallback, useEffect, useState } from "react";
import type { PlatformRefund, Reservation } from "@/types/reservation";
import { formatDate } from "@/utils/formatters";
import { shortenedRevenueSplit } from "@/utils/reservationRevenue";
import { mergeStripeRefund, parseRefundAmount } from "@/utils/webPaymentRefund";
import type { RefundResult, RefundView, WebPaymentState } from "@/utils/webPaymentServer";

const czk = (n: number) =>
  `${n.toLocaleString("cs-CZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} Kč`;

const STATUS_LABEL: Record<string, string> = {
  succeeded: "done",
  pending: "pending",
  requires_action: "needs action",
  failed: "FAILED",
  canceled: "canceled",
};

function newIdempotencyKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** What the drawer should store after a refund / record call, or null for nothing */
function platformRefundAfter(
  reservation: Reservation,
  result: Pick<RefundResult, "recorded" | "platformRefund" | "entry">,
  reason?: string,
): PlatformRefund | null {
  if (result.recorded === "server" || result.recorded === "already") return result.platformRefund;
  if (result.recorded === "client") {
    return mergeStripeRefund(reservation.platformRefund, result.entry, {
      priceCzk: reservation.price,
      nowIso: new Date().toISOString(),
      reason,
    });
  }
  return null;
}

export function WebPaymentRefund({
  reservation,
  canRefund,
  canRecord,
  onPlatformRefund,
}: {
  reservation: Reservation;
  /** Admin — issuing a refund moves money */
  canRefund: boolean;
  /** Admin / super — counting an existing Stripe refund on the booking */
  canRecord: boolean;
  onPlatformRefund: (pr: PlatformRefund) => void;
}) {
  const rn = reservation.reservationNumber;
  const [state, setState] = useState<WebPaymentState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [confirmKey, setConfirmKey] = useState<string | null>(null); // set = on the confirm step
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch(`/api/stripe/web-payment?reservationNumber=${encodeURIComponent(rn)}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setState(data as WebPaymentState);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Lookup failed");
    } finally {
      setLoading(false);
    }
  }, [rn]);

  useEffect(() => {
    load();
  }, [load]);

  const split = shortenedRevenueSplit(reservation);
  const stripe = state?.stripe;
  const parsed = parseRefundAmount(amount);
  const amountError = amount === "" ? null
    : "error" in parsed ? parsed.error
    : stripe && parsed.hal > Math.round(stripe.refundableCzk * 100) ? `At most ${czk(stripe.refundableCzk)}`
    : null;

  function openForm() {
    setAmount("");
    setReason("");
    setError(null);
    setNotice(null);
    setConfirmKey(null);
    setFormOpen(true);
  }

  async function submitRefund() {
    if (!stripe || !confirmKey || "error" in parsed) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/web-payment/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: rn,
          sessionId: stripe.sessionId,
          amountCzk: parsed.hal / 100,
          reason: reason.trim() || undefined,
          idempotencyKey: confirmKey,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const result = data as RefundResult;
      const next = platformRefundAfter(reservation, result, reason.trim() || undefined);
      if (next) onPlatformRefund(next);
      setFormOpen(false);
      setConfirmKey(null);
      setNotice(result.recorded === "failed"
        ? { tone: "warn", text: `Refunded ${czk(result.entry.amountCzk)} in Stripe, but it couldn't be recorded on the booking (${result.recordError ?? "error"}). Use “Record” below.` }
        : { tone: "ok", text: `Refunded ${czk(result.entry.amountCzk)} (Stripe: ${STATUS_LABEL[result.refund.status] ?? result.refund.status}) — recorded as this booking's refund.` });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refund failed");
    } finally {
      setBusy(false);
    }
  }

  async function recordRefund(r: RefundView) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/web-payment/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber: rn, refundId: r.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const result = data as RefundResult;
      if (result.recorded === "failed") throw new Error(result.recordError ?? "Recording failed");
      const next = platformRefundAfter(reservation, result);
      if (next) onPlatformRefund(next);
      setNotice({ tone: "ok", text: `Recorded the ${czk(r.amountCzk)} refund of ${formatDate(r.date)} on this booking.` });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50/40 px-3 py-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-indigo-900">💳 Web payment (Stripe)</span>
        <button
          onClick={() => { setNotice(null); setError(null); load(); }}
          disabled={loading || busy}
          className="text-[11px] text-indigo-600 hover:underline disabled:opacity-50"
        >
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {loadError && <p className="mt-1 text-red-600">{loadError}</p>}

      {state && state.link.status !== "linked" && (
        <p className="mt-1 text-gray-600">
          {state.link.reason}. Refund it in the Stripe Dashboard, then record it with “↩︎ Mark partially refunded”.
        </p>
      )}

      {state && state.link.status === "linked" && (
        <div className="mt-1 space-y-1">
          <p className="text-gray-700">
            Paid {czk(stripe?.paidCzk ?? state.link.checkout.amountCzk)} on{" "}
            {formatDate(state.link.checkout.paidAt.slice(0, 10))}
            <span className="text-gray-400"> · {state.link.checkout.sessionId.slice(0, 16)}…</span>
          </p>
          {stripe && (
            <p className="text-gray-700">
              Refunded in Stripe: <span className="font-medium">{czk(stripe.refundedCzk)}</span>
              <span className="text-gray-300"> · </span>
              still refundable: <span className="font-medium">{czk(stripe.refundableCzk)}</span>
              <span className="text-gray-300"> · </span>
              counted on this booking: <span className="font-medium">{czk(state.recordedCzk)}</span>
            </p>
          )}
          {stripe && stripe.refunds.length > 0 && (
            <ul className="text-[11px] text-gray-600 space-y-0.5">
              {stripe.refunds.map((r) => (
                <li key={r.id}>
                  ↩︎ {czk(r.amountCzk)} · {formatDate(r.date)} · {STATUS_LABEL[r.status] ?? r.status}
                  {!r.fromApp && <span className="text-gray-400"> · made outside the app</span>}
                </li>
              ))}
            </ul>
          )}
          {state.stripeError && <p className="text-red-600">Stripe: {state.stripeError}</p>}
        </div>
      )}

      {state && state.unrecorded.length > 0 && (
        <div className="mt-1.5 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 space-y-1">
          <p className="text-amber-800">Refunded in Stripe but not counted on this booking yet:</p>
          {state.unrecorded.map((r) => (
            <div key={r.id} className="flex items-center gap-2">
              <span className="text-amber-900">{czk(r.amountCzk)} · {formatDate(r.date)}</span>
              {canRecord && (
                <button
                  onClick={() => recordRefund(r)}
                  disabled={busy}
                  className="px-2 py-0.5 text-[11px] font-medium text-amber-800 border border-amber-300 rounded hover:bg-amber-100 disabled:opacity-50"
                >
                  Record
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {state && state.failedButRecorded.length > 0 && (
        <p className="mt-1.5 text-red-700">
          ⚠ Stripe reports{" "}
          {state.failedButRecorded.map((r) => `${czk(r.amountCzk)} (${STATUS_LABEL[r.status] ?? r.status})`).join(", ")}{" "}
          as not refunded, but it&apos;s counted on this booking — lower “Refunded (Kč)” below.
        </p>
      )}

      {state?.blocked && state.link.status === "linked" && <p className="mt-1 text-gray-500">{state.blocked}.</p>}

      {notice && (
        <p className={`mt-1.5 ${notice.tone === "ok" ? "text-emerald-700" : "text-red-700 font-medium"}`}>{notice.text}</p>
      )}
      {error && !formOpen && <p className="mt-1.5 text-red-600">{error}</p>}

      {canRefund && state && !state.blocked && stripe && stripe.refundableCzk > 0 && !formOpen && (
        <button
          onClick={openForm}
          className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-700 border border-indigo-200 rounded-lg bg-white hover:bg-indigo-50 transition-colors"
          title="Send money back to the guest's card through Stripe and record it as this booking's refund"
        >
          ↩︎ Refund via Stripe…
        </button>
      )}

      {formOpen && stripe && (
        <div className="mt-2 rounded border border-indigo-200 bg-white px-2.5 py-2 space-y-2">
          {!confirmKey ? (
            <>
              <div className="flex items-end gap-3 flex-wrap">
                <label className="text-[11px] text-gray-600">
                  Amount (Kč)
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    max={stripe.refundableCzk}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="block w-36 mt-0.5 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </label>
                <label className="text-[11px] text-gray-600 flex-1 min-w-[10rem]">
                  Reason (for our records, optional)
                  <input
                    type="text"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. 22 unused nights resold"
                    className="block w-full mt-0.5 border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  />
                </label>
              </div>
              <p className="text-[11px] text-gray-500">
                Up to {czk(stripe.refundableCzk)}.
                {split && split.unusedCzk > 0 && ` The ${split.unusedNights} unused nights still carry ${czk(split.unusedCzk)} of revenue — a refund comes off them first.`}
              </p>
              {amountError && <p className="text-[11px] text-red-600">{amountError}</p>}
              <div className="flex gap-2">
                <button
                  onClick={() => { setError(null); setConfirmKey(newIdempotencyKey()); }}
                  disabled={amount === "" || !!amountError}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  Review refund
                </button>
                <button onClick={() => setFormOpen(false)} className="px-3 py-1.5 text-xs text-gray-600 hover:underline">
                  Cancel
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-800">
                Refund <span className="font-semibold">{"hal" in parsed ? czk(parsed.hal / 100) : ""}</span>{" "}
                to the guest&apos;s card?
              </p>
              <ul className="text-[11px] text-gray-600 list-disc pl-4 space-y-0.5">
                <li>Stripe sends it back on the original payment of {czk(stripe.paidCzk)} — it can&apos;t be undone.</li>
                <li>It&apos;s recorded as this booking&apos;s refund: gross revenue drops by the same amount{split ? ", off the unused nights first" : ""}.</li>
                {reason.trim() && <li>Reason: {reason.trim()}</li>}
              </ul>
              {error && <p className="text-[11px] text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button
                  onClick={submitRefund}
                  disabled={busy}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50"
                >
                  {busy ? "Refunding…" : "Confirm refund"}
                </button>
                <button onClick={() => setConfirmKey(null)} disabled={busy} className="px-3 py-1.5 text-xs text-gray-600 hover:underline disabled:opacity-50">
                  Back
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
