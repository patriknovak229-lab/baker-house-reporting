'use client';
import { useState, useMemo } from "react";
import type { Reservation, Channel, CleaningStatus, PaymentStatus } from "@/types/reservation";
import Badge from "@/components/shared/Badge";
import { formatDate, formatCurrency } from "@/utils/formatters";
import { getEffectiveFlags } from "@/utils/flagUtils";
import { countryCodeToFlag } from "@/utils/nationalityUtils";

type SortField = keyof Pick<
  Reservation,
  | "reservationNumber"
  | "firstName"
  | "channel"
  | "room"
  | "checkInDate"
  | "checkOutDate"
  | "reservationDate"
  | "numberOfNights"
  | "price"
  | "cleaningStatus"
  | "paymentStatus"
>;

interface ReservationTableProps {
  reservations: Reservation[];
  allReservations: Reservation[];
  unreadBookingIds: Set<number>;
  onRowClick: (reservation: Reservation) => void;
}

const PAGE_SIZE = 10;

function channelBadgeVariant(channel: Channel) {
  if (channel === "Booking.com") return "blue";
  if (channel === "Airbnb") return "coral";
  if (channel === "Direct-Phone") return "teal";
  return "green";
}

function cleaningBadgeVariant(status: CleaningStatus) {
  if (status === "Pending") return "amber";
  if (status === "In Progress") return "blue";
  return "green";
}

function paymentBadgeVariant(status: PaymentStatus) {
  if (status === "Unpaid") return "red";
  if (status === "Partially Paid") return "amber";
  if (status === "Paid") return "green";
  return "gray";
}

function ratingEmoji(status: Reservation["ratingStatus"]): string {
  if (status === "good") return "😊";
  if (status === "bad") return "😡";
  return "";
}

type SortDir = "asc" | "desc";

