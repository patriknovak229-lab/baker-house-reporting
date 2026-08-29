/**
 * Annual (calendar-year) commission overview.
 *
 * The monthly Commission cards answer "what do we owe this owner for August?".
 * This builds the other view: one table for the whole business, every physical
 * room × every month of a year, running the full waterfall from gross booking
 * value down to the owner settlement.
 *
 * ── Where each cell's numbers come from ─────────────────────────────────────
 * Issued settlements win. A settlement is a frozen snapshot — it is what was
 * sent to (and possibly paid to) the owner — so wherever one exists for a
 * unit+month the table shows those figures verbatim and marks the cell
 * `issued`. Everything else is computed live through the very same
 * `computeSettlement` path the monthly cards use, and marked `computed`. That
 * keeps the annual view from ever contradicting either the monthly cards or a
 * PDF already in an owner's inbox.
 *
 * ── Rooms with no owner ─────────────────────────────────────────────────────
 * K.103 and the Deluxe K-block are BHA-owned: real revenue, real costs, no
 * settlement. They carry `commissionRate: 0` (see ANNUAL_UNITS), so commission
 * and payable come out as a structural 0 rather than being hidden.
 *
 * ── Coverage ────────────────────────────────────────────────────────────────
 * Live figures only exist for the Beds24 sync window (±1 year). A month outside
 * it with no issued settlement yields a `null` cell — rendered "—", excluded
 * from totals — rather than a zero that would read as "we earned nothing".
 */
import type { Reservation } from '@/types/reservation';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { SubscriptionLine } from '@/utils/variableCostsShared';
import type { SettlementMode } from '@/utils/commissionConfig';
import { ANNUAL_UNITS, unitCommissionRate, type CommissionUnit } from '@/utils/commissionConfig';
import { expandLinkedReservations } from '@/utils/expandReservations';
import { computeGrossProfit } from '@/utils/grossProfit';
import { isReservationInPeriod } from '@/utils/periodUtils';
import { computeSettlement, monthRange, type VariableCostBundle } from '@/utils/commissionCalc';

/** Row key for the catch-all row; not a real unit. */
export const UNALLOCATED_KEY = '__unallocated';
/** Row key for the whole-business row. */
export const TOTAL_KEY = '__total';

/** The waterfall, gross booking value → owner payout. */
export interface AnnualFigures {
  gbv: number;
  otaCommission: number;
  paymentFees: number;
  netSales: number;
  cleaning: number;
  laundry: number;
  consumables: number;
  subscriptions: number;
  wearTear: number;
  misc: number;
  operationalCosts: number;
  grossProfit: number;
  commissionAmount: number;
  payableToOwner: number;
  /** `subscriptions` itemised per cleaning-app line item. */
  subscriptionBreakdown: SubscriptionLine[];
}

export interface AnnualCell extends AnnualFigures {
  month: string; // 'YYYY-MM'
  /** 'issued' = frozen settlement snapshot; 'computed' = live recomputation. */
  source: 'issued' | 'computed';
}

export interface AnnualRow {
  key: string;
  room: string;
  ownerName: string;
  typeLabel: string;
  mode: SettlementMode | null;
  commissionRate: number;
  /** false for BHA-owned rooms — no owner, so no commission and no payout. */
  commissionable: boolean;
  /** true for the whole-business and catch-all rows, which roll up a mix of
   *  units and so must not be labelled with any single unit's arrangement. */
  isAggregate: boolean;
  /** 12 entries, Jan…Dec. `null` = no data available for that month. */
  cells: (AnnualCell | null)[];
  total: AnnualFigures;
  /** total ÷ activeMonths — the same divisor for every row, so the room
   *  averages still add up to the business average. */
  average: AnnualFigures;
  /** How many of this row's cells came from an issued settlement. */
  issuedCount: number;
}

export interface AnnualOverview {
  year: number;
  months: string[]; // 12 × 'YYYY-MM'
  rows: AnnualRow[];
  /** Revenue on bookings still sitting on a virtual room type (no physical
   *  unit allocated yet). Null when there is none — the usual case. */
  unallocated: AnnualRow | null;
  total: AnnualRow;
  /** Every subscription label seen in the year, in cleaning-app config order. */
  subscriptionLabels: string[];
  /** Months with any activity — the divisor behind every `average`. */
  activeMonths: number;
  /** Span of loaded booking + cost data, for the coverage note. */
  coverage: { from: string; to: string } | null;
  /** Months of this year with no live data and no issued settlement. */
  uncoveredMonths: string[];
}

