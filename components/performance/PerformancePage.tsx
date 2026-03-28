'use client';
import { useState, useMemo } from "react";
import { sampleReservations } from "@/data/sampleData";
import { ALL_ROOMS } from "@/data/performanceMockData";
import { getPeriodDateRange, isReservationInPeriod } from "@/utils/periodUtils";
import type { PeriodKey, DateRange } from "@/utils/periodUtils";
import type { Room } from "@/types/reservation";

import PeriodSelector from "./PeriodSelector";
import RoomSelector from "./RoomSelector";
import OccupancyView from "./OccupancyView";
import ChannelMixView from "./ChannelMixView";
import GBVAdrView from "./GBVAdrView";
import NetSalesBridgeView from "./NetSalesBridgeView";
import GrossProfitBridgeView from "./GrossProfitBridgeView";
import EBITDABridgeView from "./EBITDABridgeView";

export default function PerformancePage() {
  const [period, setPeriod] = useState<PeriodKey>("current-month");
  const [customRange, setCustomRange] = useState<DateRange>({
    start: "2026-03-01",
    end: "2026-03-26",
  });
  const [selectedRooms, setSelectedRooms] = useState<Room[]>([...ALL_ROOMS]);

  const dateRange = useMemo(
    () => getPeriodDateRange(period, customRange),
    [period, customRange]
  );

  const filteredReservations = useMemo(
    () =>
      sampleReservations.filter(
        (r) =>
          isReservationInPeriod(r, dateRange) && selectedRooms.includes(r.room)
      ),
    [dateRange, selectedRooms]
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Page header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Performance</h1>
        <p className="text-sm text-gray-500 mt-0.5">Traffic Overview</p>
      </div>

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

      {/* Traffic Overview views */}
      <div className="space-y-6">
        <OccupancyView
          reservations={filteredReservations}
          dateRange={dateRange}
          selectedRooms={selectedRooms}
        />
        <ChannelMixView reservations={filteredReservations} />
        <GBVAdrView reservations={filteredReservations} />
        <NetSalesBridgeView reservations={filteredReservations} />
        <GrossProfitBridgeView reservations={filteredReservations} />
        <EBITDABridgeView reservations={filteredReservations} dateRange={dateRange} />
      </div>
    </div>
  );
}
