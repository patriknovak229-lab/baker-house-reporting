/**
 * Shared gross-profit engine.
 *
 * This is the single source of truth for the Net Sales → operational costs →
 * Gross Profit waterfall. The Performance section (GrossProfitBridgeView) and
 * the Accounting Commission tab both consume it, so an owner settlement can
 * never drift from what the Performance dashboard shows for the same rooms and
 * period.
 *
 * Net Sales   = Σ (price − OTA commission − payment fees) × fraction-of-stay-in-period
 * Gross Profit = Net Sales − (cleaning + laundry + consumables + subscriptions
 *                             + wear&tear + misc)
 */
import type { Reservation, Room } from '@/types/reservation';
import { getNightsInPeriod } from '@/utils/periodUtils';
import type { DateRange } from '@/utils/periodUtils';
import type {
  VariableCostEntry,
  VariableCostsLookup,
  SubscriptionItem,
} from '@/app/api/variable-costs/route';
import { ROOM_TO_BEDS24_ID } from '@/app/api/variable-costs/route';

/** Count distinct calendar months in inclusive [from, to] that overlap
 *  with a subscription's active window. Mirrors cleaning-types.ts. */
export function subscriptionMonthsInRange(
  item: { startDate?: string; endDate?: string },
  from: string,
  to: string,
): number {
  const startMonth = (item.startDate ?? '0000-01').slice(0, 7);
  const endMonth = (item.endDate ?? '9999-12').slice(0, 7);
  const fromMonth = from.slice(0, 7);
  const toMonth = to.slice(0, 7);
  const [fy, fm] = fromMonth.split('-').map(Number);
  const [ty, tm] = toMonth.split('-').map(Number);
  let count = 0;
  let cy = fy;
  let cm = fm;
  while (cy < ty || (cy === ty && cm <= tm)) {
    const ym = `${cy}-${String(cm).padStart(2, '0')}`;
    if (ym >= startMonth && ym <= endMonth) count += 1;
    cm += 1;
    if (cm > 12) { cm = 1; cy += 1; }
  }
  return count;
}

export interface GrossProfitTotals {
  // ── Net-sales bridge components ─────────────────────────────────────────
  gbv: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;
  // ── Operational costs ───────────────────────────────────────────────────
  cleaning: number;
  laundry: number;
  consumables: number;
  subscriptions: number;
  wearTear: number;
  misc: number;
  totalVariableCosts: number;
  grossProfit: number;
  // ── Reconciliation counts (cleaning-app activity vs reservations) ─────────
  reservationCount: number;
  cleaningCount: number;
  laundryCount: number;
  cleaningNextMonthCount: number;
  extraCleaningCount: number;
  noLaundryCount: number;
  removedCleaningCount: number;
  carryInCount: number;
  manualOnCheckoutCount: number;
  // ── Per-unit overview ─────────────────────────────────────────────────────
  laundrySetCount: number;
  consumableUnitCount: number;
  subscriptionCount: number;
  wearTearUnitCount: number;
  miscUnitCount: number;
}

