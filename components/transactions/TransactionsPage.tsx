'use client';
import { useState, useMemo, useEffect, useCallback } from "react";
import type { Reservation, PaymentStatus, RatingStatus, InvoiceStatus, InvoiceData, CustomerFlag, Issue, IssueCategory } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import type { Voucher } from "@/types/voucher";
import FilterPanel, { defaultFilters } from "./FilterPanel";
import OccupancyCalendar from "./OccupancyCalendar";
import type { Filters } from "./FilterPanel";
import ReservationTable from "./ReservationTable";
import ReservationDrawer from "./ReservationDrawer";
import CreateBookingModal from "./CreateBookingModal";
import PaymentLinkModal from "./PaymentLinkModal";
import CreateVoucherModal from "./CreateVoucherModal";
import PriceCheckModal from "./PriceCheckModal";
import { getEffectiveFlags } from "@/utils/flagUtils";
import { normalizeForSearch } from "@/utils/stringUtils";
import { useSession } from "next-auth/react";
import { canMutate } from "@/utils/roles";
import type { Role } from "@/utils/roles";

// ─── Local state persistence (Redis-backed) ──────────────────────────────────
// Locally managed fields are not stored in Beds24. They are persisted in Redis
// via /api/local-state so they are shared across devices and browsers.

type LocalFields = {
  additionalEmail?: string;
  phone?: string;
  paymentStatusOverride?: PaymentStatus | null;
  notes?: string;
  manualFlagOverrides?: Partial<Record<CustomerFlag, boolean>>;
  ratingStatus?: RatingStatus;
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
  issues?: Issue[];
};

function extractLocalFields(r: Reservation): LocalFields {
  const local: LocalFields = {};
  if (r.additionalEmail) local.additionalEmail = r.additionalEmail;
  if (r.phone) local.phone = r.phone;
  if (r.paymentStatusOverride !== null) local.paymentStatusOverride = r.paymentStatusOverride;
  if (r.notes) local.notes = r.notes;
  if (Object.keys(r.manualFlagOverrides).length > 0) local.manualFlagOverrides = r.manualFlagOverrides;
  if (r.ratingStatus !== "none") local.ratingStatus = r.ratingStatus;
  if (r.invoiceData) local.invoiceData = r.invoiceData;
  if (r.invoiceStatus !== "Not Issued") local.invoiceStatus = r.invoiceStatus;
  if (r.issues && r.issues.length > 0) local.issues = r.issues;
  return local;
}

function mergeLocal(reservations: Reservation[], state: Record<string, LocalFields>): Reservation[] {
  return reservations.map((r) => {
    const local = state[r.reservationNumber];
    return local ? { ...r, ...local } : r;
  });
}

// Fire-and-forget — UI is already updated optimistically before this resolves
async function persistOverride(reservationNumber: string, fields: LocalFields): Promise<void> {
  try {
    await fetch('/api/local-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationNumber, fields }),
    });
  } catch {
    // Non-fatal — user sees the change immediately; worst case it doesn't persist
  }
}

const UNREAD_POLL_INTERVAL_MS = 30_000;

