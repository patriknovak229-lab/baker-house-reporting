"use client";

/**
 * "Pay later" floating panel in Transactions: the mode switch (off / manual /
 * auto — admin only) and every pay-later booking, problems first. Clicking a
 * row opens the booking's drawer, where the per-booking buttons live.
 */

import { useCallback, useEffect, useState } from "react";
import FloatingPanel from "@/components/shared/FloatingPanel";
import type { WebPaymentMode, WebPaymentView } from "@/types/webPayment";
import { formatCzk, formatDateLong, formatPragueDateTime } from "@/utils/webPayments/dates";

const MODE_HELP: Record<WebPaymentMode, string> = {
  off: "Nothing is charged or cancelled. New pay-later bookings are still recorded, and the tech chat is told when a payment falls due.",
  manual: "Due charges wait for you: use Charge now in the booking's drawer. Nothing is cancelled automatically.",
  auto: "Full timeline: charge 2 days before free cancellation ends, retry the next day at 16:00, cancel for non-payment after a 2nd decline.",
};

const STATUS_LABEL: Record<string, string> = {
  scheduled: "scheduled",
  failed: "FAILED",
  paid: "paid",
  paid_other: "paid other way",
  cancelled_unpaid: "cancelled – unpaid",
  cancelled: "booking cancelled",
  closed: "closed",
};

/**
 * Order of the "Needs attention" list — what should ops look at first?
 * Lower comes first; equal ranks fall back to the soonest 2nd attempt.
 */
function attentionRank(s: WebPaymentView, now: Date): number {
  // TODO(human): rank by urgency. Until then every row ranks 0 (soonest 2nd attempt first).
  void s;
  void now;
  return 0;
}

function nextStep(s: WebPaymentView): string {
  if (s.status === "scheduled") return `charge ${formatPragueDateTime(new Date(s.attempt1At), "en")}`;
  if (s.status === "failed") return `2nd charge ${formatPragueDateTime(new Date(s.attempt2EffectiveAt), "en")}`;
  if (s.paidAt) return `paid ${formatDateLong(s.paidAt.slice(0, 10), "en")}`;
  return s.cancelledAt ? `closed ${formatDateLong(s.cancelledAt.slice(0, 10), "en")}` : "—";
}

export default function PayLaterOverview({ onClose, onOpen }: { onClose: () => void; onOpen: (reservationNumber: string) => void }) {
  const [mode, setMode] = useState<WebPaymentMode | null>(null);
  const [rows, setRows] = useState<WebPaymentView[]>([]);
  const [canAct, setCanAct] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Bumped to reload after a mode change.
  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let alive = true;
    fetch("/api/web-payments", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not load (${res.status})`);
        const json = (await res.json()) as { mode: WebPaymentMode; schedules: WebPaymentView[]; canAct: boolean };
        if (!alive) return;
        setMode(json.mode);
        setRows(json.schedules);
        setCanAct(json.canAct);
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : "Could not load"));
    return () => {
      alive = false;
    };
  }, [version]);

  async function changeMode(next: WebPaymentMode) {
    if (next === mode) return;
    const warn =
      next === "auto"
        ? "Switch pay later to AUTO? Cards are then charged on schedule and unpaid bookings are cancelled after a 2nd decline."
        : `Switch pay later to ${next.toUpperCase()}?`;
    if (!window.confirm(warn)) return;
    setSaving(true);
    const res = await fetch("/api/web-payments/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    setSaving(false);
    if (!res.ok) setError(`Mode not saved (${res.status})`);
    load();
  }

  const open = rows.filter((r) => r.status === "scheduled" || r.status === "failed");
  const now = new Date();
  const attention = open
    .filter((r) => r.status === "failed" || r.attention)
    .sort((a, b) => attentionRank(a, now) - attentionRank(b, now) || a.attempt2EffectiveAt.localeCompare(b.attempt2EffectiveAt));
  const upcoming = open.filter((r) => !attention.includes(r)).sort((a, b) => a.attempt1At.localeCompare(b.attempt1At));
  const recent = rows.filter((r) => !open.includes(r)).slice(0, 15);

  const Row = ({ r }: { r: WebPaymentView }) => (
    <button
      onClick={() => onOpen(r.reservationNumber)}
      className="w-full text-left px-2.5 py-2 rounded-md hover:bg-gray-50 border border-transparent hover:border-gray-200"
    >
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium text-gray-900">
          {r.reservationNumber} · {r.guestName}
        </span>
        <span className={`text-xs ${r.status === "failed" ? "text-red-700 font-semibold" : "text-gray-500"}`}>{STATUS_LABEL[r.status]}</span>
      </div>
      <div className="text-xs text-gray-500">
        {formatDateLong(r.arrival, "en")} – {formatDateLong(r.departure, "en")} · {formatCzk(r.amountMinor)} · {nextStep(r)}
      </div>
      {r.attention && <div className="text-xs text-amber-700">⚠ {r.attention.replace(/_/g, " ")}</div>}
    </button>
  );

  return (
    <FloatingPanel
      id="pay-later"
      title="Pay later"
      icon={<span className="text-lg leading-none">🗓</span>}
      headerClassName="bg-sky-50"
      width={480}
      onClose={onClose}
    >
      <div className="space-y-4 p-4">
        {error && <p className="text-sm text-red-700">{error}</p>}

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1.5">Mode</h3>
          <div className="flex gap-1.5">
            {(["off", "manual", "auto"] as WebPaymentMode[]).map((m) => (
              <button
                key={m}
                disabled={!canAct || saving || mode === null}
                onClick={() => changeMode(m)}
                className={`px-3 py-1.5 rounded-md text-sm font-medium border transition-colors disabled:opacity-60 ${
                  mode === m ? "bg-sky-600 text-white border-sky-600" : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
          {mode && <p className="mt-1.5 text-xs text-gray-500">{MODE_HELP[mode]}</p>}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-red-600 mb-1">Needs attention ({attention.length})</h3>
          {attention.length === 0 ? <p className="text-xs text-gray-400">Nothing.</p> : attention.map((r) => <Row key={r.id} r={r} />)}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Scheduled ({upcoming.length})</h3>
          {upcoming.length === 0 ? <p className="text-xs text-gray-400">None.</p> : upcoming.map((r) => <Row key={r.id} r={r} />)}
        </section>

        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-1">Recently settled</h3>
          {recent.length === 0 ? <p className="text-xs text-gray-400">None yet.</p> : recent.map((r) => <Row key={r.id} r={r} />)}
        </section>
      </div>
    </FloatingPanel>
  );
}
