/**
 * Pure computation for occupancy snapshots.
 *
 * Deliberately reuses the SAME helpers the Performance tab uses
 * (`getNightsInPeriod`, `daysBetween`, `expandLinkedReservations`) so a
 * shared snapshot can never disagree with the live dashboard:
 *
 *   - Occupancy %   — OccupancyView.tsx
 *   - Gross sales   — GBVAdrView.tsx (pro-rated, refunded excluded)
 *   - Reservations  — ChannelMixView.tsx (count of stays overlapping period)
 *
 * Output is PII-free: only aggregates + an occupied/free night grid.
 * Runs on the client (the Performance page already holds every
 * reservation), so no server-side Beds24 fetch is needed to mint a link.
 */

import type { Reservation } from '@/types/reservation';
import type { DateRange } from '@/utils/periodUtils';
import { daysBetween, getNightsInPeriod, isReservationInPeriod } from '@/utils/periodUtils';
import { reservationRevenue } from '@/utils/reservationRevenue';
import { expandLinkedReservations } from '@/utils/expandReservations';
import type { SnapshotData } from '@/types/occupancySnapshot';

function pct(sold: number, available: number): number {
  if (available <= 0) return 0;
  return Math.round((sold / available) * 100);
}

/** Inclusive list of every calendar day between two ISO dates, ascending. */
function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (cur.getTime() <= last.getTime()) {
    out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/** A guest occupies `room` on `night` when checkIn ≤ night < checkOut. */
function occupiesNight(r: Reservation, night: string): boolean {
  return r.checkInDate <= night && night < r.checkOutDate;
}

export interface ComputeOptions {
  /** Include gross sales in the metrics. When false, grossSalesCzk is omitted. */
  includeGrossSales: boolean;
  /** Human label for the period, e.g. "June 2026". */
  label: string;
}

/**
 * Build the frozen, PII-free snapshot payload for a set of rooms over a
 * date range. `reservations` is the full unfiltered list (the same array
 * the Performance page loads from /api/bookings) — this function applies
 * the identical expand → drop-blackouts → in-period → selected-rooms
 * pipeline the dashboard uses.
 */
export function computeSnapshotData(
  reservations: Reservation[],
  rooms: string[],
  range: DateRange,
  opts: ComputeOptions,
): SnapshotData {
  const roomSet = new Set(rooms);

  // Mirror PerformancePage.filteredReservations exactly: drop blackouts + plain
  // cancellations (non-arrivals stay — they carry net revenue but no occupancy).
  const inScope = expandLinkedReservations(reservations).filter(
    (r) =>
      !r.isBlackout &&
      !(r.isCancelled && !r.nonArrival) &&
      isReservationInPeriod(r, range) &&
      roomSet.has(r.room),
  );
  // Occupancy counts physical stays only — non-arrivals freed their room.
  const occupancyInScope = inScope.filter((r) => !r.nonArrival);

  const daysInPeriod = daysBetween(range.start, range.end);
  const availableTotal = rooms.length * daysInPeriod;
  const soldTotal = occupancyInScope.reduce((sum, r) => sum + getNightsInPeriod(r, range), 0);

  // Gross sales — pro-rated by nights-in-period, refunded excluded (GBVAdrView).
  const grossSalesCzk = opts.includeGrossSales
    ? Math.round(
        inScope.reduce((sum, r) => {
          if (r.paymentStatus === 'Refunded') return sum;
          const nights = getNightsInPeriod(r, range);
          const fraction = r.numberOfNights > 0 ? nights / r.numberOfNights : 0;
          return sum + reservationRevenue(r).gbv * fraction;
        }, 0),
      )
    : undefined;

  // Per-room occupancy (OccupancyView).
  const perRoom = rooms.map((room) => {
    const soldNights = occupancyInScope
      .filter((r) => r.room === room)
      .reduce((sum, r) => sum + getNightsInPeriod(r, range), 0);
    return {
      room,
      soldNights,
      availableNights: daysInPeriod,
      occupancyPct: pct(soldNights, daysInPeriod),
    };
  });

  // Anonymized night grid.
  const dates = eachDay(range.start, range.end);
  const calendar = {
    dates,
    perRoom: rooms.map((room) => {
      const roomRes = occupancyInScope.filter((r) => r.room === room);
      return {
        room,
        occupied: dates.map((night) => roomRes.some((r) => occupiesNight(r, night))),
      };
    }),
  };

  return {
    period: { start: range.start, end: range.end, label: opts.label },
    rooms: [...rooms],
    includeGrossSales: opts.includeGrossSales,
    metrics: {
      occupancyPct: pct(soldTotal, availableTotal),
      soldNights: soldTotal,
      availableNights: availableTotal,
      reservationsCount: inScope.length,
      ...(grossSalesCzk !== undefined ? { grossSalesCzk } : {}),
    },
    perRoom,
    calendar,
  };
}