export default function TransactionsPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: Role } | undefined)?.role;

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [unreadBookingIds, setUnreadBookingIds] = useState<Set<number>>(new Set());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [showPriceCheck, setShowPriceCheck] = useState(false);
  const [paymentAlertOpen, setPaymentAlertOpen] = useState(false);

  const fetchReservations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [bookingsRes, localStateRes, additionalPaymentsRes, vouchersRes] = await Promise.all([
        fetch("/api/bookings"),
        fetch("/api/local-state"),
        fetch("/api/stripe/additional-payments"),
        fetch("/api/vouchers"),
      ]);
      if (!bookingsRes.ok) {
        const json = await bookingsRes.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${bookingsRes.status}`);
      }
      const data: Reservation[] = await bookingsRes.json();
      const localState: Record<string, LocalFields> = localStateRes.ok
        ? await localStateRes.json().catch(() => ({}))
        : {};
      const allAdditionalPayments: AdditionalPayment[] = additionalPaymentsRes.ok
        ? await additionalPaymentsRes.json().catch(() => [])
        : [];
      const allVouchers: Voucher[] = vouchersRes.ok
        ? await vouchersRes.json().catch(() => [])
        : [];

      // Group additional payments by reservationNumber for merge
      const apByRes = new Map<string, AdditionalPayment[]>();
      for (const ap of allAdditionalPayments) {
        const group = apByRes.get(ap.reservationNumber) ?? [];
        group.push(ap);
        apByRes.set(ap.reservationNumber, group);
      }

      // Group vouchers by reservationNumber for merge
      const vByRes = new Map<string, Voucher[]>();
      for (const v of allVouchers) {
        if (v.reservationNumber) {
          const group = vByRes.get(v.reservationNumber) ?? [];
          group.push(v);
          vByRes.set(v.reservationNumber, group);
        }
      }

      const merged = mergeLocal(data, localState).map((r) => {
        const aps = apByRes.get(r.reservationNumber);
        const vs = vByRes.get(r.reservationNumber);
        return { ...r, ...(aps ? { additionalPayments: aps } : {}), ...(vs ? { vouchers: vs } : {}) };
      });
      setReservations(merged);
      setLastSynced(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load reservations");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  // Poll for unread guest messages every 30s
  useEffect(() => {
    async function pollUnread() {
      try {
        const res = await fetch('/api/messages/unread');
        if (!res.ok) return;
        const { bookingIds }: { bookingIds: number[] } = await res.json();
        setUnreadBookingIds(new Set(bookingIds));
      } catch {
        // fail silently — badge just won't update until next poll
      }
    }
    pollUnread();
    const id = setInterval(pollUnread, UNREAD_POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [taskAlertOpen, setTaskAlertOpen] = useState(false);

  interface DataIssue {
    reservation: Reservation;
    problems: string[];
  }

  // ── Unresolved issues actionable within the next 7 days ─────────────────────
  const upcomingUnresolved = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    const in7 = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const items: { reservation: Reservation; issue: Issue }[] = [];
    for (const r of reservations) {
      for (const issue of r.issues ?? []) {
        if (!issue.resolved && issue.actionableDate >= today && issue.actionableDate <= in7) {
          items.push({ reservation: r, issue });
        }
      }
    }
    return items.sort((a, b) => a.issue.actionableDate.localeCompare(b.issue.actionableDate));
  }, [reservations]);

  // ── Unpaid additional payments (Stripe payment links not yet paid) ───────────
  const unpaidAdditionalPayments = useMemo(() => {
    const items: { reservation: Reservation; payment: AdditionalPayment }[] = [];
    for (const r of reservations) {
      for (const ap of r.additionalPayments ?? []) {
        if (ap.status === "unpaid") {
          items.push({ reservation: r, payment: ap });
        }
      }
    }
    return items.sort((a, b) => a.payment.createdAt.localeCompare(b.payment.createdAt));
  }, [reservations]);

  const dataIssues = useMemo<DataIssue[]>(() => {
    return reservations
      .filter((r) => r.paymentStatus !== "Refunded")
      .flatMap((r) => {
        const problems: string[] = [];
        if (r.channel === "Booking.com") {
          if (r.commissionAmount === 0) problems.push("Commission missing");
          if (r.paymentChargeAmount === 0) problems.push("Payment fee missing");
        }
        if (r.channel === "Airbnb") {
          if (r.commissionAmount === 0) problems.push("Host fee missing");
        }
        return problems.length > 0 ? [{ reservation: r, problems }] : [];
      });
  }, [reservations]);

  const filtered = useMemo(() => {
    return reservations.filter((res) => {
      // Search (diacritic-insensitive)
      if (search.trim()) {
        const q = normalizeForSearch(search);
        const fullName = normalizeForSearch(`${res.firstName} ${res.lastName}`);
        if (
          !res.reservationNumber.toLowerCase().includes(q) &&
          !fullName.includes(q) &&
          !normalizeForSearch(res.email).includes(q)
        ) {
          return false;
        }
      }

      // Channel filter
      if (filters.channels.length > 0 && !filters.channels.includes(res.channel)) return false;

      // Room filter — also match if any linked room (package booking) matches
      if (
        filters.rooms.length > 0 &&
        !filters.rooms.includes(res.room) &&
        !res.linkedRooms?.some((r) => filters.rooms.includes(r))
      ) return false;

      // Cleaning status
      if (
        filters.cleaningStatuses.length > 0 &&
        !filters.cleaningStatuses.includes(res.cleaningStatus)
      )
        return false;

      // Payment status
      if (
        filters.paymentStatuses.length > 0 &&
        !filters.paymentStatuses.includes(res.paymentStatus)
      )
        return false;

      // Customer flags — uses effective flags (auto + overrides)
      if (filters.customerFlags.length > 0) {
        const effective = getEffectiveFlags(res, reservations);
        const hasAll = filters.customerFlags.every((f) => effective.includes(f));
        if (!hasAll) return false;
      }

      // Date range
      if (filters.checkInFrom && res.checkInDate < filters.checkInFrom) return false;
      if (filters.checkInTo && res.checkInDate > filters.checkInTo) return false;

      return true;
    });
  }, [reservations, search, filters]);

  function handleUpdate(updated: Reservation) {
    setReservations((prev) =>
      prev.map((r) => r.reservationNumber === updated.reservationNumber ? updated : r)
    );
    setSelectedReservation(updated);
    persistOverride(updated.reservationNumber, extractLocalFields(updated));
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6">
      {/* Availability calendar */}
      {!isLoading && <OccupancyCalendar reservations={reservations} />}

{/* large banner removed — compact pill lives above the filter instead */}

      {/* Page header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Reservations</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {reservations.length} total · {filtered.length} shown
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">
            Last synced:{" "}
            <span className="text-gray-600">
              {lastSynced ? lastSynced.toLocaleTimeString() : "—"}
            </span>
          </span>
          {role && canMutate(role, "transactions") && (
            <>
            <button
              onClick={() => setShowPriceCheck(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-emerald-200 text-emerald-700 text-sm font-medium transition-colors hover:bg-emerald-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Price Check
            </button>
            <button
              onClick={() => setShowVoucherModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-purple-200 text-purple-700 text-sm font-medium transition-colors hover:bg-purple-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Create Voucher
            </button>
            <button
              onClick={() => setShowPaymentModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-indigo-200 text-indigo-700 text-sm font-medium transition-colors hover:bg-indigo-50 shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
              </svg>
              Manual Payment
            </button>
            <button
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Booking
            </button>
            </>
          )}
          <button
            onClick={fetchReservations}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg
              className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            {isLoading ? "Syncing…" : "Sync"}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>Failed to load reservations: {error}</span>
          <button onClick={fetchReservations} className="ml-auto font-medium underline underline-offset-2 hover:text-red-900">
            Retry
          </button>
        </div>
      )}

      {/* Data issues panel */}
      {dataIssues.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
          <button
            onClick={() => setIssuesOpen((o) => !o)}
            className="w-full flex items-center gap-3 px-4 py-3 text-sm text-amber-800 hover:bg-amber-100 transition-colors"
          >
            <svg className="w-4 h-4 shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            <span className="font-medium">
              {dataIssues.length} data {dataIssues.length === 1 ? "issue" : "issues"} detected
            </span>
            <span className="text-amber-500 text-xs ml-1">
              Missing commission or payment fee data from Beds24
            </span>
            <svg
              className={`w-4 h-4 ml-auto text-amber-400 transition-transform ${issuesOpen ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {issuesOpen && (
            <div className="border-t border-amber-200 px-4 pb-3">
              <table className="w-full text-sm mt-3">
                <thead>
                  <tr className="border-b border-amber-200">
                    {["Reservation", "Channel", "Check-in", "Issue"].map((h) => (
                      <th key={h} className={`pb-2 text-xs font-medium text-amber-700 uppercase tracking-wide ${h === "Issue" ? "text-right" : "text-left"}`}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {dataIssues.map(({ reservation: r, problems }) => (
                    <tr
                      key={r.reservationNumber}
                      className="hover:bg-amber-100 cursor-pointer"
                      onClick={() => { setSelectedReservation(r); setIssuesOpen(false); }}
                    >
                      <td className="py-2 font-medium text-amber-900">{r.reservationNumber}</td>
                      <td className="py-2 text-amber-700">{r.channel}</td>
                      <td className="py-2 text-amber-700">{r.checkInDate}</td>
                      <td className="py-2 text-right text-amber-600">{problems.join(" · ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Pending tasks/issues pill — compact, sits above the search bar */}
      {upcomingUnresolved.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setTaskAlertOpen((o) => !o)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-50 border border-red-200 text-red-700 text-sm font-medium hover:bg-red-100 transition-colors"
          >
            <span className="flex items-center justify-center w-4 h-4 rounded-full bg-red-500 text-white text-[9px] font-bold animate-pulse shrink-0">!</span>
            {upcomingUnresolved.length} pending {upcomingUnresolved.length === 1 ? "task" : "tasks"} · next 7 days
            <svg
              className={`w-3.5 h-3.5 transition-transform ${taskAlertOpen ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {taskAlertOpen && (
            <div className="mt-2 rounded-lg border border-red-200 bg-red-50 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-red-200">
                    {["Guest", "Type", "Task / Issue", "Date"].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium text-red-700 uppercase tracking-wide text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-red-100">
                  {upcomingUnresolved.map(({ reservation, issue }) => {
                    const cat = (issue.category ?? "problem") as IssueCategory;
                    const catLabels: Record<IssueCategory, string> = {
                      problem: "Problem",
                      invoice: "Send Invoice",
                      cleaning: "Mid-stay Cleaning",
                      special: "Special Treatment",
                    };
                    return (
                      <tr
                        key={issue.id}
                        className="hover:bg-red-100 cursor-pointer"
                        onClick={() => { setSelectedReservation(reservation); setTaskAlertOpen(false); }}
                      >
                        <td className="px-4 py-2 font-medium text-red-900 whitespace-nowrap">
                          {reservation.firstName} {reservation.lastName}
                        </td>
                        <td className="px-4 py-2 text-red-600 text-xs whitespace-nowrap">{catLabels[cat]}</td>
                        <td className="px-4 py-2 text-red-700">{issue.text}</td>
                        <td className="px-4 py-2 text-red-600 text-xs whitespace-nowrap">{issue.actionableDate}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Unpaid additional payments pill */}
      {unpaidAdditionalPayments.length > 0 && (
        <div className="mb-3">
          <button
            onClick={() => setPaymentAlertOpen((o) => !o)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-sm font-medium hover:bg-amber-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5 shrink-0 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            {unpaidAdditionalPayments.length} unpaid additional {unpaidAdditionalPayments.length === 1 ? "payment" : "payments"}
            <svg
              className={`w-3.5 h-3.5 transition-transform ${paymentAlertOpen ? "rotate-180" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {paymentAlertOpen && (
            <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-amber-200">
                    {["Guest", "Reservation", "Description", "Amount", "Sent"].map((h) => (
                      <th key={h} className="px-4 py-2 text-xs font-medium text-amber-700 uppercase tracking-wide text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-100">
                  {unpaidAdditionalPayments.map(({ reservation, payment }) => (
                    <tr
                      key={payment.id}
                      className="hover:bg-amber-100 cursor-pointer"
                      onClick={() => { setSelectedReservation(reservation); setPaymentAlertOpen(false); }}
                    >
                      <td className="px-4 py-2 font-medium text-amber-900 whitespace-nowrap">
                        {reservation.firstName} {reservation.lastName}
                      </td>
                      <td className="px-4 py-2 text-amber-700 text-xs whitespace-nowrap">{payment.reservationNumber}</td>
                      <td className="px-4 py-2 text-amber-700">{payment.description}</td>
                      <td className="px-4 py-2 text-amber-900 font-medium whitespace-nowrap">
                        {payment.amountCzk.toLocaleString("cs-CZ")} Kč
                      </td>
                      <td className="px-4 py-2 text-amber-600 text-xs whitespace-nowrap">
                        {payment.createdAt.slice(0, 10)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Search + Filters */}
      <div className="space-y-3 mb-5">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by reservation #, guest name, or email..."
          className="w-full border border-gray-200 rounded-lg px-4 py-2.5 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white shadow-sm"
        />
        <FilterPanel filters={filters} onChange={setFilters} />
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-12 rounded-lg bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : (
        <ReservationTable
          reservations={filtered}
          allReservations={reservations}
          unreadBookingIds={unreadBookingIds}
          onRowClick={setSelectedReservation}
        />
      )}

      {/* Drawer */}
      <ReservationDrawer
        reservation={selectedReservation}
        allReservations={reservations}
        unreadBookingIds={unreadBookingIds}
        onClose={() => setSelectedReservation(null)}
        onUpdate={handleUpdate}
        onPaymentCreated={fetchReservations}
      />

      {/* Create booking modal */}
      {showCreateModal && (
        <CreateBookingModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            fetchReservations();
          }}
        />
      )}

      {/* Manual payment link modal */}
      {showPaymentModal && (
        <PaymentLinkModal
          reservations={reservations.map((r) => ({
            reservationNumber: r.reservationNumber,
            guestName: [r.firstName, r.lastName].filter(Boolean).join(' '),
            email: r.additionalEmail || r.invoiceData?.billingEmail || undefined,
            phone: r.phone,
            checkIn: r.checkInDate,
            checkOut: r.checkOutDate,
          }))}
          onPaymentCreated={fetchReservations}
          onClose={() => setShowPaymentModal(false)}
        />
      )}

      {/* Price check modal */}
      {showPriceCheck && (
        <PriceCheckModal onClose={() => setShowPriceCheck(false)} />
      )}

      {/* Create voucher modal */}
      {showVoucherModal && (
        <CreateVoucherModal
          reservations={reservations.map((r) => ({
            reservationNumber: r.reservationNumber,
            guestName: [r.firstName, r.lastName].filter(Boolean).join(' '),
            email: r.additionalEmail || r.invoiceData?.billingEmail || undefined,
            phone: r.phone,
            checkIn: r.checkInDate,
            checkOut: r.checkOutDate,
          }))}
          onVoucherCreated={fetchReservations}
          onClose={() => setShowVoucherModal(false)}
        />
      )}
    </div>
  );
}
