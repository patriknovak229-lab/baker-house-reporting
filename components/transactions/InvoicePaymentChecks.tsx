"use client";

/**
 * "Check invoice payment" — corporate invoices past their due date (from the
 * day after) with no payment recorded. The pill lives in the Transactions pill
 * row; this is the panel it opens.
 *
 * A payment is recorded either by Accounting's bank auto-match on the invoice's
 * revenue record (the VS is the invoice number's digits), which the server
 * syncs before answering, or by hand here with "Mark paid". "Snooze" hides a
 * row for a few days when the company has promised to pay.
 */

import { useState } from "react";
import type { CorporateInvoice } from "@/utils/corporateInvoice";
import { monthLabel } from "@/utils/corporateInvoice";
import { addDays } from "@/utils/corporateSchedule";
import { formatStayDate } from "@/utils/corporateShared";
import { pragueToday } from "@/utils/periodUtils";
import { czkExact, downloadInvoicePdf, invoiceAction, invoiceDate } from "@/components/corporate/invoiceApi";

export interface OverdueInvoice extends CorporateInvoice {
  companyName: string;
  daysPastDue: number;
}

const COLUMNS = ["Invoice", "Company", "Period", "Amount", "Due", "Overdue", "Sent to", ""];

export default function InvoicePaymentChecks({
  rows,
  canChange,
  onChanged,
}: {
  rows: OverdueInvoice[];
  canChange: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const btn = "px-2 py-1 rounded border text-[11px] font-medium disabled:opacity-40";

  return (
    <div className="rounded-lg border border-red-200 bg-red-50 overflow-hidden">
      <div className="px-4 py-2 border-b border-red-200 text-xs text-red-700">
        Corporate invoices past their due date with no payment recorded. Check the bank: a transfer matched in Accounting clears the row on its own;
        otherwise <span className="font-semibold">Mark paid</span>, send a reminder copy, or snooze while the company sorts it out.
      </div>
      {error && <div className="px-4 py-2 text-xs text-red-800 bg-red-100 border-b border-red-200">{error}</div>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-red-200">
              {COLUMNS.map((h, i) => (
                <th key={i} className="px-4 py-2 text-xs font-medium text-red-700 uppercase tracking-wide text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-red-100">
            {rows.map((inv) => (
              <tr key={inv.id}>
                <td className="px-4 py-2 font-mono text-xs text-red-800 whitespace-nowrap">{inv.invoiceNumber}</td>
                <td className="px-4 py-2 font-medium text-red-900 whitespace-nowrap">{inv.companyName}</td>
                <td className="px-4 py-2 text-xs text-red-700 whitespace-nowrap">
                  {inv.billedMonth ? monthLabel(inv.billedMonth) : `${formatStayDate(inv.periodFrom)} → ${formatStayDate(addDays(inv.periodTo, 1))}`}
                </td>
                <td className="px-4 py-2 text-red-900 whitespace-nowrap tabular-nums">{inv.amountCzk !== null ? czkExact(inv.amountCzk) : "—"}</td>
                <td className="px-4 py-2 text-xs text-red-700 whitespace-nowrap">{invoiceDate(inv.dueDate)}</td>
                <td className="px-4 py-2 text-xs font-semibold text-red-700 whitespace-nowrap">
                  {inv.daysPastDue} {inv.daysPastDue === 1 ? "day" : "days"}
                </td>
                <td className="px-4 py-2 text-xs text-red-700 whitespace-nowrap">
                  {inv.status === "issued" ? <span className="text-amber-700">never emailed</span> : inv.sentTo}
                </td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <div className="inline-flex gap-1">
                    <button
                      onClick={() => void run(`pdf:${inv.id}`, () => downloadInvoicePdf(inv.id))}
                      disabled={busy !== null}
                      className={`${btn} border-red-200 text-red-700 bg-white hover:bg-red-100`}
                    >
                      PDF
                    </button>
                    {canChange && (
                      <>
                        <button
                          onClick={() => {
                            const d = window.prompt(`Mark ${inv.invoiceNumber} (${inv.companyName}) as paid. Payment date (YYYY-MM-DD):`, pragueToday());
                            if (d !== null) void run(`paid:${inv.id}`, () => invoiceAction(inv.id, "markPaid", { paidAt: d.trim() }));
                          }}
                          disabled={busy !== null}
                          className={`${btn} border-green-300 text-green-700 bg-white hover:bg-green-50`}
                        >
                          {busy === `paid:${inv.id}` ? "…" : "Mark paid"}
                        </button>
                        <button
                          onClick={() => {
                            const to = inv.sentTo ?? inv.billTo?.billingEmail ?? "the invoice email";
                            if (window.confirm(`Send ${inv.invoiceNumber} again to ${to} as a reminder?`)) {
                              void run(`send:${inv.id}`, () => invoiceAction(inv.id, "send"));
                            }
                          }}
                          disabled={busy !== null}
                          className={`${btn} border-red-200 text-red-700 bg-white hover:bg-red-100`}
                        >
                          {busy === `send:${inv.id}` ? "Sending…" : inv.status === "issued" ? "Send" : "Resend"}
                        </button>
                        <button
                          onClick={() => void run(`snooze:${inv.id}`, () => invoiceAction(inv.id, "snooze", { days: 3 }))}
                          disabled={busy !== null}
                          title="Hide for 3 days"
                          className={`${btn} border-red-200 text-red-600 bg-white hover:bg-red-100`}
                        >
                          Snooze 3 d
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
