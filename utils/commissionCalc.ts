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
import { getNightsInPeriod } from '@/utils/periodUtils';
import { isFinalSegmentPiece } from '@/utils/roomSegments';
import { hasRevenueInPeriod } from '@/utils/reservationRevenue';
import { expandLinkedReservations } from '@/utils/expandReservations';
import { computeGrossProfit } from '@/utils/grossProfit';
import {
  URBAN_POOL_ROOMS,
  URBAN_POOL_DIVISOR,
  unitCommissionRate,
  type CommissionUnit,
} from '@/utils/commissionConfig';
import { ROOM_TO_BEDS24_ID, BEDS24_ID_TO_ROOM } from '@/utils/variableCostsShared';
import type { CommissionSettlement, CleaningBreakdown } from '@/types/commissionSettlement';

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

/** Why a row is in the cleaning log. The first four are billed cleanings the
 *  breakdown accounts for; `unmatched` is billed with nothing to explain it,
 *  `missing` is a checkout nobody billed, `removed` was dropped in the cleaning
 *  app on purpose (e.g. stay prolonged). */
export type CleaningEventKind = 'checkout' | 'carry-in' | 'room-move' | 'extra' | 'unmatched' | 'missing' | 'removed';

/** One row of the cleaning log: a billed cleaning (a checkout cell with a
 *  cleaner assigned) or a checkout that has none, with who it was for and
 *  whether a laundry provider was saved for it. */
export interface CleaningEventRow {
  date: string;
  roomId: string;
  room: string;
  cleaning: number;
  laundry: number;
  sets: number;
  hasLaundry: boolean;
  kind: CleaningEventKind;
  reservationNumber?: string;
  guest?: string;
  /** Room-move rows: the unit the guest moved into. */
  movedTo?: string;
}

/** Stays in the unit's rooms whose checkout (or room-move date) lands in the
 *  month, keyed by `date|roomId`. Same exclusions as the cleaning counts:
 *  cancellations (incl. non-arrivals — nobody stayed), refunds, blackouts. */
