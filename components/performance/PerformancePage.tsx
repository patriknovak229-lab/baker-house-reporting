'use client';
import { useState, useMemo, useEffect, useCallback } from "react";
import { ALL_ROOMS } from "@/data/performanceMockData";
import { getPeriodDateRange, isReservationInPeriod } from "@/utils/periodUtils";
import type { PeriodKey, DateRange } from "@/utils/periodUtils";
import type { Reservation, Room } from "@/types/reservation";

import PeriodSelector from "./PeriodSelector";
import RoomSelector from "./RoomSelector";
import OccupancyView from "./OccupancyView";
import ChannelMixView from "./ChannelMixView";
import GBVAdrView from "./GBVAdrView";
import NetSalesBridgeView from "./NetSalesBridgeView";
import GrossProfitBridgeView from "./GrossProfitBridgeView";
import EBITDABridgeView from "./EBITDABridgeView";
import type { VariableCostsLookup } from "@/app/api/variable-costs/route";
import type { FixedCostEntry } from "@/app/api/fixed-costs/route";

export default function PerformancePage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [variableCosts, setVariableCosts] = useState<VariableCostsLookup>({});
  const [fixedCosts, setFixedCosts] = useState<FixedCostEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const fetchReservations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [bookingsRes, costsRes, fixedCostsRes] = await Promise.all([
        fetch("/api/bookings"),
        fetch("/api/variable-costs"),
        fetch("/api/fixed-costs"),
      ]);
      if (!bookingsRes.ok) {
        const json = await bookingsRes.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${bookingsRes.status}`);
      }
      const data: Reservation[] = await bookingsRes.json();
      setReservations(data);
      if (costsRes.ok) {
        const costs: VariableCostsLookup = await costsRes.json();
        setVariableCosts(costs);
      }
      if (fixedCostsRes.ok) {
        const fc: FixedCostEntry[] = await fixedCostsRes.json();
        setFixedCosts(fc);
      }
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

  const [period, setPeriod] = useState<PeriodKey>("current-month");
  const [customRange, setCustomRange] = useState<DateRange>({
    start: new Date().toISOString().slice(0, 8) + "01",
    end: new Date().toISOString().slice(0, 10),
  });
  const [selectedRooms, setSelectedRooms] = useState<Room[]>([...ALL_ROOMS]);

  const dateRange = useMemo(
    () => getPeriodDateRange(period, customRange),
    [period, customRange]
  );

  const filteredReservations = useMemo(
    () =>
      reservations.filter(
        (r) => isReservationInPeriod(r, dateRange) && selectedRooms.includes(r.room)
      ),
    [reservations, dateRange, selectedRooms]
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Performance</h1>
          <p className="text-sm text-gray-500 mt-0.5">Traffic Overview · Live Beds24 data</p>
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
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
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

      {/* Global filters */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Period
            </p>
            <PeriodSelector
              selected={period}
              onChange={setPeriod}
              customRange={customRange}
              onCustomRangeChange={setCustomRange}
            />
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Rooms
            </p>
            <RoomSelector selected={selectedRooms} onChange={setSelectedRooms} />
          </div>
        </div>
      </div>

      {/* Loading skeleton */}
      {isLoading ? (
        <div className="space-y-6">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-48 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
      ) : (
        /* Traffic Overview views */
        <div className="space-y-6">
          <OccupancyView
            reservations={filteredReservations}
            dateRange={dateRange}
            selectedRooms={selectedRooms}
          />
          <ChannelMixView reservations={filteredReservations} dateRange={dateRange} />
          <GBVAdrView reservations={filteredReservations} dateRange={dateRange} />
          <NetSalesBridgeView reservations={filteredReservations} dateRange={dateRange} />
          <GrossProfitBridgeView reservations={filteredReservations} dateRange={dateRange} variableCosts={variableCosts} />
          <EBITDABridgeView reservations={filteredReservations} dateRange={dateRange} variableCosts={variableCosts} fixedCosts={fixedCosts} />
        </div>
      )}
    </div>
  );
}
