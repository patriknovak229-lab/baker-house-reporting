"use client";

/**
 * Drawer card for a website booking paid later (utils/webPayments): what was
 * agreed, when the card is charged, what happened so far — and, for admins,
 * the buttons: Charge now, send / copy the pay link, change the agreed amount,
 * "don't auto-cancel", mark paid another way, cancel for non-payment, close.
 *
 * Every button goes through POST /api/web-payments/<id>, which runs the same
 * claim → Stripe check → idempotent charge as the scheduled job, so nothing
 * here can charge twice. Renders nothing for bookings without a schedule.
 */

import { useCallback, useEffect, useState } from "react";
import type { WebPaymentAttention, WebPaymentEvent, WebPaymentStatus, WebPaymentView } from "@/types/webPayment";
import { formatCzk, formatDateLong, formatPragueDateTime } from "@/utils/webPayments/dates";

const STATUS: Record<WebPaymentStatus, { label: string; cls: string }> = {
  scheduled: { label: "Payment scheduled", cls: "bg-sky-100 text-sky-800" },
  failed: { label: "Payment failed", cls: "bg-red-100 text-red-800" },
  paid: { label: "Paid", cls: "bg-emerald-100 text-emerald-800" },
  paid_other: { label: "Paid another way", cls: "bg-emerald-100 text-emerald-800" },
  cancelled_unpaid: { label: "Cancelled – unpaid", cls: "bg-gray-200 text-gray-800" },
  cancelled: { label: "Booking cancelled", cls: "bg-gray-100 text-gray-700" },
  closed: { label: "Closed", cls: "bg-gray-100 text-gray-700" },
};

const ATTENTION: Record<WebPaymentAttention, string> = {
  amount_mismatch: "Beds24 price differs from the agreed amount. The agreed amount will be charged unless you change it.",
  beds24_shows_paid: "Beds24 shows this booking paid, but the card was never charged. Charging is blocked until you check it.",
  technical_error: "A technical problem. Nothing was charged by it; it is retried on every run.",
  needs_decision: "Declined twice and not cancelled automatically — decide below.",
  beds24_sync_pending: "Paid, but Beds24 is not updated yet — retried automatically.",
  after_deadline: "Still unpaid after free cancellation ended. Nothing is cancelled automatically — decide below.",
  paid_elsewhere: "The app already counts this booking as paid (drawer status or a payment link). Nothing is charged or cancelled until you check it.",
  amount_paid_differs: "The guest paid a different amount than agreed. Beds24 shows what was actually paid — settle the difference.",
  paid_booking_cancelled: "Paid, but the booking is cancelled in Beds24. Refund the guest if the cancellation stands.",
  reinstated_unpaid: "Cancelled here but active again in Beds24, unpaid — the saved card was removed. Send a payment link or cancel it.",
};

const at = (iso: string | null) => (iso ? formatPragueDateTime(new Date(iso), "en") : "—");
const cap = (s: string | null) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "Card");

type Result = { ok: boolean; text: string };

function describe(action: string, ok: boolean, body: { error?: string; detail?: { outcome?: string; code?: string; message?: string; reason?: string } | null }): Result {
  if (!ok) return { ok: false, text: body.error ?? "Failed" };
  const d = body.detail;
  if (action !== "charge_now" || !d?.outcome) return { ok: true, text: "Done." };
  switch (d.outcome) {
    case "paid":
      return { ok: true, text: "Charged ✓ — receipt emailed, Beds24 marked paid." };
    case "already_paid":
      return { ok: true, text: "Already paid — nothing was charged again." };
    case "declined":
      return { ok: false, text: `Declined by the bank (${d.code}). Send the pay link or phone the guest.` };
    case "busy":
      return { ok: false, text: "Another charge is running right now — try again in a minute." };
    case "blocked":
      return { ok: false, text: d.reason ?? "Blocked." };
    case "in_progress":
      return { ok: false, text: "Stripe is still processing a payment — check again shortly." };
    case "unknown":
      return { ok: false, text: "No answer from Stripe. The next run replays the same request — it can't charge twice." };
    default:
      return { ok: false, text: `${d.outcome}${d.message ? `: ${d.message}` : ""}` };
  }
}

