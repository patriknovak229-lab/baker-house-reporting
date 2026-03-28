'use client';
import { useState, useMemo } from "react";
import type { Reservation } from "@/types/reservation";
import { sampleReservations } from "@/data/sampleData";
import FilterPanel, { defaultFilters } from "./FilterPanel";
import type { Filters } from "./FilterPanel";
import ReservationTable from "./ReservationTable";
import ReservationDrawer from "./ReservationDrawer";
import { getEffectiveFlags } from "@/utils/flagUtils";

export default function TransactionsPage() {
  const [reservations, setReservations] = useState<Reservation[]>(sampleReservations);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(defaultFilters);
  const [selectedReservation, setSelectedReservation] = useState<Reservation | null>(null);

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
    setReservations((prev) =>
      prev.map((r) => (r.reservationNumber === updated.reservationNumber ? updated : r))
    );
    setSelectedReservation(updated);
  }

  return (
    <div className="max-w-screen-2xl mx-auto px-6 py-6">
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
            Last synced: <span className="text-gray-600">just now</span>
          </span>
          <button className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 transition-colors shadow-sm">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
            Sync
          </button>
        </div>
      </div>

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
      <ReservationTable
        reservations={filtered}
        allReservations={reservations}
        onRowClick={setSelectedReservation}
      />

      {/* Drawer */}
      <ReservationDrawer
        reservation={selectedReservation}
        allReservations={reservations}
        onClose={() => setSelectedReservation(null)}
        onUpdate={handleUpdate}
      />
    </div>
  );
}
