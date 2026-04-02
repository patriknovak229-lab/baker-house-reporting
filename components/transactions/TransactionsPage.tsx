'use client';
import { useState, useMemo, useEffect, useCallback } from "react";
import type { Reservation, PaymentStatus, RatingStatus, InvoiceStatus, InvoiceData, CustomerFlag } from "@/types/reservation";
import FilterPanel, { defaultFilters } from "./FilterPanel";
import OccupancyCalendar from "./OccupancyCalendar";
import type { Filters } from "./FilterPanel";
import ReservationTable from "./ReservationTable";
import ReservationDrawer from "./ReservationDrawer";
import { getEffectiveFlags } from "@/utils/flagUtils";

// ─── Local state persistence (pre-Redis) ────────────────────────────────────
// Locally managed fields are not stored in Beds24. We persist them in
// localStorage so they survive page refreshes and Sync operations.
const LOCAL_KEY = "bha-local-state";

type LocalFields = {
  additionalEmail?: string;
  paymentStatusOverride?: PaymentStatus | null;
  notes?: string;
  manualFlagOverrides?: Partial<Record<CustomerFlag, boolean>>;
  ratingStatus?: RatingStatus;
  invoiceData?: InvoiceData | null;
  invoiceStatus?: InvoiceStatus;
};

function loadLocal(): Record<string, LocalFields> {
  try {
    const stored = localStorage.getItem(LOCAL_KEY);
    return stored ? JSON.parse(stored) : {};
  } catch {
    return {};
  }
}

function saveLocal(reservations: Reservation[]) {
  const state: Record<string, LocalFields> = {};
  for (const r of reservations) {
    const local: LocalFields = {};
    if (r.additionalEmail) local.additionalEmail = r.additionalEmail;
    if (r.paymentStatusOverride !== null) local.paymentStatusOverride = r.paymentStatusOverride;
    if (r.notes) local.notes = r.notes;
    if (Object.keys(r.manualFlagOverrides).length > 0) local.manualFlagOverrides = r.manualFlagOverrides;
    if (r.ratingStatus !== "none") local.ratingStatus = r.ratingStatus;
    if (r.invoiceData) local.invoiceData = r.invoiceData;
    if (r.invoiceStatus !== "Not Issued") local.invoiceStatus = r.invoiceStatus;
    if (Object.keys(local).length > 0) state[r.reservationNumber] = local;
  }
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — fail silently
  }
}

function mergeLocal(reservations: Reservation[], state: Record<string, LocalFields>): Reservation[] {
  return reservations.map((r) => {
    const local = state[r.reservationNumber];
    return local ? { ...r, ...local } : r;
  });
}

const UNREAD_POLL_INTERVAL_MS = 30_000;

export default function TransactionsPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [unreadBookingIds, setUnreadBookingIds] = useState<Set<number>>(new Set());

  const fetchReservations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/bookings");
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const data: Reservation[] = await res.json();
      const localState = loadLocal();
      setReservations(mergeLocal(data, localState));
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

  interface DataIssue {
    reservation: Reservation;
    problems: string[];
  }

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
      // Search
      if (search.trim()) {
        const q = search.toLowerCase();
        const fullName = `${res.firstName} ${res.lastName}`.toLowerCase();
        if (
          !res.reservationNumber.toLowerCase().includes(q) &&
          !fullName.includes(q) &&
          !res.email.toLowerCase().includes(q)
        ) {
          return false;
        }
      }

      // Channel filter
      if (filters.channels.length > 0 && !filters.channels.includes(res.channel)) return false;

      // Room filter
      if (filters.rooms.length > 0 && !filters.rooms.includes(res.room)) return false;

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
    setReservations((prev) => {
      const next = prev.map((r) =>
        r.reservationNumber === updated.reservationNumber ? updated : r
      );
      saveLocal(next);
      return next;
    });
    setSelectedReservation(updated);
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6">
      {/* Availability calendar */}
      {!isLoading && <OccupancyCalendar reservations={reservations} />}

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
      />
    </div>
  );
}
