/**
 * Turns raw Beds24 reservations + cleaning-app variable costs into a per-unit
 * owner settlement for a given month. Uses the same filtering pipeline as the
 * Performance page (expand linked → in-period → room scope) and the shared
 * computeGrossProfit engine, so a settlement can never disagree with what the
 * Performance dashboard shows for the same rooms/period.
 */
import type { Reservation } from '@/types/reservation';
import type {
  VariableCostEntry,
  VariableCostsLookup,
  SubscriptionItem,
} from '@/utils/variableCostsShared';
import type { DateRange } from '@/utils/periodUtils';
import { isReservationInPeriod } from '@/utils/periodUtils';
import { expandLinkedReservations } from '@/utils/expandReservations';
import { computeGrossProfit } from '@/utils/grossProfit';
import {
  URBAN_POOL_ROOMS,
  URBAN_POOL_DIVISOR,
  unitCommissionRate,
  type CommissionUnit,
} from '@/utils/commissionConfig';
import { ROOM_TO_BEDS24_ID, BEDS24_ID_TO_ROOM } from '@/utils/variableCostsShared';
import type { CommissionSettlement } from '@/types/commissionSettlement';

/**
 * Flags a settlement whose payable has gone negative, i.e. costs exceeded net
 * sales. `payableToOwner` is `grossProfit × 0.75`, so this happens whenever
 * `operationalCosts > netSales`.
 *
 * The case that matters is `netSales === 0` with real costs: a thin or empty
 * bookings sync produces exactly that on its own, because costs come from
 * independent cleaning-app keys, and it renders as the owner owing us 75% of the
 * month's costs. A genuinely closed month with subscriptions still running is
 * also legitimately negative, so this is a WARNING and never a hard ban — but
 * issued settlements are final by policy, so it must not happen by accident.
 *
 * Shared by the Commission UI banner and the POST /api/commission guard so the
 * two can't drift. Returns null when there is nothing to warn about.
 */
export function negativePayableWarning(s: {
  netSales?: number;
  operationalCosts?: number;
  payableToOwner?: number;
}): { code: 'negative-payable'; zeroSales: boolean; message: string } | null {
  if (typeof s.payableToOwner !== 'number' || !(s.payableToOwner < 0)) return null;
  const zeroSales = !s.netSales;
  const kc = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;
  return {
    code: 'negative-payable',
    zeroSales,
    message: zeroSales
      ? `This month has NO net sales but ${kc(s.operationalCosts ?? 0)} of costs, so the settlement is negative (${kc(s.payableToOwner)}). That usually means the bookings sync returned no reservations for this period rather than a genuinely empty month — check the Transactions tab shows reservations for this month before continuing. Issued settlements are final.`
      : `This settlement is negative (${kc(s.payableToOwner)}): costs exceed net sales for this period. Issued settlements are final.`,
  };
}

export interface VariableCostBundle {
  byDateRoom: VariableCostsLookup;
  byReservation: Record<string, VariableCostEntry>;
  subscriptionItems: SubscriptionItem[];
  manualCleaningKeys: string[];
  noLaundryKeys: string[];
  dismissedCleaningKeys: string[];
}

/** Inclusive first/last day of a 'YYYY-MM' month. */
export function monthRange(month: string): DateRange {
  const [y, m] = month.split('-').map(Number);
  const start = `${month}-01`;
  const lastDay = new Date(y, m, 0).getDate(); // day 0 of next month = last of this
  const end = `${month}-${String(lastDay).padStart(2, '0')}`;
  return { start, end };
}

/** One billed cleaning event (a checkout cell with a cleaner assigned), with
 *  whether a laundry provider was saved for it. Powers the reconciliation
 *  drill-down so the operator can spot cleanings with no laundry. */
export interface CleaningEventRow {
  date: string;
  roomId: string;
  room: string;
  cleaning: number;
  laundry: number;
  sets: number;
  hasLaundry: boolean;
}

/** Every billed cleaning event for a unit's rooms in a month, sorted by date.
 *  Mirrors how computeGrossProfit counts cleanings/laundry (byDateRoom cells
 *  with cleaning > 0), so the list reconciles with the card's counts. */