export function computeGrossProfit(
  reservations: Reservation[],
  dateRange: DateRange,
  variableCosts: VariableCostsLookup,
  byReservation: Record<string, VariableCostEntry>,
  subscriptionItems: SubscriptionItem[],
  manualCleaningKeys: string[],
  noLaundryKeys: string[],
  dismissedCleaningKeys: string[],
  selectedRooms?: Room[],
): GrossProfitTotals {
  // ── Operational costs: sum every cell in the period for the rooms in scope.
  const inScopeRoomIds = new Set<string>(
    (selectedRooms ?? []).map((r) => ROOM_TO_BEDS24_ID[r]).filter(Boolean),
  );
  const allRoomsSelected = !selectedRooms || selectedRooms.length === 0;
  function roomInScope(roomId: string): boolean {
    return allRoomsSelected || inScopeRoomIds.has(roomId);
  }
  function keyInPeriodScope(key: string): boolean {
    const [date, roomId] = key.split('|');
    if (!date || !roomId) return false;
    if (date < dateRange.start || date > dateRange.end) return false;
    return roomInScope(roomId);
  }
  const noLaundryCount = noLaundryKeys.filter(keyInPeriodScope).length;
  const removedCleaningCount = dismissedCleaningKeys.filter(keyInPeriodScope).length;

  const checkoutKeys = new Set<string>();
  for (const r of reservations) {
    if (r.paymentStatus === 'Refunded') continue;
    const rid = ROOM_TO_BEDS24_ID[r.room];
    if (rid) checkoutKeys.add(`${r.checkOutDate}|${rid}`);
  }
  const extraCleaningCount = manualCleaningKeys
    .filter(keyInPeriodScope)
    .filter((k) => !checkoutKeys.has(k)).length;
  const manualOnCheckoutCount =
    manualCleaningKeys.filter(keyInPeriodScope).length - extraCleaningCount;

  // ── Net sales: per-reservation, fraction-of-stay within the period ────
  let gbv = 0;
  let otaCommission = 0;
  let paymentFees = 0;
  let netSales = 0;
  let reservationCount = 0;
  let cleaningNextMonthCount = 0;
  let carryInCount = 0;
  for (const r of reservations) {
    if (r.paymentStatus === 'Refunded') continue;
    const nights = getNightsInPeriod(r, dateRange);
    const fraction = r.numberOfNights > 0 ? nights / r.numberOfNights : 0;
    gbv += r.price * fraction;
    otaCommission += r.commissionAmount * fraction;
    paymentFees += r.paymentChargeAmount * fraction;
    netSales += (r.price - r.commissionAmount - r.paymentChargeAmount) * fraction;
    const roomInScopeForRes = allRoomsSelected || (selectedRooms?.includes(r.room) ?? true);
    if (nights > 0 && roomInScopeForRes) {
      reservationCount += 1;
      if (r.checkOutDate > dateRange.end) cleaningNextMonthCount += 1;
    }
    if (
      nights === 0 &&
      roomInScopeForRes &&
      r.checkOutDate >= dateRange.start &&
      r.checkOutDate <= dateRange.end
    ) {
      const rid = ROOM_TO_BEDS24_ID[r.room];
      const cell = rid ? variableCosts[`${r.checkOutDate}|${rid}`] : undefined;
      if (cell && (cell.cleaning ?? 0) > 0) carryInCount += 1;
    }
  }

  let cleaning = 0;
  let laundry = 0;
  let consumables = 0;
  let wearTear = 0;
  let misc = 0;
  let cleaningCount = 0;
  let laundryCount = 0;
  let laundrySetCount = 0;
  let consumableUnitCount = 0;
  let wearTearUnitCount = 0;
  let miscUnitCount = 0;
  for (const [key, v] of Object.entries(variableCosts)) {
    const [date, roomId] = key.split('|');
    if (!date || !roomId) continue;
    if (date < dateRange.start || date > dateRange.end) continue;
    if (!roomInScope(roomId)) continue;
    cleaning += v.cleaning ?? 0;
    laundry += v.laundry ?? 0;
    consumables += v.consumables ?? 0;
    wearTear += v.wearTear ?? 0;
    misc += v.misc ?? 0;
    if ((v.cleaning ?? 0) > 0) cleaningCount += 1;
    if ((v.laundry ?? 0) > 0) laundryCount += 1;
    laundrySetCount += v.laundrySets ?? 0;
    consumableUnitCount += v.consumableUnits ?? 0;
    wearTearUnitCount += v.wearTearUnits ?? 0;
    miscUnitCount += v.miscUnits ?? 0;
  }
  // Per-reservation entries — only count those tied to reservations whose
  // checkOut falls in the period AND whose room is in scope.
  for (const r of reservations) {
    if (r.paymentStatus === 'Refunded') continue;
    if (r.checkOutDate < dateRange.start || r.checkOutDate > dateRange.end) continue;
    if (selectedRooms && !selectedRooms.includes(r.room)) continue;
    const res = byReservation[r.reservationNumber];
    if (!res) continue;
    cleaning += res.cleaning;
    laundry += res.laundry;
    consumables += res.consumables;
    wearTear += res.wearTear ?? 0;
    misc += res.misc ?? 0;
    if (res.cleaning > 0) cleaningCount += 1;
    if (res.laundry > 0) laundryCount += 1;
    consumableUnitCount += res.consumableUnits ?? 0;
    wearTearUnitCount += res.wearTearUnits ?? 0;
    miscUnitCount += res.miscUnits ?? 0;
  }

  // ── Subscriptions: per-item per-room months-active-in-range × monthlyAmount
  let subscriptions = 0;
  const activeSubscriptionItems = new Set<string>();
  for (const item of subscriptionItems) {
    const monthsActive = subscriptionMonthsInRange(item, dateRange.start, dateRange.end);
    if (monthsActive <= 0) continue;
    for (const [roomId, cfg] of Object.entries(item.rooms ?? {})) {
      if (!cfg?.enabled) continue;
      if (!cfg.monthlyAmount || cfg.monthlyAmount <= 0) continue;
      if (!roomInScope(roomId)) continue;
      subscriptions += cfg.monthlyAmount * monthsActive;
      activeSubscriptionItems.add(item.id);
    }
  }
  const subscriptionCount = activeSubscriptionItems.size;

  const totalVariableCosts = cleaning + laundry + consumables + subscriptions + wearTear + misc;
  const grossProfit = netSales - totalVariableCosts;
  return {
    gbv,
    otaCommission,
    paymentFees,
    netSales,
    cleaning,
    laundry,
    consumables,
    subscriptions,
    wearTear,
    misc,
    totalVariableCosts,
    grossProfit,
    reservationCount,
    cleaningCount,
    laundryCount,
    cleaningNextMonthCount,
    extraCleaningCount,
    noLaundryCount,
    removedCleaningCount,
    carryInCount,
    manualOnCheckoutCount,
    laundrySetCount,
    consumableUnitCount,
    subscriptionCount,
    wearTearUnitCount,
    miscUnitCount,
  };
}