export function emptyFigures(): AnnualFigures {
  return {
    gbv: 0, otaCommission: 0, paymentFees: 0, netSales: 0,
    cleaning: 0, laundry: 0, consumables: 0, subscriptions: 0, wearTear: 0, misc: 0,
    operationalCosts: 0, grossProfit: 0, commissionAmount: 0, payableToOwner: 0,
    subscriptionBreakdown: [],
  };
}

/** True when nothing at all happened — used to decide if a month counts
 *  towards the average divisor. Rounded, so sub-crown noise doesn't count. */
export function isEmptyFigures(f: AnnualFigures): boolean {
  return (
    Math.round(f.gbv) === 0 &&
    Math.round(f.operationalCosts) === 0 &&
    Math.round(f.netSales) === 0
  );
}

function addInto(target: AnnualFigures, src: AnnualFigures): void {
  target.gbv += src.gbv;
  target.otaCommission += src.otaCommission;
  target.paymentFees += src.paymentFees;
  target.netSales += src.netSales;
  target.cleaning += src.cleaning;
  target.laundry += src.laundry;
  target.consumables += src.consumables;
  target.subscriptions += src.subscriptions;
  target.wearTear += src.wearTear;
  target.misc += src.misc;
  target.operationalCosts += src.operationalCosts;
  target.grossProfit += src.grossProfit;
  target.commissionAmount += src.commissionAmount;
  target.payableToOwner += src.payableToOwner;
  mergeBreakdown(target, src.subscriptionBreakdown);
}

/** Sum subscription lines by item id, preserving first-seen (config) order. */
function mergeBreakdown(target: AnnualFigures, lines: SubscriptionLine[]): void {
  for (const line of lines) {
    const existing = target.subscriptionBreakdown.find((l) => l.id === line.id);
    if (existing) existing.amount += line.amount;
    else target.subscriptionBreakdown.push({ ...line });
  }
}

function scaleFigures(f: AnnualFigures, factor: number): AnnualFigures {
  return {
    gbv: f.gbv * factor,
    otaCommission: f.otaCommission * factor,
    paymentFees: f.paymentFees * factor,
    netSales: f.netSales * factor,
    cleaning: f.cleaning * factor,
    laundry: f.laundry * factor,
    consumables: f.consumables * factor,
    subscriptions: f.subscriptions * factor,
    wearTear: f.wearTear * factor,
    misc: f.misc * factor,
    operationalCosts: f.operationalCosts * factor,
    grossProfit: f.grossProfit * factor,
    commissionAmount: f.commissionAmount * factor,
    payableToOwner: f.payableToOwner * factor,
    subscriptionBreakdown: f.subscriptionBreakdown.map((l) => ({ ...l, amount: l.amount * factor })),
  };
}

/**
 * Any subscription cost a cell could not itemise, surfaced as its own line so
 * the itemised rows always add back up to the Subscriptions total. Only ever
 * non-zero for settlements issued before itemisation existed.
 */
export const UNITEMISED_SUBSCRIPTION_ID = '__unitemised';

function withUnitemisedRemainder(f: AnnualFigures): AnnualFigures {
  const itemised = f.subscriptionBreakdown.reduce((sum, l) => sum + l.amount, 0);
  const remainder = f.subscriptions - itemised;
  if (Math.round(remainder) === 0) return f;
  return {
    ...f,
    subscriptionBreakdown: [
      ...f.subscriptionBreakdown,
      { id: UNITEMISED_SUBSCRIPTION_ID, label: 'Other subscriptions', amount: remainder },
    ],
  };
}

/** Pull the waterfall out of a settlement snapshot (issued or freshly computed). */
function figuresFromSettlement(
  s: Pick<
    CommissionSettlement,
    | 'gbv' | 'otaCommission' | 'paymentFees' | 'netSales' | 'cleaning' | 'laundry'
    | 'consumables' | 'subscriptions' | 'wearTear' | 'misc' | 'operationalCosts'
    | 'grossProfit' | 'commissionAmount' | 'payableToOwner'
  > & { subscriptionBreakdown?: SubscriptionLine[] },
): AnnualFigures {
  return {
    gbv: s.gbv,
    otaCommission: s.otaCommission,
    paymentFees: s.paymentFees,
    netSales: s.netSales,
    cleaning: s.cleaning,
    laundry: s.laundry,
    consumables: s.consumables,
    subscriptions: s.subscriptions,
    wearTear: s.wearTear,
    misc: s.misc,
    operationalCosts: s.operationalCosts,
    grossProfit: s.grossProfit,
    commissionAmount: s.commissionAmount,
    payableToOwner: s.payableToOwner,
    subscriptionBreakdown: (s.subscriptionBreakdown ?? []).map((l) => ({ ...l })),
  };
}

