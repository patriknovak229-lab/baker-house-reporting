/**
 * Occupancy model — the pure half of the Occupancy section.
 *
 * `occupancy.ts` fetches three flat lists (room-days on sale, sold nights, stay
 * costs per room-day) and this module turns them into every figure the tab
 * shows. It has no database, Redis or `process.env` access, so it is unit-tested
 * directly (occupancyModel.test.ts).
 *
 * WHY ONE GRID OF ROOM-DAYS INSTEAD OF A SQL QUERY PER CHART
 * ---------------------------------------------------------
 * The questions this tab answers cut the same nights several ways — by class, by
 * room and month, by stay length, and by "the exact dates one long stay
 * covered". Doing that in SQL meant one query per cut, each re-deriving
 * occupancy, money and cost attribution slightly differently; that is how the
 * old tab ended up reporting "58 of 93 nights" for seven rooms (dates labelled as
 * room-nights). Here every cut is a filter over ONE set of room-day cells, and
 * `summarize` is the only place a ratio is computed.
 *
 * COST ATTRIBUTION — STAY BASIS
 * -----------------------------
 * The cleaning app logs a turnover (cleaning, laundry, consumables) against the
 * checkout date. Left there, a 7-night stay checking out on the 1st makes its
 * own month look free and the next month look expensive. So a turnover that
 * matches a booking's checkout is SPREAD evenly over that booking's nights —
 * the same per-night basis revenue already uses. Anything that matches no
 * checkout (a manual mid-stay cleaning, the vacated room of a mid-stay move) and
 * every wear & tear / misc incident stays on its own (room, date).
 *
 * Gross profit is only computed on nights that have HAPPENED and fall on or
 * after the first logged cost: future checkouts are not fully costed yet, and
 * before March 2026 nothing was logged at all, so those nights would read as
 * free and flatter every comparison.
 */
import type { RoomClass } from '@/data/analyticsConfig';
import type {
  ClassForwardHorizon,
  ClassMonthPoint,
  ClassScorecard,
  ClassSoldOut,
  ClassWeekdayPoint,
  LongStayDuel,
  LongStaySummary,
  LosEconomicsBucket,
  MarketPosition,
  OccSlice,
  OccupancyClassId,
  OccupancyClassInfo,
  OccupancyResponse,
  RoomMonthCell,
  SameMonthPairSummary,
  SoldOutDay,
} from '@/utils/analyticsTypes';

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface ModelNight {
  /** Room slept in that night (physical, or a virtual-room label). */
  room: string;
  /** The booking's Beds24 room — where its checkout turnover is logged. */
  stayRoom: string;
  date: string;
  reservation: string;
  channel: string;
  checkIn: string;
  checkOut: string;
  /** Full length of the booking, nights. */
  span: number;
  gross: number;
  commission: number;
  fee: number;
}

/** Stay costs logged against one (date, physical room). */
export interface ModelCostCell {
  date: string;
  room: string;
  /** Cleaning + laundry + consumables. */
  turnover: number;
  /** Wear & tear + misc. */
  incidents: number;
}

export interface MarketMonthRow {
  listingId: string;
  month: string;
  occupancy: number | null;
  adr: number | null;
}

export interface MarketHorizonRow {
  listingId: string;
  horizonDays: number;
  occupancy: number | null;
  compSet: number | null;
}

export interface OccupancyModelInput {
  from: string;
  to: string;
  /** Today (Prague). Nights before it have happened. */
  today: string;
  /** Classes in scope, each with `rooms` already narrowed to the room filter. */
  classes: RoomClass[];
  available: { room: string; date: string }[];
  nights: ModelNight[];
  /** ALL logged cost cells (not window-clipped); null = costs unavailable. */
  costCells: ModelCostCell[] | null;
  /** `${date}|${room}` of every non-cancelled checkout in the window, all channels. */
  checkoutKeys: Set<string>;
  /** `${room}|${YYYY-MM}` → monthly subscription amount; null = unavailable. */
  subscriptionsByRoomMonth: Map<string, number> | null;
  /** PriceLabs listing → the physical rooms it sells. */
  listings: { listingId: string; rooms: string[] }[];
  marketMonthly: MarketMonthRow[];
  forward: {
    available: { room: string; date: string }[];
    nights: { room: string; date: string }[];
    horizons: { days: number; label: string }[];
    market: MarketHorizonRow[];
  };
  longStayMinNights: number;
}