function checkoutsByCell(rooms: string[], range: DateRange, reservations: Reservation[]) {
  const out = new Map<string, Reservation[]>();
  for (const r of expandLinkedReservations(reservations)) {
    if (r.isBlackout || r.isCancelled || r.paymentStatus === 'Refunded') continue;
    if (!rooms.includes(r.room)) continue;
    if (r.checkOutDate < range.start || r.checkOutDate > range.end) continue;
    const rid = ROOM_TO_BEDS24_ID[r.room];
    if (!rid) continue;
    const key = `${r.checkOutDate}|${rid}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return out;
}

/** The cleaning log for a unit's rooms in a month, sorted by date: every
 *  billed cleaning tagged with the stay it was for, plus checkouts with no
 *  cleaning billed and cleanings removed in the cleaning app. Billed rows
 *  mirror how computeGrossProfit counts cleanings (byDateRoom cells with
 *  cleaning > 0), so they add up to the card's count. */
export function cleaningEventsForUnit(
  unit: CommissionUnit,
  month: string,
  costs: VariableCostBundle,
  reservations: Reservation[] = [],
): CleaningEventRow[] {
  const range = monthRange(month);
  const rooms = unit.mode === 'urban-pool' ? URBAN_POOL_ROOMS : [unit.room];
  const roomIds = new Set(rooms.map((r) => ROOM_TO_BEDS24_ID[r]).filter(Boolean));
  const inScope = (key: string) => {
    const [date, roomId] = key.split('|');
    return !!date && roomIds.has(roomId) && date >= range.start && date <= range.end;
  };
  const checkouts = checkoutsByCell(rooms, range, reservations);
  const manual = new Set(costs.manualCleaningKeys);
  const dismissed = new Set(costs.dismissedCleaningKeys.filter(inScope));

  const describe = (r: Reservation): Pick<CleaningEventRow, 'kind' | 'reservationNumber' | 'guest' | 'movedTo'> => {
    const base = { reservationNumber: r.reservationNumber, guest: `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim() || undefined };
    if (!isFinalSegmentPiece(r)) {
      const segs = (reservations.find((x) => x.reservationNumber === r.reservationNumber)?.roomSegments) ?? [];
      const next = segs[(r.segmentPiece?.index ?? 0) + 1];
      return { ...base, kind: 'room-move', movedTo: next?.room };
    }
    return { ...base, kind: getNightsInPeriod(r, range) > 0 ? 'checkout' : 'carry-in' };
  };

  const rows: CleaningEventRow[] = [];
  const billedKeys = new Set<string>();
  for (const [key, v] of Object.entries(costs.byDateRoom)) {
    if (!inScope(key)) continue;
    if ((v.cleaning ?? 0) <= 0) continue; // only billed cleaning events
    billedKeys.add(key);
    const [date, roomId] = key.split('|');
    const stay = checkouts.get(key)?.[0];
    rows.push({
      date,
      roomId,
      room: BEDS24_ID_TO_ROOM[roomId] ?? roomId,
      cleaning: v.cleaning ?? 0,
      laundry: v.laundry ?? 0,
      sets: v.laundrySets ?? 0,
      hasLaundry: (v.laundry ?? 0) > 0,
      ...(stay ? describe(stay) : { kind: manual.has(key) ? 'extra' : 'unmatched' }),
    });
  }

  // Checkouts that produced no billed cleaning: removed on purpose, or missing.
  for (const [key, stays] of checkouts) {
    if (billedKeys.has(key)) continue;
    const stay = stays[0];
    // A cleaning booked against the reservation itself still counts as billed.
    if ((costs.byReservation[stay.reservationNumber]?.cleaning ?? 0) > 0) continue;
    const [date, roomId] = key.split('|');
    rows.push({
      date,
      roomId,
      room: BEDS24_ID_TO_ROOM[roomId] ?? roomId,
      cleaning: 0,
      laundry: 0,
      sets: 0,
      hasLaundry: false,
      ...describe(stay),
      kind: dismissed.has(key) ? 'removed' : 'missing',
    });
    dismissed.delete(key);
  }
  // Removed cleanings with no stay behind them any more (e.g. dates moved).
  for (const key of dismissed) {
    if (billedKeys.has(key)) continue;
    const [date, roomId] = key.split('|');
    rows.push({ date, roomId, room: BEDS24_ID_TO_ROOM[roomId] ?? roomId, cleaning: 0, laundry: 0, sets: 0, hasLaundry: false, kind: 'removed' });
  }

  rows.sort((a, b) => (a.date === b.date ? a.room.localeCompare(b.room) : a.date.localeCompare(b.date)));
  return rows;
}

/**
 * One-line status for the card / statement. Deliberately no "expected vs
 * billed": when the breakdown adds up it just says so, and when it doesn't it
 * names what is left over, which the cleaning log lists row by row.
 */
export function cleaningStatusNote(b: CleaningBreakdown): string {
  const diff = b.billed - b.total;
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  if (diff === 0) return `${n(b.billed, 'cleaning', 'cleanings')} billed — reconciled`;
  return diff > 0
    ? `${n(b.billed, 'cleaning', 'cleanings')} billed — ${n(diff, 'cleaning', 'cleanings')} not linked to a stay`
    : `${n(b.billed, 'cleaning', 'cleanings')} billed — ${n(-diff, 'checkout', 'checkouts')} without a cleaning`;
}

/** The computed part of a settlement (everything except persistence fields). */
export type ComputedSettlement = Omit<
  CommissionSettlement,
  'id' | 'status' | 'bankTransactionId' | 'reconciledAt' | 'createdAt' | 'createdBy'