export function cleaningEventsForUnit(
  unit: CommissionUnit,
  month: string,
  costs: VariableCostBundle,
): CleaningEventRow[] {
  const range = monthRange(month);
  const rooms = unit.mode === 'urban-pool' ? URBAN_POOL_ROOMS : [unit.room];
  const roomIds = new Set(rooms.map((r) => ROOM_TO_BEDS24_ID[r]).filter(Boolean));

  const rows: CleaningEventRow[] = [];
  for (const [key, v] of Object.entries(costs.byDateRoom)) {
    const [date, roomId] = key.split('|');
    if (!date || !roomId || !roomIds.has(roomId)) continue;
    if (date < range.start || date > range.end) continue;
    if ((v.cleaning ?? 0) <= 0) continue; // only billed cleaning events
    rows.push({
      date,
      roomId,
      room: BEDS24_ID_TO_ROOM[roomId] ?? roomId,
      cleaning: v.cleaning ?? 0,
      laundry: v.laundry ?? 0,
      sets: v.laundrySets ?? 0,
      hasLaundry: (v.laundry ?? 0) > 0,
    });
  }
  rows.sort((a, b) => (a.date === b.date ? a.room.localeCompare(b.room) : a.date.localeCompare(b.date)));
  return rows;
}

/** The computed part of a settlement (everything except persistence fields). */
export type ComputedSettlement = Omit<
  CommissionSettlement,
  'id' | 'status' | 'bankTransactionId' | 'reconciledAt' | 'createdAt' | 'createdBy'
>;

export function computeSettlement(
  unit: CommissionUnit,
  month: string,
  reservations: Reservation[],
  costs: VariableCostBundle,
): ComputedSettlement {
  const range = monthRange(month);
  const rooms = unit.mode === 'urban-pool' ? URBAN_POOL_ROOMS : [unit.room];
  const divisor = unit.mode === 'urban-pool' ? URBAN_POOL_DIVISOR : 1;

  // Mirror PerformancePage.filteredReservations: expand links, drop blackouts,
  // keep in-period, scope to the pool/room. computeGrossProfit sums net sales
  // over exactly the reservations it receives, so the pre-filter is essential.
  const scoped = expandLinkedReservations(reservations).filter(
    (r) => !r.isBlackout && isReservationInPeriod(r, range) && rooms.includes(r.room),
  );

  const t = computeGrossProfit(
    scoped,
    range,
    costs.byDateRoom,
    costs.byReservation,
    costs.subscriptionItems,
    costs.manualCleaningKeys,
    costs.noLaundryKeys,
    costs.dismissedCleaningKeys,
    rooms,
  );

  const share = (v: number) => v / divisor;

  const commissionRate = unitCommissionRate(unit);
  const grossProfit = share(t.grossProfit);
  const commissionAmount = grossProfit * commissionRate;
  // A BHA-owned apartment has no external owner, so its gross profit simply
  // stays in the business — the payout line is 0, not "the owner keeps 100%".
  const payableToOwner = unit.bhaOwned ? 0 : grossProfit - commissionAmount;

  // Cleaning-app reconciliation (pool-level): does the number of billed
  // cleanings match what the reservations imply?
  const expectedCleanings =
    t.reservationCount -
    t.cleaningNextMonthCount -
    t.removedCleaningCount +
    t.extraCleaningCount +
    t.carryInCount;
  const reconciles = expectedCleanings === t.cleaningCount;
  const reconcileNote = reconciles
    ? `${t.cleaningCount} cleanings match ${t.reservationCount} reservations`
    : `Expected ${expectedCleanings} cleanings vs ${t.cleaningCount} billed (Δ${Math.abs(
        t.cleaningCount - expectedCleanings,
      )})`;

  return {
    unitId: unit.id,
    room: unit.room,
    ownerName: unit.ownerName,
    mode: unit.mode,
    month,
    periodStart: range.start,
    periodEnd: range.end,

    gbv: share(t.gbv),
    otaCommission: share(t.otaCommission),
    paymentFees: share(t.paymentFees),
    netSales: share(t.netSales),

    cleaning: share(t.cleaning),
    laundry: share(t.laundry),
    consumables: share(t.consumables),
    subscriptions: share(t.subscriptions),
    subscriptionBreakdown: t.subscriptionBreakdown.map((l) => ({ ...l, amount: share(l.amount) })),
    wearTear: share(t.wearTear),
    misc: share(t.misc),
    operationalCosts: share(t.totalVariableCosts),

    grossProfit,
    commissionRate,
    commissionAmount,
    payableToOwner,

    poolRooms: unit.mode === 'urban-pool' ? URBAN_POOL_ROOMS : undefined,
    poolDivisor: unit.mode === 'urban-pool' ? URBAN_POOL_DIVISOR : undefined,
    poolGrossProfit: unit.mode === 'urban-pool' ? t.grossProfit : undefined,

    reconciles,
    reconcileNote,
  };
}