export type OccupancyModel = Pick<
  OccupancyResponse,
  | 'classes'
  | 'longStayMinNights'
  | 'profitCoverage'
  | 'scorecard'
  | 'monthly'
  | 'forward'
  | 'roomMonths'
  | 'roomTotals'
  | 'sameMonthPairs'
  | 'losEconomics'
  | 'longStayDuels'
  | 'longStaySummary'
  | 'soldOut'
  | 'notes'
>;

// ── Tunables that are presentation rules, not business facts ─────────────────

/** A room-month needs this many costed nights on sale to enter a pair. */
const PAIR_MIN_NIGHTS = 14;
/** Two rooms count as "different occupancy" from this gap. */
const PAIR_MIN_OCC_GAP = 0.05;
/** A long stay needs this many completed, costed nights to be compared. */
const DUEL_MIN_NIGHTS = 3;

const LOS_ECON_BUCKETS: { label: string; min: number; max: number | null }[] = [
  { label: '1 night', min: 1, max: 1 },
  { label: '2 nights', min: 2, max: 2 },
  { label: '3 nights', min: 3, max: 3 },
  { label: '4–6 nights', min: 4, max: 6 },
  { label: '7–13 nights', min: 7, max: 13 },
  { label: '14+ nights', min: 14, max: null },
];

const DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ── Small helpers ────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

