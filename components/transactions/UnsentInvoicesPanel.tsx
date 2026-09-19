"use client";

/**
 * The "N invoices unsent" pill's panel: past stays the guest asked to be
 * invoiced for, where nothing has been emailed. Rows are click-to-open so the
 * operator lands straight in the reservation's Invoice section, where
 * "Issue anyway" finishes the job on partial details.
 *
 * Its own file rather than another block inside TransactionsPage: the table is
 * self-contained, and keeping it here means it can be rendered and checked on
 * its own.
 */

import type { Reservation } from "@/types/reservation";
import type { InvoiceMandatoryField, UnsentInvoice } from "@/utils/invoiceUtils";

/** Short labels for the "Short of" column. */
const MISSING_LABEL: Record<InvoiceMandatoryField, string> = {
  companyName: "company name",
  companyId: "IČO / VAT",
  email: "billing email",
};

const COLUMNS = ["Reservation", "Guest", "Checked out", "Overdue", "Status", "Short of"];

export default function UnsentInvoicesPanel({
  rows,
  onSelect,
}: {
  rows: UnsentInvoice[];
  onSelect: (reservation: Reservation) => void;
}) {
  return (
    <div className="rounded-lg border border-red-200 bg-red-50 overflow-hidden">
      <div className="px-4 py-2 border-b border-red-200 text-xs text-red-700">
        The guest asked for an invoice and the stay is over, but nothing has been emailed. Open the
        reservation and use <span className="font-semibold">Issue anyway</span> in the Invoice section to
        send it with whatever details you have — only a billing email is strictly required.
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-red-200">
            {COLUMNS.map((h) => (
              <th
                key={h}
                className="px-4 py-2 text-xs font-medium text-red-700 uppercase tracking-wide text-left"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-red-100">
          {rows.map(({ reservation, checkOut, daysOverdue, missing, awaitingGuest }) => (
            <tr
              key={reservation.reservationNumber}
              className="cursor-pointer hover:bg-red-100"
              onClick={() => onSelect(reservation)}
            >
              <td className="px-4 py-2 font-mono text-xs text-red-800 whitespace-nowrap">
                {reservation.reservationNumber}
              </td>
              <td className="px-4 py-2 font-medium text-red-900 whitespace-nowrap">
                {reservation.firstName} {reservation.lastName}
              </td>
              <td className="px-4 py-2 text-red-700 text-xs whitespace-nowrap">{checkOut}</td>
              <td className="px-4 py-2 text-red-700 text-xs whitespace-nowrap">
                {daysOverdue} {daysOverdue === 1 ? "day" : "days"}
              </td>
              <td className="px-4 py-2 text-xs whitespace-nowrap">
                {awaitingGuest ? (
                  <span className="text-amber-700">agent still waiting on guest</span>
                ) : (
                  <span className="text-red-600">{reservation.invoiceStatus.toLowerCase()}</span>
                )}
              </td>
              <td className="px-4 py-2 text-xs">
                {missing.length === 0 ? (
                  <span className="text-red-500">nothing — just needs sending</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {missing.map((f) => (
                      <span
                        key={f}
                        className="px-1.5 py-0.5 rounded bg-red-200/70 text-red-900 font-medium"
                      >
                        {MISSING_LABEL[f]}
                      </span>
                    ))}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