export function PayLaterPanel({ reservationNumber, canAct }: { reservationNumber: string; canAct: boolean }) {
  const [schedule, setSchedule] = useState<WebPaymentView | null>(null);
  const [events, setEvents] = useState<WebPaymentEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [form, setForm] = useState<null | "amount" | "paid_other" | "close">(null);
  const [amount, setAmount] = useState("");
  const [text, setText] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/web-payments?reservation=${encodeURIComponent(reservationNumber)}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { schedule: WebPaymentView | null; events?: WebPaymentEvent[] };
    setSchedule(json.schedule);
    setEvents(json.events ?? []);
  }, [reservationNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!schedule) return null;
  const s = schedule;
  const open = s.status === "scheduled" || s.status === "failed";
  const card = s.cardLast4 ? `${cap(s.cardBrand)} •••• ${s.cardLast4}` : "Card";

  async function act(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(String(body.action));
    setResult(null);
    try {
      const res = await fetch(`/api/web-payments/${s.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      setResult(describe(String(body.action), res.ok, json));
      if (res.ok) {
        setForm(null);
        setAmount("");
        setText("");
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "Request failed" });
    } finally {
      setBusy(null);
      await load();
    }
  }

  const btn = "px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors disabled:opacity-50";
  const disabled = !!busy || s.charging;

  return (
    <div className="mt-3 rounded-lg border border-sky-200 bg-white">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-sky-100 bg-sky-50 rounded-t-lg">
        <span className="text-sm font-semibold text-sky-900">🗓 Pay later</span>
        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${STATUS[s.status].cls}`}>{STATUS[s.status].label}</span>
      </div>

      {s.charging && <p className="px-3 py-2 text-xs bg-sky-50 text-sky-800 border-b border-sky-100">⏳ A charge is running right now…</p>}
      {s.attention && (
        <div className="px-3 py-2 text-xs bg-amber-50 text-amber-900 border-b border-amber-100">
          ⚠ {ATTENTION[s.attention]}
          {s.attentionDetail && <span className="block text-amber-700 mt-0.5">{s.attentionDetail}</span>}
        </div>
      )}

      <dl className="px-3 py-2 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-gray-500">Agreed amount</dt>
        <dd className="text-gray-900 font-medium">{formatCzk(s.amountMinor)}</dd>
        <dt className="text-gray-500">Card</dt>
        <dd className="text-gray-900">
          {card}
          {s.cardExpMonth && s.cardExpYear ? ` · exp ${String(s.cardExpMonth).padStart(2, "0")}/${String(s.cardExpYear).slice(-2)}` : ""}
          {!s.stripePaymentMethodId && <span className="text-gray-500"> · removed from Stripe</span>}
        </dd>
        <dt className="text-gray-500">Free cancellation</dt>
        <dd className="text-gray-900">until 23:59 on {formatDateLong(s.deadlineDate, "en")}</dd>
        {open && (
          <>
            <dt className="text-gray-500">1st charge</dt>
            <dd className="text-gray-900">{at(s.attempt1At)}</dd>
            <dt className="text-gray-500">2nd charge</dt>
            <dd className="text-gray-900">
              {s.status === "failed" ? at(s.attempt2EffectiveAt) : `${at(s.attempt2EffectiveAt)} (only if the 1st is declined)`}
            </dd>
          </>
        )}
        {s.retryNotBefore && Date.parse(s.retryNotBefore) > Date.now() && (
          <>
            <dt className="text-gray-500">Next try</dt>
            <dd className="text-amber-700">
              not before {at(s.retryNotBefore)} (technical problem, {s.retryCount}× in a row)
            </dd>
          </>
        )}
        {s.lastDecline && (
          <>
            <dt className="text-gray-500">Last decline</dt>
            <dd className="text-red-700">
              {s.lastDecline.code} · {at(s.lastDecline.at)}
            </dd>
          </>
        )}
        {s.paidAt && (
          <>
            <dt className="text-gray-500">Paid</dt>
            <dd className="text-gray-900">
              {at(s.paidAt)} · {s.paidVia ?? "—"}
              {s.paidAmountMinor ? ` · ${formatCzk(s.paidAmountMinor)}` : ""}
            </dd>
          </>
        )}
        <dt className="text-gray-500">Emails</dt>
        <dd className="text-gray-900">{Object.keys(s.emails).join(", ") || "—"}</dd>
        {s.noAutoCancel && (
          <>
            <dt className="text-gray-500">Auto-cancel</dt>
            <dd className="text-amber-700 font-medium">off for this booking</dd>
          </>
        )}
      </dl>

      {canAct && open && (
        <div className="px-3 pb-3 flex flex-wrap gap-1.5">
          <button
            className={`${btn} bg-emerald-600 hover:bg-emerald-700 text-white`}
            disabled={disabled}
            onClick={() => act({ action: "charge_now" }, `Charge ${formatCzk(s.amountMinor)} to ${card} now?`)}
          >
            {busy === "charge_now" ? "Charging…" : "Charge now"}
          </button>
          <button
            className={`${btn} bg-white border border-indigo-200 text-indigo-700 hover:bg-indigo-50`}
            disabled={disabled}
            onClick={() => act({ action: "send_link" }, `Email the payment link to ${s.guestEmail}?`)}
          >
            Send pay link
          </button>
          <button
            className={`${btn} bg-white border border-gray-200 text-gray-700 hover:bg-gray-50`}
            onClick={async () => {
              await navigator.clipboard.writeText(s.payUrl).catch(() => {});
              setResult({ ok: true, text: "Pay link copied." });
            }}
          >
            Copy link
          </button>
          <button
            className={`${btn} bg-white border border-gray-200 text-gray-700 hover:bg-gray-50`}
            disabled={disabled}
            onClick={() => {
              setForm(form === "amount" ? null : "amount");
              setAmount(String(s.amountMinor / 100));
            }}
          >
            Change amount
          </button>
          <button
            className={`${btn} bg-white border ${s.noAutoCancel ? "border-amber-300 text-amber-800" : "border-gray-200 text-gray-700"} hover:bg-gray-50`}
            disabled={disabled}
            onClick={() => act({ action: "set_no_auto_cancel", value: !s.noAutoCancel })}
          >
            {s.noAutoCancel ? "Allow auto-cancel" : "Don't auto-cancel"}
          </button>
          <button
            className={`${btn} bg-white border border-gray-200 text-gray-700 hover:bg-gray-50`}
            disabled={disabled}
            onClick={() => setForm(form === "paid_other" ? null : "paid_other")}
          >
            Paid another way
          </button>
          <button
            className={`${btn} bg-white border border-red-200 text-red-700 hover:bg-red-50`}
            disabled={disabled}
            onClick={() =>
              act(
                { action: "cancel_now" },
                "Cancel this booking in Beds24 for non-payment and email the guest? The dates become free again.",
              )
            }
          >
            Cancel booking
          </button>
          <button
            className={`${btn} bg-white border border-gray-200 text-gray-500 hover:bg-gray-50`}
            disabled={disabled}
            onClick={() => setForm(form === "close" ? null : "close")}
            title="Stop the schedule without charging or cancelling (e.g. a special arrangement). The saved card is removed."
          >
            Close schedule
          </button>
        </div>
      )}

      {form && (
        <div className="mx-3 mb-3 p-2.5 rounded-md bg-gray-50 border border-gray-200 space-y-2">
          {form === "amount" && (
            <input
              type="number"
              min={1}
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
              placeholder="New agreed amount (Kč)"
            />
          )}
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
            placeholder={form === "paid_other" ? "How was it paid? (e.g. bank transfer 3 Dec)" : "Reason (required)"}
          />
          <button
            className={`${btn} bg-indigo-600 hover:bg-indigo-700 text-white`}
            disabled={disabled || !text.trim() || (form === "amount" && !(Number(amount) > 0))}
            onClick={() => {
              if (form === "amount") void act({ action: "set_amount", amountCzk: Number(amount), reason: text });
              if (form === "paid_other") void act({ action: "mark_paid_other", note: text });
              if (form === "close") void act({ action: "close", reason: text });
            }}
          >
            Save
          </button>
        </div>
      )}

      {result && (
        <p className={`mx-3 mb-2 text-xs ${result.ok ? "text-emerald-700" : "text-red-700"}`}>{result.text}</p>
      )}

      {events.length > 0 && (
        <details className="px-3 pb-2 text-xs">
          <summary className="cursor-pointer text-gray-500">History ({events.length})</summary>
          <ul className="mt-1 space-y-0.5 max-h-48 overflow-y-auto">
            {events.map((e) => (
              <li key={e.id} className="text-gray-600">
                <span className="text-gray-400">{at(e.at)}</span> · {e.type}
                {typeof e.data.code === "string" ? ` (${e.data.code})` : ""}
                {typeof e.data.kind === "string" ? ` (${e.data.kind})` : ""} · <span className="text-gray-400">{e.actor}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