> & { cleaningBreakdown: CleaningBreakdown };

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
    (r) => !r.isBlackout && hasRevenueInPeriod(r, range) && rooms.includes(r.room),
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

  /**
   * Guests whose last night was in the previous month check out on the 1st.
   * Costs are on a checkout-date basis, so their cleaning is billed to THIS
   * month — but the stay has zero nights here, so `hasRevenueInPeriod`
   * (`nights > 0`, bar a shortened stay's unused nights) drops them in the pre-filter above, before the
   * shared engine's own carry-in branch can ever see them. Counted here off the
   * unfiltered list instead, or every 1st-of-month checkout reads as an
   * unexplained extra cleaning.
   *
   * This mirrors `cleaningNextMonthCount`: the month the stay belongs to
   * subtracts a checkout that lands after its end, and the month the checkout
   * lands in adds it back. Deliberately NOT conditional on a cleaning having
   * been billed, so a 1st-of-month cleaning that was never assigned still
   * raises a Δ — which is the whole point of the badge.
   */
  const carryIns = expandLinkedReservations(reservations).filter((r) => {
    if (r.isBlackout || !rooms.includes(r.room)) return false;
    if (r.paymentStatus === 'Refunded') return false;
    if (r.isCancelled) return false;         // incl. non-arrivals: nobody stayed
    if (getNightsInPeriod(r, range) > 0) return false;
    return r.checkOutDate >= range.start && r.checkOutDate <= range.end;
  });
  const carryInCheckouts = carryIns.length;

  /**
   * The engine calls a manual cleaning "extra" when no checkout shares its
   * cell — but it only sees the pre-filtered stays, so a manual cleaning on a
   * carry-in checkout day looks extra AND the carry-in is counted above: one
   * cleaning, two lines. Seen live 1 Jun 2026 (K.103, BH-87568488).
   */
  const carryInKeys = new Set(carryIns.map((r) => `${r.checkOutDate}|${ROOM_TO_BEDS24_ID[r.room]}`));
  const manualOnCarryIn = new Set(costs.manualCleaningKeys.filter((k) => carryInKeys.has(k))).size;

  const share = (v: number) => v / divisor;

  const commissionRate = unitCommissionRate(unit);
  const grossProfit = share(t.grossProfit);
  const commissionAmount = grossProfit * commissionRate;
  // A BHA-owned apartment has no external owner, so its gross profit simply
  // stays in the business — the payout line is 0, not "the owner keeps 100%".
  const payableToOwner = unit.bhaOwned ? 0 : grossProfit - commissionAmount;

  // Cleaning-app reconciliation (pool-level): the month's cleanings, built up
  // from the stays, should add up to what the cleaning app billed.
  //
  // Non-arrivals are subtracted because they imply no cleaning: the guest never
  // came, and flagging one cancels the booking in Beds24, which already drops
  // its checkout task from the cleaning app's schedule. Counting it here was
  // raising a Δ1 on every non-arrival. Note this subtracts the BOOKING, never
  // the (date, room) cell — when the freed nights are resold, the replacement
  // guest departs on the same date and their cleaning must still be expected.
  const breakdownLines = {
    reservations: t.reservationCount,
    checkoutNextMonth: t.cleaningNextMonthCount,
    carryIn: carryInCheckouts,
    extra: t.extraCleaningCount - manualOnCarryIn,
    roomMoves: t.roomMoveCleaningCount,
    nonArrivals: t.nonArrivalCount,
    removed: t.removedCleaningCount,
  };
  const cleaningBreakdown: CleaningBreakdown = {
    ...breakdownLines,
    total:
      breakdownLines.reservations -
      breakdownLines.checkoutNextMonth +
      breakdownLines.carryIn +
      breakdownLines.extra +
      breakdownLines.roomMoves -
      breakdownLines.nonArrivals -
      breakdownLines.removed,
    billed: t.cleaningCount,
  };
  const reconciles = cleaningBreakdown.total === cleaningBreakdown.billed;
  const reconcileNote = cleaningStatusNote(cleaningBreakdown);

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
    cleaningBreakdown,
  };
}
