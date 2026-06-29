'use client';
import { useState, useMemo, useEffect, useCallback } from "react";
import { ALL_ROOMS } from "@/data/performanceMockData";
import { getPeriodDateRange, isReservationInPeriod, PERIOD_OPTIONS } from "@/utils/periodUtils";
import type { PeriodKey, DateRange } from "@/utils/periodUtils";
import { formatDate } from "@/utils/formatters";
import type { Reservation, Room } from "@/types/reservation";

import PeriodSelector from "./PeriodSelector";
import RoomSelector from "./RoomSelector";
import OccupancyView from "./OccupancyView";
import ChannelMixView from "./ChannelMixView";
import GBVAdrView from "./GBVAdrView";
import NetSalesBridgeView from "./NetSalesBridgeView";
import GrossProfitBridgeView from "./GrossProfitBridgeView";
import type { VariableCostsLookup, VariableCostsResponse } from "@/app/api/variable-costs/route";
import { expandLinkedReservations } from "@/utils/expandReservations";
import ShareSnapshotModal from "./ShareSnapshotModal";

export default function PerformancePage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [variableCosts, setVariableCosts] = useState<VariableCostsLookup>({});
  const [variableCostsByReservation, setVariableCostsByReservation] = useState<
    VariableCostsResponse['byReservation']
  >({});
  const [subscriptionItems, setSubscriptionItems] = useState<
    VariableCostsResponse['subscriptionItems']
  >([]);
  const [manualCleaningKeys, setManualCleaningKeys] = useState<string[]>([]);
  const [noLaundryKeys, setNoLaundryKeys] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);

  const fetchReservations = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [bookingsRes, costsRes] = await Promise.all([
        fetch("/api/bookings"),
        fetch("/api/variable-costs"),
      ]);
      if (!bookingsRes.ok) {
        const json = await bookingsRes.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${bookingsRes.status}`);
      }
      const data: Reservation[] = await bookingsRes.json();
      setReservations(data);
      if (costsRes.ok) {
        const body = (await costsRes.json()) as
          | VariableCostsResponse
          | VariableCostsLookup;
        // Back-compat: older deployments returned the lookup directly.
        if (body && typeof body === 'object' && 'byDateRoom' in body) {
          setVariableCosts((body as VariableCostsResponse).byDateRoom);
          setVariableCostsByReservation((body as VariableCostsResponse).byReservation ?? {});
          setSubscriptionItems((body as VariableCostsResponse).subscriptionItems ?? []);
          setManualCleaningKeys((body as VariableCostsResponse).manualCleaningKeys ?? []);
          setNoLaundryKeys((body as VariableCostsResponse).noLaundryKeys ?? []);
        } else {
          setVariableCosts(body as VariableCostsLookup);
          setVariableCostsByReservation({});
          setSubscriptionItems([]);
          setManualCleaningKeys([]);
          setNoLaundryKeys([]);
        }
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
  const [customRange, setCustomRange] = useState<DateRange>(() => {
    // Local date — same convention as utils/periodUtils.today(). Using
    // toISOString() here would silently drift to UTC dates around midnight
    // (Czech summer = UTC+2 ⇒ 22:00 local is already "tomorrow" in UTC).
    const localToday = new Date().toLocaleDateString("sv-SE");
    return {
      start: localToday.slice(0, 8) + "01",
      end: localToday,
    };
  });
  const [selectedRooms, setSelectedRooms] = useState<Room[]>([...ALL_ROOMS]);
  const [shareOpen, setShareOpen] = useState(false);

  const dateRange = useMemo(
    () => getPeriodDateRange(period, customRange),
    [period, customRange]
  );

  const filteredReservations = useMemo(
    () =>
      expandLinkedReservations(reservations).filter(
        (r) =>
          // Blackouts are room blocks (no revenue, no guest) — exclude from performance metrics
          !r.isBlackout &&
          isReservationInPeriod(r, dateRange) &&
          selectedRooms.includes(r.room),
      ),
    [reservations, dateRange, selectedRooms]
  );

  const periodLabel = useMemo(() => {
    const preset = PERIOD_OPTIONS.find((p) => p.key === period);
    if (preset && period !== "custom") {
      return `${preset.label} (${formatDate(dateRange.start)} – ${formatDate(dateRange.end)})`;
    }
    return `${formatDate(dateRange.start)} – ${formatDate(dateRange.end)}`;
  }, [period, dateRange]);

  const roomsLabel = selectedRooms.length === ALL_ROOMS.length
    ? "All Rooms"
    : selectedRooms.join(", ");

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Performance</h1>
          <p className="text-sm text-gray-500 mt-0.5">Traffic Overview · Live Beds24 data</p>
        </div>
        <div className="flex items-center gap-3 print:hidden">
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
          <button
            onClick={() => window.print()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export PDF
          </button>
          <button
            onClick={() => setShareOpen(true)}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-emerald-200 bg-emerald-50 text-sm font-medium text-emerald-700 hover:bg-emerald-100 transition-colors shadow-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"
              />
            </svg>
            Share
          </button>
        </div>
      </div>

      {/* Print-only report metadata */}
      <div className="hidden print:block mb-6 pb-4 border-b border-gray-300">
        <p className="text-sm text-gray-700"><span className="font-medium">Period:</span> {periodLabel}</p>
        <p className="text-sm text-gray-700"><span className="font-medium">Rooms:</span> {roomsLabel}</p>
        <p className="text-xs text-gray-400 mt-1">Generated: {formatDate(new Date().toISOString().slice(0, 10))}</p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-5 flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 print:hidden">
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
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 mb-6 print:hidden">
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
        <div id="performance-views" className="space-y-6">
          <OccupancyView
            reservations={filteredReservations}
            dateRange={dateRange}
            selectedRooms={selectedRooms}
          />
          <ChannelMixView reservations={filteredReservations} dateRange={dateRange} />
          <GBVAdrView reservations={filteredReservations} dateRange={dateRange} />
          <NetSalesBridgeView reservations={filteredReservations} dateRange={dateRange} />
          <GrossProfitBridgeView
            reservations={filteredReservations}
            dateRange={dateRange}
            variableCosts={variableCosts}
            variableCostsByReservation={variableCostsByReservation}
            subscriptionItems={subscriptionItems}
            manualCleaningKeys={manualCleaningKeys}
            noLaundryKeys={noLaundryKeys}
            selectedRooms={selectedRooms}
          />
        </div>
      )}

      <ShareSnapshotModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        reservations={reservations}
        initialRooms={selectedRooms}
        initialRange={dateRange}
      />
    </div>
  );
}