export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

/**
 * The span of data actually loaded: earliest arrival → latest departure across
 * the bookings, widened by the cleaning app's cost dates. Bounding by the span
 * rather than by per-month presence is what lets a genuinely quiet month inside
 * the window still show its costs, instead of being blanked as "no data".
 *
 * Subscriptions deliberately do NOT widen it — an open-ended one would stretch
 * coverage to the end of time.
 */
export function dataCoverage(
  reservations: Reservation[],
  costs?: Pick<VariableCostBundle, 'byDateRoom'>,
): { from: string; to: string } | null {
  let from: string | null = null;
  let to: string | null = null;
  const widen = (start?: string, end?: string) => {
    if (start && (!from || start < from)) from = start;
    if (end && (!to || end > to)) to = end;
  };
  for (const r of reservations) {
    if (r.isBlackout) continue;
    widen(r.checkInDate, r.checkOutDate);
  }
  for (const key of Object.keys(costs?.byDateRoom ?? {})) {
    const date = key.split('|')[0];
    if (date) widen(date, date);
  }
  return from && to ? { from, to } : null;
}

/** Years worth offering in the picker: the current one, plus any year that has
 *  either an issued settlement or loaded reservation data. Newest first. */
export function availableYears(
  settlements: CommissionSettlement[],
  reservations: Reservation[],
  currentYear: number,
): number[] {
  const years = new Set<number>([currentYear]);
  for (const s of settlements) {
    const y = Number(s.month.slice(0, 4));
    if (Number.isFinite(y)) years.add(y);
  }
  const cov = dataCoverage(reservations);
  if (cov) {
    for (let y = Number(cov.from.slice(0, 4)); y <= Number(cov.to.slice(0, 4)); y += 1) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}

function makeRow(
  base: Pick<AnnualRow, 'key' | 'room' | 'ownerName' | 'typeLabel' | 'mode' | 'commissionRate' | 'commissionable' | 'isAggregate'>,
  cells: (AnnualCell | null)[],
): AnnualRow {
  const total = emptyFigures();
  let issuedCount = 0;
  for (const cell of cells) {
    if (!cell) continue;
    addInto(total, cell);
    if (cell.source === 'issued') issuedCount += 1;
  }
  return { ...base, cells, total: withUnitemisedRemainder(total), average: emptyFigures(), issuedCount };
}

/**
 * Build the whole-year matrix.
 *
 * `settlements` are consulted first per unit+month; anything missing is
 * recomputed from `reservations` + `costs` through the shared settlement path.
 */
export function buildAnnualOverview(
  year: number,
  reservations: Reservation[],
  costs: VariableCostBundle,
  settlements: CommissionSettlement[],
): AnnualOverview {
  const months = monthsOfYear(year);
  const coverage = dataCoverage(reservations, costs);

  // Expanding once up front saves 84 passes over the booking list. It is
  // idempotent (expanded rows carry no linkedRooms), so computeSettlement
  // re-running it inside is a no-op.
  const expanded = expandLinkedReservations(reservations);

  const byId = new Map<string, CommissionSettlement>();
  for (const s of settlements) byId.set(`${s.unitId}|${s.month}`, s);

  /** Can this month be recomputed from the loaded booking window? */
  const covered = (month: string): boolean => {
    if (!coverage) return false;
    const { start, end } = monthRange(month);
    return start <= coverage.to && end >= coverage.from;
  };

  const rows = ANNUAL_UNITS.map((unit) => buildUnitRow(unit, months, expanded, costs, byId, covered));

  const unallocated = buildUnallocatedRow(months, expanded, covered);

  const totalCells: (AnnualCell | null)[] = months.map((month, i) => {
    const sources = [...rows, ...(unallocated ? [unallocated] : [])]
      .map((r) => r.cells[i])
      .filter((c): c is AnnualCell => c !== null);
    if (sources.length === 0) return null;
    const figures = emptyFigures();
    for (const c of sources) addInto(figures, c);
    return {
      ...figures,
      month,
      // The business row is only as authoritative as its weakest cell: if any
      // room in the month is still provisional, so is the total.
      source: sources.every((c) => c.source === 'issued') ? 'issued' : 'computed',
    };
  });

  const total = makeRow(
    {
      key: TOTAL_KEY,
      room: 'All apartments',
      ownerName: '—',
      typeLabel: 'Whole business',
      mode: null,
      commissionRate: 0,
      commissionable: true,
      isAggregate: true,
    },
    totalCells,
  );

  const activeMonths = totalCells.filter((c) => c !== null && !isEmptyFigures(c)).length;
  const divide = (f: AnnualFigures) => (activeMonths > 0 ? scaleFigures(f, 1 / activeMonths) : emptyFigures());
  for (const r of [...rows, ...(unallocated ? [unallocated] : []), total]) {
    r.average = divide(r.total);
  }

  const uncoveredMonths = months.filter((m, i) => totalCells[i] === null);

  return {
    year,
    months,
    rows,
    unallocated,
    total,
    subscriptionLabels: total.total.subscriptionBreakdown.map((l) => l.label),
    activeMonths,
    coverage,
    uncoveredMonths,
  };
}

function buildUnitRow(
  unit: CommissionUnit,
  months: string[],
  expanded: Reservation[],
  costs: VariableCostBundle,
  byId: Map<string, CommissionSettlement>,
  covered: (month: string) => boolean,
): AnnualRow {
  const cells = months.map((month): AnnualCell | null => {
    const issued = byId.get(`${unit.id}|${month}`);
    if (issued) return { ...figuresFromSettlement(issued), month, source: 'issued' };
    if (!covered(month)) return null;
    const computed = computeSettlement(unit, month, expanded, costs);
    return { ...figuresFromSettlement(computed), month, source: 'computed' };
  });

  return makeRow(
    {
      key: unit.id,
      room: unit.room,
      ownerName: unit.ownerName,
      typeLabel: unit.typeLabel,
      mode: unit.mode,
      commissionRate: unitCommissionRate(unit),
      commissionable: !unit.bhaOwned,
      isAggregate: false,
    },
    cells,
  );
}

/**
 * Bookings whose room is still a virtual type ("1KK Urban Studios") rather than
 * a physical unit contribute revenue that belongs to no row. Without this they
 * would silently vanish from the business total, which is exactly the kind of
 * gap a year-end overview exists to catch. Costs are keyed by physical roomId,
 * so this row is revenue-only by construction — the empty cost maps below make
 * that structural rather than a promise.
 */
function buildUnallocatedRow(
  months: string[],
  expanded: Reservation[],
  covered: (month: string) => boolean,
): AnnualRow | null {
  const knownRooms = new Set(ANNUAL_UNITS.map((u) => u.room));
  const orphans = expanded.filter((r) => !r.isBlackout && !knownRooms.has(r.room));
  if (orphans.length === 0) return null;

  const cells = months.map((month): AnnualCell | null => {
    if (!covered(month)) return null;
    const range = monthRange(month);
    const scoped = orphans.filter((r) => isReservationInPeriod(r, range));
    const t = computeGrossProfit(scoped, range, {}, {}, [], [], [], []);
    return {
      ...emptyFigures(),
      gbv: t.gbv,
      otaCommission: t.otaCommission,
      paymentFees: t.paymentFees,
      netSales: t.netSales,
      grossProfit: t.grossProfit,
      month,
      source: 'computed',
    };
  });

  const row = makeRow(
    {
      key: UNALLOCATED_KEY,
      room: 'Unallocated',
      ownerName: '—',
      typeLabel: 'Bookings not yet assigned to a unit',
      mode: null,
      commissionRate: 0,
      commissionable: true,
      isAggregate: true,
    },
    cells,
  );
  return isEmptyFigures(row.total) ? null : row;
}

// ── Table shape ──────────────────────────────────────────────────────────────
// The waterfall's row order, labelling and nesting live here, not in the view,
// so the on-screen table and the exported PDF cannot show different lines.
//
// It is a disclosure TREE, not a flat list: each summary line owns the detail
// lines that sit between it and the next summary line, so a collapsed room
// reads as four numbers rather than fourteen.
//
//   Gross Booking Value          ▸ OTA commission, payment fees
//   Net Sales                    ▸ cleaning, laundry, consumables,
//                                  subscriptions ▸ (per item), wear & tear, misc
//   Operational costs
//   Gross Profit
//
// Management commission is deliberately absent — the annual view is a trading
// overview; the commission split belongs to the monthly settlement statement.

export type AnnualLineKind =
  | 'revenue'    // gross booking value
  | 'deduction'  // a cost / channel deduction
  | 'sub-item'   // one subscription line item, nested under Subscriptions
  | 'subtotal'   // net sales, operational costs
  | 'result';    // gross profit

export interface AnnualLineNode {
  key: string;
  label: string;
  kind: AnnualLineKind;
  /** 12 values, Jan…Dec; null where that month has no data at all. */
  values: (number | null)[];
  total: number;
  average: number;
  /** Detail lines revealed when this one is expanded. */
  children?: AnnualLineNode[];
}

type FigureKey = Exclude<keyof AnnualFigures, 'subscriptionBreakdown'>;

function pick(row: AnnualRow, key: FigureKey): Pick<AnnualLineNode, 'values' | 'total' | 'average'> {
  return {
    values: row.cells.map((c) => (c ? c[key] : null)),
    total: row.total[key],
    average: row.average[key],
  };
}

function line(row: AnnualRow, key: FigureKey, label: string, kind: AnnualLineKind, children?: AnnualLineNode[]): AnnualLineNode {
  return { key, label, kind, ...pick(row, key), ...(children?.length ? { children } : {}) };
}

/** One subscription item as its own line, month by month. */
function subscriptionNode(row: AnnualRow, item: SubscriptionLine): AnnualLineNode {
  const amountIn = (c: AnnualCell | null): number | null => {
    if (!c) return null;
    const match = c.subscriptionBreakdown.find((l) => l.id === item.id);
    if (match) return match.amount;
    // An issued snapshot with no itemisation contributes to the remainder line
    // instead; anywhere else, absent genuinely means zero for this item.
    if (item.id === UNITEMISED_SUBSCRIPTION_ID) {
      const itemised = c.subscriptionBreakdown.reduce((sum, l) => sum + l.amount, 0);
      return c.subscriptions - itemised;
    }
    return 0;
  };
  return {
    key: `sub:${item.id}`,
    label: item.label,
    kind: 'sub-item',
    values: row.cells.map(amountIn),
    total: item.amount,
    average: row.average.subscriptionBreakdown.find((l) => l.id === item.id)?.amount ?? 0,
  };
}

/** The four top-level P&L lines for one room (or the business), each carrying
 *  its own detail. This is what a collapsed row expands into. */
export function annualLineTree(row: AnnualRow): AnnualLineNode[] {
  // One child per recurring item this room actually pays — what makes Parking
  // visible instead of buried inside "Subscriptions".
  const subscriptions = line(row, 'subscriptions', 'Subscriptions', 'deduction',
    row.total.subscriptionBreakdown.map((item) => subscriptionNode(row, item)));

  return [
    line(row, 'gbv', 'Gross Booking Value', 'revenue', [
      line(row, 'otaCommission', 'OTA / channel commission', 'deduction'),
      line(row, 'paymentFees', 'Payment / processing fees', 'deduction'),
    ]),
    line(row, 'netSales', 'Net Sales', 'subtotal', [
      line(row, 'cleaning', 'Cleaning', 'deduction'),
      line(row, 'laundry', 'Laundry', 'deduction'),
      line(row, 'consumables', 'Consumables', 'deduction'),
      subscriptions,
      line(row, 'wearTear', 'Wear & Tear', 'deduction'),
      line(row, 'misc', 'Misc / Damages', 'deduction'),
    ]),
    line(row, 'operationalCosts', 'Operational costs', 'subtotal'),
    line(row, 'grossProfit', 'Gross Profit', 'result'),
  ];
}

/** The tree walked depth-first into rows, with a nesting depth on each. Used by
 *  the PDF, which has no disclosure and therefore shows everything. */
export function flattenLineTree(
  nodes: AnnualLineNode[],
  depth = 0,
): { node: AnnualLineNode; depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenLineTree(node.children ?? [], depth + 1),
  ]);
}