function addDays(iso: string, days: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function isoDow(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  const end = to.slice(0, 7);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (key > end) break;
    out.push(key);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);

function losBucketLabel(span: number): string {
  return LOS_ECON_BUCKETS.find((b) => span >= b.min && (b.max === null || span <= b.max))?.label ?? 'Unknown';
}

// ── The grid ─────────────────────────────────────────────────────────────────

interface Cell {
  room: string;
  classId: OccupancyClassId;
  date: string;
  /** Is the room a physical one (false for a virtual-room label)? */
  physical: boolean;
  /** 1 when the room was on sale that night. */
  available: number;
  nights: ModelNight[];
  /** Stay costs attributed to this room-night. */
  costs: number;
}

export function buildOccupancyModel(input: OccupancyModelInput): OccupancyModel {
  const { from, to, today, longStayMinNights: longMin } = input;
  const classes = input.classes.filter((c) => c.rooms.length > 0);

  const classOfRoom = new Map<string, OccupancyClassId>();
  const physicalRooms = new Set<string>();
  for (const c of classes) {
    for (const r of c.rooms) {
      classOfRoom.set(r, c.id);
      physicalRooms.add(r);
    }
    for (const r of c.virtualRoomLabels) classOfRoom.set(r, c.id);
  }

  const cells = new Map<string, Cell>();
  const cellAt = (room: string, date: string): Cell | null => {
    const key = `${room}|${date}`;
    const existing = cells.get(key);
    if (existing) return existing;
    const classId = classOfRoom.get(room);
    if (!classId) return null;
    const fresh: Cell = { room, classId, date, physical: physicalRooms.has(room), available: 0, nights: [], costs: 0 };
    cells.set(key, fresh);
    return fresh;
  };

  for (const a of input.available) {
    if (a.date < from || a.date > to) continue;
    const cell = cellAt(a.room, a.date);
    if (cell) cell.available = 1;
  }
  for (const n of input.nights) {
    if (n.date < from || n.date > to || n.span <= 0) continue;
    cellAt(n.room, n.date)?.nights.push(n);
  }

  // ── Costs ──────────────────────────────────────────────────────────────────
  const costsAvailable = input.costCells !== null;
  const costByKey = new Map<string, ModelCostCell>();
  let firstCost: string | null = null;
  for (const c of input.costCells ?? []) {
    costByKey.set(`${c.date}|${c.room}`, c);
    if (c.turnover + c.incidents > 0 && (firstCost === null || c.date < firstCost)) firstCost = c.date;
  }
  // Coverage starts on the first of the month cost logging began, not on the
  // first logged date: that date is a CHECKOUT, and the nights before it belong
  // to a stay its turnover does cost.
  const costsFrom = firstCost ? `${firstCost.slice(0, 7)}-01` : null;

  /** This night's share of its own booking's checkout turnover. */
  const turnoverShare = (n: ModelNight): number => {
    const cell = costByKey.get(`${n.checkOut}|${n.stayRoom}`);
    return cell ? cell.turnover / n.span : 0;
  };

  if (costsAvailable) {
    for (const cell of cells.values()) {
      for (const n of cell.nights) cell.costs += turnoverShare(n);
    }
    for (const c of input.costCells ?? []) {
      if (c.date < from || c.date > to || !physicalRooms.has(c.room)) continue;
      const target = cellAt(c.room, c.date);
      if (!target) continue;
      target.costs += c.incidents;
      // A turnover with no checkout behind it (manual cleaning, a mid-stay
      // move's vacated room) is a cost of that room-day, not of a stay.
      if (!input.checkoutKeys.has(`${c.date}|${c.room}`)) target.costs += c.turnover;
    }
  }

  const covered = (date: string): boolean =>
    costsAvailable && costsFrom !== null && date >= costsFrom && date < today;

  const allCells = [...cells.values()];
  const months = monthsBetween(from, to);
  const monthOf = (date: string) => date.slice(0, 7);
  const monthPartial = (month: string): boolean => {
    const start = `${month}-01`;
    const end = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
    return start < from || end > to || end >= today;
  };

  // ── Slice summary — the ONLY place ratios are formed ───────────────────────
  const summarize = (slice: Cell[]): OccSlice => {
    let available = 0;
    let sold = 0;
    let gross = 0;
    let net = 0;
    let longNights = 0;
    const stays = new Map<string, number>();
    let pAvailable = 0;
    let pSold = 0;
    let pGross = 0;
    let pNet = 0;
    let pCosts = 0;
    let anyCovered = false;

    for (const c of slice) {
      available += c.available;
      const isCovered = covered(c.date);
      if (isCovered) {
        pAvailable += c.available;
        pCosts += c.costs;
        if (c.available > 0 || c.nights.length > 0) anyCovered = true;
      }
      for (const n of c.nights) {
        const nightNet = n.gross - n.commission - n.fee;
        sold += 1;
        gross += n.gross;
        net += nightNet;
        if (n.span >= longMin) longNights += 1;
        stays.set(n.reservation, n.span);
        if (isCovered) {
          pSold += 1;
          pGross += n.gross;
          pNet += nightNet;
        }
      }
    }

    const spans = [...stays.values()];
    const grossProfit = pNet - pCosts;
    return {
      availableNights: available,
      soldNights: sold,
      occupancy: ratio(sold, available),
      gbv: gross,
      netSales: net,
      adr: ratio(gross, sold),
      netAdr: ratio(net, sold),
      revpar: ratio(gross, available),
      netRevpar: ratio(net, available),
      stays: spans.length,
      avgLos: ratio(spans.reduce((a, b) => a + b, 0), spans.length),
      longStayShare: ratio(longNights, sold),
      profit: anyCovered
        ? {
            availableNights: pAvailable,
            soldNights: pSold,
            occupancy: ratio(pSold, pAvailable),
            adr: ratio(pGross, pSold),
            netSales: pNet,
            stayCosts: pCosts,
            grossProfit,
            perAvailableNight: ratio(grossProfit, pAvailable),
            perSoldNight: ratio(grossProfit, pSold),
          }
        : null,
    };
  };

  // ── Market ─────────────────────────────────────────────────────────────────
  const marketByListingMonth = new Map(input.marketMonthly.map((r) => [`${r.listingId}|${r.month}`, r]));
  const listingOfRoom = new Map<string, string>();
  for (const l of input.listings) for (const r of l.rooms) listingOfRoom.set(r, l.listingId);

  /**
   * Comp-set occupancy for a set of cells, weighted by OUR nights on sale in
   * each listing's rooms in each month — so three Urban studios weigh three
   * times one O.308, and a month we barely traded in barely counts.
   *
   * Both sides of the MPI cover the SAME months: only months the snapshot has a
   * market figure for. PriceLabs' monthly series stops at the current month, so
   * a forward window would otherwise set 90 days of our on-the-books occupancy
   * against five days of market. When under half of our nights on sale have a
   * market figure, no comparison is returned at all (the forward-position table
   * is the right view for the future).
   */
  const marketFor = (slice: Cell[]): MarketPosition => {
    const weight = new Map<string, number>(); // listing|month → our available nights
    const ourByMonth = new Map<string, { available: number; sold: number }>();
    let totalAvailable = 0;
    for (const c of slice) {
      const month = monthOf(c.date);
      const own = ourByMonth.get(month) ?? { available: 0, sold: 0 };
      own.available += c.available;
      own.sold += c.nights.length;
      ourByMonth.set(month, own);
      totalAvailable += c.available;
      if (!c.physical || c.available === 0) continue;
      const listing = listingOfRoom.get(c.room);
      if (!listing) continue;
      const key = `${listing}|${month}`;
      weight.set(key, (weight.get(key) ?? 0) + 1);
    }
    let occSum = 0;
    let occWeight = 0;
    let adrSum = 0;
    let adrWeight = 0;
    const marketMonths = new Set<string>();
    for (const [key, w] of weight) {
      const row = marketByListingMonth.get(key);
      if (row?.occupancy != null) {
        occSum += row.occupancy * w;
        occWeight += w;
        marketMonths.add(key.slice(key.lastIndexOf('|') + 1));
      }
      if (row?.adr != null) {
        adrSum += row.adr * w;
        adrWeight += w;
      }
    }
    let ourSold = 0;
    let ourAvailable = 0;
    for (const month of marketMonths) {
      const own = ourByMonth.get(month);
      ourSold += own?.sold ?? 0;
      ourAvailable += own?.available ?? 0;
    }
    if (occWeight === 0 || ourAvailable < totalAvailable * 0.5) {
      return { occupancy: null, mpi: null, adr: null };
    }
    const occupancy = occSum / occWeight;
    return {
      occupancy,
      mpi: occupancy > 0 ? ratio(ourSold, ourAvailable) / occupancy : null,
      adr: adrWeight > 0 ? adrSum / adrWeight : null,
    };
  };

  // ── Scorecard ──────────────────────────────────────────────────────────────
  const subscriptionsFor = (slice: Cell[]): number | null => {
    if (!input.subscriptionsByRoomMonth) return null;
    let total = 0;
    const seen = new Set<string>();
    for (const c of slice) {
      if (!c.physical || !covered(c.date)) continue;
      const key = `${c.room}|${c.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const month = monthOf(c.date);
      total += (input.subscriptionsByRoomMonth.get(`${c.room}|${month}`) ?? 0) / daysInMonth(month);
    }
    return total;
  };

  const scorecardRow = (
    classId: OccupancyClassId | 'all',
    label: string,
    rooms: string[],
    slice: Cell[],
  ): ClassScorecard => {
    const s = summarize(slice);
    const subscriptions = s.profit ? subscriptionsFor(slice) : null;
    return {
      classId,
      label,
      rooms,
      slice: s,
      market: marketFor(slice),
      subscriptions,
      grossProfitAfterSubscriptions:
        s.profit && subscriptions !== null ? s.profit.grossProfit - subscriptions : null,
    };
  };

  const cellsOfClass = new Map<OccupancyClassId, Cell[]>(classes.map((c) => [c.id, []]));
  for (const cell of allCells) cellsOfClass.get(cell.classId)?.push(cell);

  const scorecard: ClassScorecard[] = classes.map((c) =>
    scorecardRow(c.id, c.label, c.rooms, cellsOfClass.get(c.id) ?? []),
  );
  if (classes.length > 1) {
    scorecard.push(scorecardRow('all', 'All rooms', classes.flatMap((c) => c.rooms), allCells));
  }

  // ── Monthly per class ──────────────────────────────────────────────────────
  const monthly = classes.map((c) => {
    const byMonth = new Map<string, Cell[]>(months.map((m) => [m, []]));
    for (const cell of cellsOfClass.get(c.id) ?? []) byMonth.get(monthOf(cell.date))?.push(cell);
    const points: ClassMonthPoint[] = months
      .map((month) => {
        const slice = byMonth.get(month) ?? [];
        const s = summarize(slice);
        return { month, partial: monthPartial(month), slice: s, market: marketFor(slice) };
      })
      .filter((p) => p.slice.availableNights > 0 || p.slice.soldNights > 0);
    return { classId: c.id, points };
  });

  // ── Room × month ───────────────────────────────────────────────────────────
  const roomMonthCells = new Map<string, Cell[]>();
  for (const cell of allCells) {
    if (!cell.physical) continue;
    const key = `${cell.room}|${monthOf(cell.date)}`;
    const list = roomMonthCells.get(key);
    if (list) list.push(cell);
    else roomMonthCells.set(key, [cell]);
  }
  const roomMonths: RoomMonthCell[] = [];
  for (const c of classes) {
    for (const room of c.rooms) {
      for (const month of months) {
        const slice = roomMonthCells.get(`${room}|${month}`);
        if (!slice) continue;
        const s = summarize(slice);
        if (s.availableNights === 0 && s.soldNights === 0) continue;
        roomMonths.push({ room, classId: c.id, month, partial: monthPartial(month), slice: s });
      }
    }
  }

  const roomTotals = classes.flatMap((c) =>
    c.rooms.map((room) => ({
      room,
      classId: c.id,
      slice: summarize(allCells.filter((cell) => cell.room === room)),
    })),
  );

  // ── Same class, same month: does the fuller room earn more? ────────────────
  const sameMonthPairs: SameMonthPairSummary[] = classes.map((c) => {
    let pairs = 0;
    let fullerEarnedMore = 0;
    let occGap = 0;
    let adrGap = 0;
    let adrGapN = 0;
    let profitGap = 0;
    const counter: SameMonthPairSummary['counterExamples'] = [];
    for (const month of months) {
      const eligible = roomMonths.filter(
        (r) => r.classId === c.id && r.month === month && r.slice.profit && r.slice.profit.availableNights >= PAIR_MIN_NIGHTS,
      );
      for (let i = 0; i < eligible.length; i += 1) {
        for (let j = i + 1; j < eligible.length; j += 1) {
          const a = eligible[i].slice.profit!;
          const b = eligible[j].slice.profit!;
          if (Math.abs(a.occupancy - b.occupancy) < PAIR_MIN_OCC_GAP) continue;
          const [fuller, emptier] = a.occupancy > b.occupancy ? [eligible[i], eligible[j]] : [eligible[j], eligible[i]];
          const f = fuller.slice.profit!;
          const e = emptier.slice.profit!;
          pairs += 1;
          occGap += f.occupancy - e.occupancy;
          if (e.adr > 0) {
            adrGap += f.adr / e.adr - 1;
            adrGapN += 1;
          }
          profitGap += f.perAvailableNight - e.perAvailableNight;
          if (f.perAvailableNight > e.perAvailableNight) fullerEarnedMore += 1;
          else
            counter.push({
              month,
              fuller: { room: fuller.room, occupancy: f.occupancy, adr: f.adr, perAvailableNight: f.perAvailableNight },
              emptier: { room: emptier.room, occupancy: e.occupancy, adr: e.adr, perAvailableNight: e.perAvailableNight },
            });
        }
      }
    }
    counter.sort(
      (x, y) =>
        y.emptier.perAvailableNight - y.fuller.perAvailableNight -
        (x.emptier.perAvailableNight - x.fuller.perAvailableNight),
    );
    return {
      classId: c.id,
      minOccupancyGap: PAIR_MIN_OCC_GAP,
      pairs,
      fullerEarnedMore,
      avgOccupancyGap: ratio(occGap, pairs),
      avgAdrGap: ratio(adrGap, adrGapN),
      avgProfitGap: ratio(profitGap, pairs),
      counterExamples: counter.slice(0, 6),
    };
  });

  // ── Per-night economics by stay length ─────────────────────────────────────
  const losEconomics = classes.map((c) => {
    const acc = new Map<string, { stays: Set<string>; nights: number; gross: number; net: number; turnover: number }>();
    for (const cell of cellsOfClass.get(c.id) ?? []) {
      if (!covered(cell.date)) continue;
      for (const n of cell.nights) {
        const label = losBucketLabel(n.span);
        const b = acc.get(label) ?? { stays: new Set<string>(), nights: 0, gross: 0, net: 0, turnover: 0 };
        b.stays.add(n.reservation);
        b.nights += 1;
        b.gross += n.gross;
        b.net += n.gross - n.commission - n.fee;
        b.turnover += turnoverShare(n);
        acc.set(label, b);
      }
    }
    const buckets: LosEconomicsBucket[] = LOS_ECON_BUCKETS.flatMap((def) => {
      const b = acc.get(def.label);
      if (!b || b.nights === 0) return [];
      const netAdr = b.net / b.nights;
      const turnoverCostPerNight = b.turnover / b.nights;
      return [
        {
          label: def.label,
          stays: b.stays.size,
          nights: b.nights,
          adr: b.gross / b.nights,
          netAdr,
          turnoverCostPerNight,
          profitPerNight: netAdr - turnoverCostPerNight,
        },
      ];
    });
    return { classId: c.id, buckets };
  });

  // ── Long stay vs sibling rooms, same nights ────────────────────────────────
  const nightsByReservation = new Map<string, { night: ModelNight; cell: Cell }[]>();
  for (const cell of allCells) {
    if (!cell.physical) continue;
    for (const n of cell.nights) {
      const list = nightsByReservation.get(n.reservation);
      if (list) list.push({ night: n, cell });
      else nightsByReservation.set(n.reservation, [{ night: n, cell }]);
    }
  }
  const classRooms = new Map(classes.map((c) => [c.id, c.rooms]));

  const longStayDuels: LongStayDuel[] = [];
  for (const [reservation, entries] of nightsByReservation) {
    const first = entries[0].night;
    if (first.span < longMin) continue;
    // A multi-apartment booking holds several rooms on the same date; it is a
    // group, not a long-stay pricing decision, and has no clean comparator.
    const dateList = entries.map((e) => e.cell.date);
    if (new Set(dateList).size !== dateList.length) continue;
    const compared = entries.filter((e) => covered(e.cell.date));
    if (compared.length < DUEL_MIN_NIGHTS) continue;

    const classId = compared[0].cell.classId;
    const stayRooms = new Set(compared.map((e) => e.cell.room));
    const dates = compared.map((e) => e.cell.date).sort();

    const siblings = (classRooms.get(classId) ?? []).filter((room) => {
      if (stayRooms.has(room)) return false;
      // A sibling that held its own long stay on these dates is not the
      // short-stay alternative this comparison is about.
      return !dates.some((d) => cells.get(`${room}|${d}`)?.nights.some((n) => n.span >= longMin));
    });
    if (siblings.length === 0) continue;

    let sAvailable = 0;
    let sSold = 0;
    let sGross = 0;
    let sNet = 0;
    let sCosts = 0;
    const sStays = new Set<string>();
    for (const room of siblings) {
      for (const d of dates) {
        const cell = cells.get(`${room}|${d}`);
        if (!cell) continue;
        sAvailable += cell.available;
        sCosts += cell.costs;
        for (const n of cell.nights) {
          sSold += 1;
          sGross += n.gross;
          sNet += n.gross - n.commission - n.fee;
          sStays.add(n.reservation);
        }
      }
    }
    if (sAvailable === 0) continue;

    let gross = 0;
    let net = 0;
    let costs = 0;
    for (const e of compared) {
      gross += e.night.gross;
      net += e.night.gross - e.night.commission - e.night.fee;
      costs += e.cell.costs;
    }
    const nights = compared.length;
    const profitPerNight = (net - costs) / nights;
    const siblingProfit = (sNet - sCosts) / sAvailable;
    const deltaPerNight = profitPerNight - siblingProfit;

    longStayDuels.push({
      classId,
      reservationNumber: reservation,
      channel: first.channel,
      rooms: [...stayRooms],
      checkIn: first.checkIn,
      checkOut: first.checkOut,
      stayNights: first.span,
      from: dates[0],
      to: dates[dates.length - 1],
      nights,
      adr: gross / nights,
      netAdr: net / nights,
      profitPerNight,
      siblings: {
        rooms: siblings,
        availableNights: sAvailable,
        occupancy: ratio(sSold, sAvailable),
        adr: ratio(sGross, sSold),
        stays: sStays.size,
        profitPerAvailableNight: siblingProfit,
      },
      deltaPerNight,
      deltaTotal: deltaPerNight * nights,
    });
  }
  longStayDuels.sort((a, b) => b.from.localeCompare(a.from));

  const longStaySummary: LongStaySummary[] = classes.map((c) => {
    const duels = longStayDuels.filter((d) => d.classId === c.id);
    const nights = duels.reduce((a, d) => a + d.nights, 0);
    const totalDelta = duels.reduce((a, d) => a + d.deltaTotal, 0);
    return {
      classId: c.id,
      duels: duels.length,
      won: duels.filter((d) => d.deltaPerNight > 0).length,
      nights,
      avgDeltaPerNight: ratio(totalDelta, nights),
      totalDelta,
    };
  });

  // ── Sold-out dates per class ───────────────────────────────────────────────
  const soldOut: ClassSoldOut[] = classes.map((c) => {
    const byDate = new Map<string, { capacity: number; sold: number; shortGross: number; shortSold: number }>();
    for (const cell of cellsOfClass.get(c.id) ?? []) {
      const d = byDate.get(cell.date) ?? { capacity: 0, sold: 0, shortGross: 0, shortSold: 0 };
      d.capacity += cell.available;
      d.sold += cell.nights.length;
      for (const n of cell.nights) {
        if (n.span < longMin) {
          d.shortGross += n.gross;
          d.shortSold += 1;
        }
      }
      byDate.set(cell.date, d);
    }

    const days: SoldOutDay[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = byDate.get(d);
      if (!v || v.capacity === 0) continue;
      days.push({ date: d, capacity: v.capacity, sold: v.sold, soldOut: v.sold >= v.capacity, future: d >= today });
    }

    let longestRun = 0;
    let run = 0;
    let prev: string | null = null;
    for (const day of days) {
      // A run only continues across consecutive calendar dates.
      const continues = run > 0 && prev !== null && addDays(prev, 1) === day.date;
      run = day.soldOut ? (continues ? run + 1 : 1) : 0;
      longestRun = Math.max(longestRun, run);
      prev = day.date;
    }

    const weekday: ClassWeekdayPoint[] = DOW_LABELS.map((label, i) => {
      const dow = i + 1;
      const ofDow = days.filter((d) => isoDow(d.date) === dow);
      let available = 0;
      let sold = 0;
      let soldOutDates = 0;
      let g = 0;
      let s = 0;
      let gFull = 0;
      let sFull = 0;
      let gSpare = 0;
      let sSpare = 0;
      for (const day of ofDow) {
        const v = byDate.get(day.date)!;
        available += v.capacity;
        sold += v.sold;
        g += v.shortGross;
        s += v.shortSold;
        if (day.soldOut) {
          soldOutDates += 1;
          gFull += v.shortGross;
          sFull += v.shortSold;
        } else {
          gSpare += v.shortGross;
          sSpare += v.shortSold;
        }
      }
      return {
        isoDow: dow,
        label,
        dates: ofDow.length,
        availableNights: available,
        soldNights: sold,
        occupancy: ratio(sold, available),
        soldOutDates,
        soldOutRate: ratio(soldOutDates, ofDow.length),
        shortStayAdr: ratio(g, s),
        shortStayAdrSoldOut: sFull > 0 ? gFull / sFull : null,
        shortStayAdrSpare: sSpare > 0 ? gSpare / sSpare : null,
        spareDates: ofDow.length - soldOutDates,
      };
    });

    const soldOutDates = days.filter((d) => d.soldOut).length;
    return {
      classId: c.id,
      rooms: c.rooms.length,
      dates: days.length,
      soldOutDates,
      soldOutRate: ratio(soldOutDates, days.length),
      longestRun,
      days,
      weekday,
    };
  });

  // ── Forward position against the market ────────────────────────────────────
  const marketHorizon = new Map(input.forward.market.map((r) => [`${r.listingId}|${r.horizonDays}`, r]));
  const forward = classes.map((c) => {
    const rooms = new Set(c.rooms);
    const inClass = (room: string) => classOfRoom.get(room) === c.id;
    const listingIds = input.listings.filter((l) => l.rooms.some((r) => rooms.has(r))).map((l) => l.listingId);
    const compSets = listingIds
      .map((id) => input.forward.market.find((r) => r.listingId === id && r.compSet !== null)?.compSet ?? null)
      .filter((v): v is number => v !== null && v > 0);
    const horizons: ClassForwardHorizon[] = input.forward.horizons.map(({ days, label }) => {
      const end = addDays(today, days);
      let available = 0;
      const perListing = new Map<string, number>();
      for (const a of input.forward.available) {
        if (!rooms.has(a.room) || a.date < today || a.date >= end) continue;
        available += 1;
        const listing = listingOfRoom.get(a.room);
        if (listing) perListing.set(listing, (perListing.get(listing) ?? 0) + 1);
      }
      const sold = input.forward.nights.filter((n) => inClass(n.room) && n.date >= today && n.date < end).length;
      let mSum = 0;
      let mWeight = 0;
      for (const [listing, w] of perListing) {
        const occ = marketHorizon.get(`${listing}|${days}`)?.occupancy;
        if (occ == null) continue;
        mSum += occ * w;
        mWeight += w;
      }
      const ourOccupancy = ratio(sold, available);
      const marketOccupancy = mWeight > 0 ? mSum / mWeight : null;
      return {
        horizonDays: days,
        label,
        ourOccupancy,
        ourSoldNights: sold,
        ourAvailableNights: available,
        marketOccupancy,
        mpi: marketOccupancy && marketOccupancy > 0 ? ourOccupancy / marketOccupancy : null,
      };
    });
    return { classId: c.id, compSetListings: compSets.length > 0 ? Math.min(...compSets) : null, horizons };
  });

  // ── Notes ──────────────────────────────────────────────────────────────────
  const notes: string[] = [];
  const unallocated = allCells.filter((c) => !c.physical).reduce((a, c) => a + c.nights.length, 0);
  if (unallocated > 0) {
    notes.push(
      `${unallocated} studio night${unallocated === 1 ? '' : 's'} in this window belong to bookings never tied to a specific room (the pre-Beds24 imports). They count in the 1KK totals and sold-out dates, but in no single room's row.`,
    );
  }

  const classInfo: OccupancyClassInfo[] = classes.map((c) => ({
    id: c.id,
    label: c.label,
    description: c.description,
    rooms: c.rooms,
  }));

  return {
    classes: classInfo,
    longStayMinNights: longMin,
    profitCoverage: { costsAvailable, costsFrom, completedBefore: today },
    scorecard,
    monthly,
    forward,
    roomMonths,
    roomTotals,
    sameMonthPairs,
    losEconomics,
    longStayDuels,
    longStaySummary,
    soldOut,
    notes,
  };
}