function SortIcon({
  field,
  sortField,
  sortDir,
}: {
  field: string;
  sortField: string;
  sortDir: SortDir;
}) {
  if (field !== sortField) {
    return (
      <svg
        className="w-3.5 h-3.5 text-gray-300 ml-1 inline"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"
        />
      </svg>
    );
  }
  return sortDir === "asc" ? (
    <svg
      className="w-3.5 h-3.5 text-indigo-600 ml-1 inline"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
    </svg>
  ) : (
    <svg
      className="w-3.5 h-3.5 text-indigo-600 ml-1 inline"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

export default function ReservationTable({
  reservations,
  allReservations,
  unreadBookingIds,
  onRowClick,
}: ReservationTableProps) {
  const [sortField, setSortField] = useState<SortField>("reservationDate");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);

  function handleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
    setPage(1);
  }

  const sorted = useMemo(() => {
    return [...reservations].sort((a, b) => {
      const av = a[sortField];
      const bv = b[sortField];
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [reservations, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const columns: { key: SortField; label: string; align?: "right" }[] = [
    { key: "reservationNumber", label: "Res. #" },
    { key: "firstName", label: "Guest" },
    { key: "channel", label: "Channel" },
    { key: "room", label: "Room" },
    { key: "reservationDate", label: "Booked" },
    { key: "checkInDate", label: "Check-in" },
    { key: "checkOutDate", label: "Check-out" },
    { key: "numberOfNights", label: "Nights", align: "right" },
    { key: "price", label: "Price", align: "right" },
    { key: "cleaningStatus", label: "Cleaning" },
    { key: "paymentStatus", label: "Payment" },
  ];

  return (
    <div>
      <div className="rounded-lg border border-gray-200 overflow-hidden">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`px-3 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide cursor-pointer select-none whitespace-nowrap hover:bg-gray-100 transition-colors ${col.align === "right" ? "text-right" : "text-left"}`}
                >
                  {col.label}
                  <SortIcon field={col.key} sortField={sortField} sortDir={sortDir} />
                </th>
              ))}
              <th className="px-3 py-2.5 text-xs font-medium text-gray-500 uppercase tracking-wide text-left">
                Flags
              </th>
            </tr>
          </thead>
          <tbody className="bg-white divide-y divide-gray-100">
            {paginated.length === 0 ? (
              <tr>
                <td colSpan={12} className="px-4 py-10 text-center text-gray-400 text-sm">
                  No reservations match your filters.
                </td>
              </tr>
            ) : (
              paginated.map((res) => {
                const effectiveFlags = getEffectiveFlags(res, allReservations);
                const flag = countryCodeToFlag(res.nationality);
                const emoji = ratingEmoji(res.ratingStatus);

                const beds24Id = parseInt(res.reservationNumber.slice(3));
                const hasUnread = unreadBookingIds.has(beds24Id);

                return (
                  <tr
                    key={res.reservationNumber}
                    onClick={() => onRowClick(res)}
                    className="hover:bg-indigo-50 cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-3 font-mono text-xs whitespace-nowrap">
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">{res.reservationNumber}</span>
                        {res.bookingTimestamp &&
                          Date.now() - new Date(res.bookingTimestamp).getTime() < 24 * 60 * 60 * 1000 && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500 text-white animate-pulse">
                            New
                          </span>
                        )}
                        {hasUnread && (
                          <span
                            title="Unread message from guest"
                            className="relative inline-flex items-center justify-center w-5 h-5 rounded-full bg-indigo-600 text-white shrink-0"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                                d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                              />
                            </svg>
                            <span className="absolute -top-0.5 -right-0.5 flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
                            </span>
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 font-medium text-gray-900 whitespace-nowrap">
                      <span className="mr-1" title={res.nationality}>
                        {flag}
                      </span>
                      {res.firstName} {res.lastName}
                      {emoji && (
                        <span className="ml-1.5 text-base leading-none" title={res.ratingStatus}>
                          {emoji}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Badge variant={channelBadgeVariant(res.channel)} size="xs">
                        {res.channel}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 text-gray-600 whitespace-nowrap">{res.room}</td>
                    <td className="px-3 py-3 text-gray-500 whitespace-nowrap text-xs">
                      {formatDate(res.reservationDate)}
                    </td>
                    <td className="px-3 py-3 text-gray-600 whitespace-nowrap">
                      {formatDate(res.checkInDate)}
                    </td>
                    <td className="px-3 py-3 text-gray-600 whitespace-nowrap">
                      {formatDate(res.checkOutDate)}
                    </td>
                    <td className="px-3 py-3 text-gray-600 text-right whitespace-nowrap">
                      {res.numberOfNights}
                    </td>
                    <td className="px-3 py-3 text-gray-900 font-medium text-right whitespace-nowrap">
                      {formatCurrency(res.price)}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <Badge variant={cleaningBadgeVariant(res.cleaningStatus)} size="xs">
                        {res.cleaningStatus}
                      </Badge>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex items-center gap-1">
                        <Badge variant={paymentBadgeVariant(res.paymentStatusOverride ?? res.paymentStatus)} size="xs">
                          {res.paymentStatusOverride ?? res.paymentStatus}
                        </Badge>
                        {res.paymentStatusOverride && (
                          <span className="text-[10px] text-amber-500" title="Manually overridden">M</span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap">
                      <div className="flex flex-wrap gap-1">
                        {effectiveFlags.map((flag) => (
                          <Badge
                            key={flag}
                            variant={
                              flag === "Repeat Customer"
                                ? "indigo"
                                : flag === "High Value Customer"
                                  ? "gold"
                                  : "red"
                            }
                            size="xs"
                          >
                            {flag === "Repeat Customer"
                              ? "↩ Repeat"
                              : flag === "High Value Customer"
                                ? "★ High Value"
                                : "⚠ Problem"}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between mt-3 text-sm text-gray-500">
        <span>
          {sorted.length === 0
            ? "0 results"
            : `Showing ${(page - 1) * PAGE_SIZE + 1}–${Math.min(page * PAGE_SIZE, sorted.length)} of ${sorted.length}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            ← Prev
          </button>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <button
              key={p}
              onClick={() => setPage(p)}
              className={`w-8 h-7 rounded border text-xs ${
                p === page
                  ? "bg-indigo-600 text-white border-indigo-600"
                  : "border-gray-200 hover:bg-gray-50"
              }`}
            >
              {p}
            </button>
          ))}
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="px-2.5 py-1 rounded border border-gray-200 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed text-xs"
          >
            Next →
          </button>
        </div>
      </div>
    </div>
  );
}
