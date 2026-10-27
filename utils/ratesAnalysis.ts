/**
 * The Rates tab's engine — gross profit by rate plan, promotion and channel,
 * cancellation resale, per room class.
 *
 * Pure: takes rows already read from Postgres (and the turnover cost per
 * checkout from the cost engine) and returns the response. No database, no
 * Redis, no `process.env` — so every rule below is unit-tested in
 * `ratesAnalysis.test.ts`, and the data-access layer is only plumbing.
 *
 * WHY GROSS PROFIT AND NOT ADR
 * ----------------------------
 * Rate plans and promotions exist to raise gross profit, and ADR misleads on
 * every one of the four questions this tab answers:
 *   - a flexible rate's higher ADR is worth nothing on the nights it cancels;
 *   - a deal that discounts a night the class was filling anyway costs money;
 *   - a cancelled night resold at half price still looks like a sale;
 *   - a direct night at a lower ADR can out-earn a Booking.com one, because
 *     ~17% of the Booking.com rate goes back to Booking.com.
 * So every slice carries gross − commission − payment fees − turnover cost.
 *
 * WHY PER CLASS
 * -------------
 * 1KK studios and 2KK apartments differ in price, season and guest mix. A
 * blended plan or channel comparison mostly measures which class each plan
 * happened to sell in, so every figure is produced for 1KK, 2KK and the blend.
 *
 * THE SAME-DATE COMPARISON
 * ------------------------
 * Averages compare WHEN things sold as much as WHAT sold. Pairing nights of the
 * same sellable unit on the same date removes the season, the weekday and the
 * event calendar, leaving the plan or channel itself. It is the number to
 * believe whenever it has enough matched dates; the averages are context.
 */
import { SELLABLE_UNITS } from '@/data/analyticsConfig';
import type {
  ChannelRow,
  DirectPricingCheck,
  LeadAdrRow,
  PromoCampaignRow,
  PromoRow,
  RateClassId,
  RateEconomics,
  RateMixMonthPoint,
  RatePlanRow,
  RatesClassView,
  RatesResponse,
  ResaleRow,
  SameDateComparison,
} from '@/utils/analyticsTypes';
import {
  buildRateIdPlanMap,
  parseRateLine,
  RATE_PLAN_ORDER,
  resolvePlan,
  TIME_LIMITED_PROMOS,
  type PromoFamily,
  type RatePlanFamily,
} from '@/utils/rateDescription';

// ── Room classes ─────────────────────────────────────────────────────────────

/**
 * The two room classes the business prices as separate products. Built on the
 * sellable units so a virtual-room label ("1KK Urban Studios", an unallocated
 * booking) lands in its class instead of falling out of the split.
 */
export const RATE_CLASSES: { id: Exclude<RateClassId, 'all'>; label: string; description: string; unitIds: string[] }[] = [
  {
    id: '1kk',
    label: '1KK studios',
    description: 'Urban K.102 · K.103 · K.106 and Deluxe K.202 · K.203',
    unitIds: ['urban-1kk', 'deluxe-1kk'],
  },
  {
    id: '2kk',
    label: '2KK apartments',
    description: 'K.201 and O.308',
    unitIds: ['k201', 'o308'],
  },
];

const UNIT_BY_ROOM = new Map<string, string>(
  SELLABLE_UNITS.flatMap((u) => [...u.rooms.map((r) => [r, u.id] as const), [u.label, u.id] as const]),
);
const CLASS_BY_UNIT = new Map<string, Exclude<RateClassId, 'all'>>(
  RATE_CLASSES.flatMap((c) => c.unitIds.map((u) => [u, c.id] as const)),
);

export function unitOfRoom(room: string): string | null {
  return UNIT_BY_ROOM.get(room) ?? null;
}

export function classOfRoom(room: string): Exclude<RateClassId, 'all'> | null {
  const unit = unitOfRoom(room);
  return unit ? (CLASS_BY_UNIT.get(unit) ?? null) : null;
}

/**
 * Same-date comparisons need this many matched (unit, date) cells before a
 * delta is reported. Below it the comparison is shown as a count and withheld —
 * a percentage off six nights is noise wearing a finding's clothes.
 */
export const MIN_MATCHED_DATES = 10;

/**
 * …and the matched nights on the compared side must come from at least this many
 * bookings. One 30-night stay overlapping thirty Booking.com nights is one
 * pricing decision, not thirty, and must not read as a robust comparison.
 */
export const MIN_MATCHED_BOOKINGS = 5;

/** Genius vs non-Genius ADR needs this many bookings either side. */
const MIN_GENIUS_BOOKINGS = 15;

/** 'Direct' is the pre-split label for direct bookings, still on older rows. */
const DIRECT_CHANNELS = ['Direct-Web', 'Direct-Phone', 'Direct'];
const BOOKING_COM = 'Booking.com';

// ── Inputs ───────────────────────────────────────────────────────────────────

/** One sold room-night, straight from the `nights` CTE (all channels). */
export interface RateNightInput {
  reservationNumber: string;
  room: string;
  channel: string;
  stayDate: string;
  price: number;
  commission: number;
  fee: number;
}

/** One booking × room from the `alloc` CTE, live AND cancelled, all dates. */
export interface RateBookingInput {
  reservationNumber: string;
  source: string;
  channel: string;
  room: string;
  rateType: string | null;
  /** First line of Beds24's rateDescription. */
  rateLine: string;
  /** Per-night value before cancellation (this room's share), when the description carries it. */
  originalNightly: number | null;
  checkIn: string;
  checkOut: string;
  spanNights: number;
  reservationDate: string | null;
  bookedAt: string | null;
  /** Effective cancellation instant (see ASOF_NIGHTS_CTE). */
  cancelledAt: string | null;
  isCancelled: boolean;
  cancelClass: 'guest' | 'abandoned' | null;
  price: number;
  commission: number;
  fee: number;
}

export interface RatesInput {
  from: string;
  to: string;
  /** Today in Prague — cancelled nights from today on have no known fate yet. */
  today: string;
  rooms: string[];
  channels: string[];
  query: RatesResponse['query'];
  /** Sold nights inside the window, room-filtered, ALL channels. */
  nights: RateNightInput[];
  /** Every non-blackout booking × room (the whole archive — rate ids are learned from all of it). */
  bookings: RateBookingInput[];
  /** Available (room, date) pairs inside the window, room-filtered. */
  available: { room: string; stayDate: string }[];
  /** Turnover cost (cleaning + laundry + consumables) per `${checkout}|${room}`; null = costs unavailable. */
  turnoverByCheckout: Map<string, number> | null;
  leadBuckets: { label: string; min: number; max: number | null }[];
  losBuckets: { label: string; min: number; max: number | null }[];
  farOut: { nearDays: number; farDays: number; premium: number };
  notes?: string[];
}

// ── Internal records ─────────────────────────────────────────────────────────

interface BookingRec extends RateBookingInput {
  plan: RatePlanFamily;
  promo: PromoFamily;
  promoName: string | null;
  genius: boolean;
  unitId: string | null;
  classId: Exclude<RateClassId, 'all'> | null;
  leadDays: number | null;
  turnover: number;
  turnoverSource: 'actual' | 'estimated' | 'none';
}

interface NightRec extends RateNightInput {
  booking: BookingRec | null;
  unitId: string | null;
  classId: Exclude<RateClassId, 'all'> | null;
  turnover: number;
  net: number;
  gp: number;
  bookedAtMs: number | null;
  /** How full the rest of this night's class was (other rooms sold ÷ other rooms available). */
  dateStrength: number | null;
}

interface CancelledNight {
  booking: BookingRec;
  stayDate: string;
  unitId: string | null;
  classId: Exclude<RateClassId, 'all'> | null;
  past: boolean;
  originalPrice: number | null;
  originalGp: number | null;
  resold: boolean;
  replacement: NightRec | null;
  daysToResell: number | null;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const ratio = (a: number, b: number): number => (b > 0 ? a / b : 0);

function dayMs(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((dayMs(toIso) - dayMs(fromIso)) / 86_400_000);
}

function addDays(iso: string, n: number): string {
  return new Date(dayMs(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

function tsMs(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function bucketOf(
  buckets: { label: string; min: number; max: number | null }[],
  value: number,
): string | null {
  return buckets.find((b) => value >= b.min && (b.max === null || value <= b.max))?.label ?? null;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k);
    if (list) list.push(item);
    else out.set(k, [item]);
  }
  return out;
}

const mean = (values: number[]): number | null =>
  values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;

// ── Economics of a slice ─────────────────────────────────────────────────────

function economics(nights: NightRec[], bookings: BookingRec[], classNights: number): RateEconomics {
  let gbv = 0;
  let commission = 0;
  let fees = 0;
  let turnover = 0;
  const perBooking = new Map<string, BookingRec | null>();
  for (const n of nights) {
    gbv += n.price;
    commission += n.commission;
    fees += n.fee;
    turnover += n.turnover;
    if (!perBooking.has(n.reservationNumber)) perBooking.set(n.reservationNumber, n.booking);
  }
  const netSales = gbv - commission - fees;
  const grossProfit = netSales - turnover;
  const stays = [...perBooking.values()].filter((b): b is BookingRec => b !== null);

  // Cancellation rate on the booking grain; abandoned checkouts excluded on
  // both sides so the rate matches every other section's.
  const cancellable = new Set<string>();
  const cancelled = new Set<string>();
  for (const b of bookings) {
    if (b.isCancelled && b.cancelClass !== 'guest') continue;
    cancellable.add(b.reservationNumber);
    if (b.isCancelled) cancelled.add(b.reservationNumber);
  }

  return {
    bookings: perBooking.size,
    nights: nights.length,
    nightShare: ratio(nights.length, classNights),
    gbv,
    commission,
    paymentFees: fees,
    turnoverCost: turnover,
    netSales,
    grossProfit,
    adr: ratio(gbv, nights.length),
    netAdr: ratio(netSales, nights.length),
    gpPerNight: ratio(grossProfit, nights.length),
    takeRate: ratio(commission + fees, gbv),
    turnoverPerNight: ratio(turnover, nights.length),
    avgLengthOfStay: mean(stays.map((b) => b.spanNights)) ?? 0,
    avgLeadDays: mean(stays.filter((b) => b.leadDays !== null).map((b) => b.leadDays!)) ?? 0,
    cancellableBookings: cancellable.size,
    guestCancellations: cancelled.size,
    cancellationRate: ratio(cancelled.size, cancellable.size),
  };
}

// ── Same unit, same date ─────────────────────────────────────────────────────

/** ISO week + weekend flag: the fallback cell for single-room units. */
function weekCell(iso: string): string {
  const d = new Date(dayMs(iso));
  const dow = (d.getUTCDay() + 6) % 7; // Mon = 0
  const thursday = new Date(dayMs(iso) + (3 - dow) * 86_400_000);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((thursday.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${thursday.getUTCFullYear()}-W${week}-${dow === 4 || dow === 5 ? 'we' : 'wd'}`;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The MEDIAN gap across matched cells, not the ratio of totals. One odd booking
 * (a mispriced web stay, a comp night at 0 Kč) moves a mean by several points
 * and a median not at all, and these comparisons are read as "what does this
 * plan do to the price of a night", which is a typical-night question.
 *
 * Cells are (unit, date) first. K.201 and O.308 are single rooms, so two
 * bookings can never share a unit-night there; when the date grain cannot
 * reach the floor, cells widen to (unit, ISO week, weekday vs Fri/Sat) — still
 * the same season and the same kind of night, and stated as such.
 */
function sameDate(slice: NightRec[], reference: NightRec[], against: string): SameDateComparison {
  const cells = (rows: NightRec[], grain: 'date' | 'week') => {
    const map = new Map<string, { price: number; net: number; gp: number; n: number; res: Set<string> }>();
    for (const r of rows) {
      if (!r.unitId) continue;
      const key = `${r.unitId}|${grain === 'date' ? r.stayDate : weekCell(r.stayDate)}`;
      const c = map.get(key) ?? { price: 0, net: 0, gp: 0, n: 0, res: new Set<string>() };
      c.price += r.price;
      c.net += r.net;
      c.gp += r.gp;
      c.n += 1;
      c.res.add(r.reservationNumber);
      map.set(key, c);
    }
    return map;
  };
  const compare = (grain: 'date' | 'week') => {
    const a = cells(slice, grain);
    const b = cells(reference, grain);
    const adr: number[] = [];
    const net: number[] = [];
    const gp: number[] = [];
    const bookings = new Set<string>();
    for (const [key, ca] of a) {
      const cb = b.get(key);
      if (!cb) continue;
      for (const res of ca.res) bookings.add(res);
      if (cb.price > 0) adr.push(ca.price / ca.n / (cb.price / cb.n));
      if (cb.net > 0) net.push(ca.net / ca.n / (cb.net / cb.n));
      if (cb.gp > 0) gp.push((ca.gp / ca.n - cb.gp / cb.n) / (cb.gp / cb.n));
    }
    return { grain, matched: adr.length, bookings: bookings.size, adr, net, gp };
  };
  let result = compare('date');
  if (result.matched < MIN_MATCHED_DATES) {
    const wider = compare('week');
    if (wider.matched > result.matched) result = wider;
  }
  const comparable = result.matched >= MIN_MATCHED_DATES && result.bookings >= MIN_MATCHED_BOOKINGS;
  const m = (values: number[], offset: number) => {
    const v = median(values);
    return comparable && v !== null ? v - offset : null;
  };
  return {
    against,
    grain: result.grain,
    matchedDates: result.matched,
    matchedBookings: result.bookings,
    adrDelta: m(result.adr, 1),
    netAdrDelta: m(result.net, 1),
    gpDelta: m(result.gp, 0),
    comparable,
  };
}

// ── Resale aggregation ───────────────────────────────────────────────────────

function resaleRow(label: string, channel: string | null, rows: CancelledNight[]): ResaleRow {
  const past = rows.filter((r) => r.past);
  const resold = past.filter((r) => r.resold);
  const known = past.filter((r) => r.originalPrice !== null);
  const knownResold = resold.filter((r) => r.originalPrice !== null && r.replacement);
  const originalOfResold = knownResold.reduce((a, r) => a + r.originalPrice!, 0);
  const resaleOfResold = knownResold.reduce((a, r) => a + r.replacement!.price, 0);

  const bookings = new Map<string, BookingRec>();
  for (const r of rows) bookings.set(r.booking.reservationNumber, r.booking);
  const daysBefore = [...bookings.values()]
    .filter((b) => b.cancelledAt)
    .map((b) => daysBetween(b.cancelledAt!.slice(0, 10), b.checkIn));

  return {
    label,
    channel,
    cancelledBookings: bookings.size,
    cancelledNights: past.length,
    resoldNights: resold.length,
    resaleRate: ratio(resold.length, past.length),
    originalAdr: mean(known.map((r) => r.originalPrice!)),
    resaleAdr: mean(resold.filter((r) => r.replacement).map((r) => r.replacement!.price)),
    priceRatio: originalOfResold > 0 ? resaleOfResold / originalOfResold : null,
    originalGp: known.length > 0 ? known.reduce((a, r) => a + (r.originalGp ?? 0), 0) : null,
    recoveredGp: known.filter((r) => r.resold && r.replacement).reduce((a, r) => a + r.replacement!.gp, 0),
    avgDaysBeforeArrival: mean(daysBefore),
    avgDaysToResell: mean(resold.filter((r) => r.daysToResell !== null).map((r) => r.daysToResell!)),
    openNights: rows.length - past.length,
  };
}

// ── The build ────────────────────────────────────────────────────────────────

export function buildRatesResponse(input: RatesInput): RatesResponse {
  const { from, to, today } = input;
  const notes = [...(input.notes ?? [])];
  const channelOk = (channel: string) => input.channels.length === 0 || input.channels.includes(channel);
  const roomOk = (room: string) => input.rooms.length === 0 || input.rooms.includes(room);

  // ── Parse every booking once; learn rate id → plan from the whole archive ──
  const parsed = input.bookings.map((b) => parseRateLine(b.rateLine));
  const idPlans = buildRateIdPlanMap(parsed);

  const bookings: BookingRec[] = input.bookings.map((b, i) => {
    const p = parsed[i];
    const unitId = unitOfRoom(b.room);
    return {
      ...b,
      plan: resolvePlan(p, b.rateType, idPlans),
      promo: p.promo,
      promoName: p.promoName,
      genius: p.genius,
      unitId,
      classId: unitId ? (CLASS_BY_UNIT.get(unitId) ?? null) : null,
      leadDays: b.reservationDate ? daysBetween(b.reservationDate, b.checkIn) : null,
      turnover: 0,
      turnoverSource: 'none',
    };
  });

  // ── Turnover cost per stay: the logged checkout cleaning, else the unit's average ──
  //
  // A stay that has not checked out yet, a pre-Beds24 legacy stay and the odd
  // unlogged checkout have no cell. Leaving them at zero would flatter exactly the
  // slices with the most future nights (far-out plans, Early Booker), so they are
  // costed at their unit's average logged turnover instead, and counted.
  const costs = input.turnoverByCheckout;
  const samples = new Map<string, number[]>();
  if (costs) {
    for (const b of bookings) {
      if (b.isCancelled || !b.unitId) continue;
      const cell = costs.get(`${b.checkOut}|${b.room}`);
      if (cell && cell > 0) {
        b.turnover = cell;
        b.turnoverSource = 'actual';
        const list = samples.get(b.unitId) ?? [];
        list.push(cell);
        samples.set(b.unitId, list);
      }
    }
    const all = [...samples.values()].flat();
    const overall = mean(all) ?? 0;
    for (const b of bookings) {
      if (b.isCancelled || b.turnoverSource === 'actual') continue;
      b.turnover = (b.unitId ? mean(samples.get(b.unitId) ?? []) : null) ?? overall;
      b.turnoverSource = 'estimated';
    }
  }
  const estimateByUnit = new Map<string, number>(
    [...samples.entries()].map(([u, list]) => [u, mean(list) ?? 0]),
  );

  const byKey = new Map(bookings.map((b) => [`${b.reservationNumber}|${b.room}`, b]));
  const byRes = new Map<string, BookingRec>();
  for (const b of bookings) if (!byRes.has(b.reservationNumber)) byRes.set(b.reservationNumber, b);

  // ── Capacity per (class, date) and (unit, date) ──
  const availByUnitDate = new Map<string, number>();
  const availByClassDate = new Map<string, number>();
  for (const a of input.available) {
    const unit = unitOfRoom(a.room);
    if (!unit) continue;
    const cls = CLASS_BY_UNIT.get(unit);
    availByUnitDate.set(`${unit}|${a.stayDate}`, (availByUnitDate.get(`${unit}|${a.stayDate}`) ?? 0) + 1);
    if (cls) availByClassDate.set(`${cls}|${a.stayDate}`, (availByClassDate.get(`${cls}|${a.stayDate}`) ?? 0) + 1);
  }

  // ── Nights, with their booking's attributes and turnover share ──
  const allNights: NightRec[] = input.nights.map((n) => {
    const booking = byKey.get(`${n.reservationNumber}|${n.room}`) ?? byRes.get(n.reservationNumber) ?? null;
    const unitId = unitOfRoom(n.room);
    const turnover = booking && booking.spanNights > 0 ? booking.turnover / booking.spanNights : 0;
    const net = n.price - n.commission - n.fee;
    return {
      ...n,
      booking,
      unitId,
      classId: unitId ? (CLASS_BY_UNIT.get(unitId) ?? null) : null,
      turnover,
      net,
      gp: net - turnover,
      bookedAtMs: tsMs(booking?.bookedAt ?? null),
      dateStrength: null,
    };
  });

  const soldByClassDate = new Map<string, number>();
  const nightsByUnitDate = groupBy(
    allNights.filter((n) => n.unitId),
    (n) => `${n.unitId}|${n.stayDate}`,
  );
  for (const n of allNights) {
    if (!n.classId) continue;
    const key = `${n.classId}|${n.stayDate}`;
    soldByClassDate.set(key, (soldByClassDate.get(key) ?? 0) + 1);
  }
  for (const n of allNights) {
    if (!n.classId) continue;
    const key = `${n.classId}|${n.stayDate}`;
    const otherAvailable = (availByClassDate.get(key) ?? 0) - 1;
    const otherSold = (soldByClassDate.get(key) ?? 0) - 1;
    n.dateStrength = otherAvailable > 0 ? Math.min(1, Math.max(0, otherSold / otherAvailable)) : null;
  }

  // ── Average take rate per channel, to price a cancelled night's lost commission ──
  const takeByChannel = new Map<string, number>();
  for (const [channel, list] of groupBy(allNights, (n) => n.channel)) {
    const gbv = list.reduce((a, n) => a + n.price, 0);
    takeByChannel.set(channel, ratio(list.reduce((a, n) => a + n.commission + n.fee, 0), gbv));
  }

  // ── Cancelled nights inside the window, and whether each was resold ──
  //
  // Resale is judged per SELLABLE UNIT and date, not per physical room: Beds24
  // reshuffles interchangeable studios, so the night a K.103 cancellation freed
  // is often resold as K.106. Capacity-aware: when the unit still had empty rooms
  // at the end of the night, a cancellation was not resold however many later
  // bookings arrived — those bookings had room anyway. Each resold night is
  // matched to the earliest booking made after the cancellation.
  const cancelledNights: CancelledNight[] = [];
  for (const b of bookings) {
    if (!b.isCancelled || b.cancelClass !== 'guest' || b.spanNights <= 0) continue;
    if (!(b.checkIn <= to && b.checkOut > from)) continue;
    if (!roomOk(b.room)) continue;
    const start = b.checkIn > from ? b.checkIn : from;
    const lastNight = addDays(b.checkOut, -1);
    const end = lastNight < to ? lastNight : to;
    const perNight = b.originalNightly;
    const estTurnover = (b.unitId ? estimateByUnit.get(b.unitId) : undefined) ?? 0;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      cancelledNights.push({
        booking: b,
        stayDate: d,
        unitId: b.unitId,
        classId: b.classId,
        past: d < today,
        originalPrice: perNight,
        originalGp:
          perNight === null
            ? null
            : perNight * (1 - (takeByChannel.get(b.channel) ?? 0)) - (costs ? estTurnover / b.spanNights : 0),
        resold: false,
        replacement: null,
        daysToResell: null,
      });
    }
  }
  for (const [key, cell] of groupBy(
    cancelledNights.filter((c) => c.past && c.unitId),
    (c) => `${c.unitId}|${c.stayDate}`,
  )) {
    const live = nightsByUnitDate.get(key) ?? [];
    const capacity = availByUnitDate.get(key) ?? 0;
    let quota = cell.length - Math.min(cell.length, Math.max(0, capacity - live.length));
    const ordered = [...cell].sort(
      (a, b) => (tsMs(a.booking.cancelledAt) ?? 0) - (tsMs(b.booking.cancelledAt) ?? 0),
    );
    const replacements = [...live].sort((a, b) => (a.bookedAtMs ?? 0) - (b.bookedAtMs ?? 0));
    const used = new Set<NightRec>();
    for (const c of ordered) {
      if (quota <= 0) break;
      const cancelMs = tsMs(c.booking.cancelledAt);
      const r = replacements.find(
        (x) => !used.has(x) && x.booking?.reservationNumber !== c.booking.reservationNumber &&
          (cancelMs === null || (x.bookedAtMs !== null && x.bookedAtMs > cancelMs)),
      );
      if (!r) continue;
      used.add(r);
      quota -= 1;
      c.resold = true;
      c.replacement = r;
      c.daysToResell =
        cancelMs !== null && r.bookedAtMs !== null
          ? Math.max(0, Math.round((r.bookedAtMs - cancelMs) / 86_400_000))
          : null;
    }
  }

  // ── Cost coverage, for the footnote ──
  const coveredKeys = new Set(allNights.map((n) => n.booking).filter((b): b is BookingRec => !!b));
  const costCoverage: RatesResponse['costCoverage'] = {
    available: costs !== null,
    actual: [...coveredKeys].filter((b) => b.turnoverSource === 'actual').length,
    estimated: [...coveredKeys].filter((b) => b.turnoverSource === 'estimated').length,
    perCheckoutByUnit: SELLABLE_UNITS.filter((u) => samples.has(u.id)).map((u) => ({
      unitId: u.id,
      label: u.shortLabel,
      perCheckout: estimateByUnit.get(u.id) ?? 0,
      samples: samples.get(u.id)?.length ?? 0,
    })),
  };
  if (!costs) {
    notes.push(
      'Turnover costs are unavailable in this environment, so gross profit here equals net sales (gross − commission − fees).',
    );
  }

  // ── One view per class ──
  const views: RatesClassView[] = [
    ...RATE_CLASSES.map((c) => ({
      id: c.id as RateClassId,
      label: c.label,
      description: c.description,
      unitIds: c.unitIds,
    })),
    {
      id: 'all' as RateClassId,
      label: 'Both classes',
      description: 'Every room, blended',
      unitIds: SELLABLE_UNITS.map((u) => u.id),
    },
  ].map((cls) => {
    const inClass = (classId: string | null) => cls.id === 'all' || classId === cls.id;
    const nights = allNights.filter((n) => inClass(n.classId) && channelOk(n.channel));
    const windowBookings = bookings.filter(
      (b) =>
        inClass(b.classId) &&
        channelOk(b.channel) &&
        roomOk(b.room) &&
        b.spanNights > 0 &&
        b.checkIn <= to &&
        b.checkOut > from,
    );
    const cancels = cancelledNights.filter((c) => inClass(c.classId) && channelOk(c.booking.channel));
    const totalNights = nights.length;
    const totals = economics(nights, windowBookings, totalNights);

    // ── Q1: rate plans ──
    const bcomNonRef = nights.filter((n) => n.channel === BOOKING_COM && n.booking?.plan === 'Non-refundable');
    const planKey = (channel: string, plan: string) => `${channel}|${plan}`;
    const nightsByPlan = groupBy(nights, (n) => planKey(n.channel, n.booking?.plan ?? 'Unspecified'));
    const bookingsByPlan = groupBy(windowBookings, (b) => planKey(b.channel, b.plan));
    const cancelsByPlan = groupBy(cancels, (c) => planKey(c.booking.channel, c.booking.plan));
    const planKeys = new Set([...nightsByPlan.keys(), ...cancelsByPlan.keys()]);
    const plans: RatePlanRow[] = [...planKeys]
      .map((key) => {
        const [channel, plan] = key.split('|');
        const pn = nightsByPlan.get(key) ?? [];
        const pc = cancelsByPlan.get(key) ?? [];
        const econ = economics(pn, bookingsByPlan.get(key) ?? [], totalNights);
        const recovered = pc.filter((c) => c.resold && c.replacement).reduce((a, c) => a + c.replacement!.gp, 0);
        return {
          ...econ,
          channel,
          plan,
          vsNonRefundable:
            channel === BOOKING_COM && plan !== 'Non-refundable' && pn.length > 0
              ? sameDate(pn, bcomNonRef, 'Booking.com Non-refundable')
              : null,
          cancelledNights: pc.filter((c) => c.past).length,
          resoldNights: pc.filter((c) => c.resold).length,
          gpPerBookedNight: ratio(econ.grossProfit + recovered, pn.length + pc.length),
        };
      })
      .filter((r) => r.nights > 0 || r.cancelledNights > 0)
      .sort((a, b) => {
        const ch = (x: string) => (x === BOOKING_COM ? 0 : x === 'Airbnb' ? 1 : 2);
        return (
          ch(a.channel) - ch(b.channel) ||
          a.channel.localeCompare(b.channel) ||
          RATE_PLAN_ORDER.indexOf(a.plan as RatePlanFamily) - RATE_PLAN_ORDER.indexOf(b.plan as RatePlanFamily)
        );
      });

    // ── Q2: promotions ──
    const nightsByPromo = groupBy(nights, (n) => n.booking?.promo ?? 'No promotion');
    const bookingsByPromo = groupBy(windowBookings, (b) => b.promo);
    const promos: PromoRow[] = [...nightsByPromo.entries()]
      .map(([promo, pn]) => {
        const others = nights.filter((n) => (n.booking?.promo ?? 'No promotion') !== promo);
        const strengths = pn.filter((n) => n.dateStrength !== null).map((n) => n.dateStrength!);
        const promoBookings = bookingsByPromo.get(promo) ?? [];
        const byName = groupBy(pn, (n) => n.booking?.promoName ?? promo);
        const bookingsByName = groupBy(promoBookings, (b) => b.promoName ?? promo);
        const campaigns: PromoCampaignRow[] = [...byName.entries()]
          .map(([name, cn]) => {
            const e = economics(cn, bookingsByName.get(name) ?? [], totalNights);
            const dates = [...new Set(cn.map((n) => n.booking?.reservationDate).filter((d): d is string => !!d))].sort();
            return {
              name,
              firstBooked: dates[0] ?? null,
              lastBooked: dates[dates.length - 1] ?? null,
              bookings: e.bookings,
              nights: e.nights,
              adr: e.adr,
              gpPerNight: e.gpPerNight,
              cancellationRate: e.cancellationRate,
            };
          })
          .sort((a, b) => b.nights - a.nights);
        return {
          ...economics(pn, promoBookings, totalNights),
          promo,
          timeLimited: TIME_LIMITED_PROMOS.includes(promo as PromoFamily),
          vsSameDate: promo === 'No promotion' ? null : sameDate(pn, others, 'other nights, same unit and date'),
          dateStrength: mean(strengths),
          campaigns: promo === 'No promotion' ? [] : campaigns,
        };
      })
      .sort((a, b) => b.nights - a.nights);

    // ── Q4: channels and direct pricing ──
    const bcomNights = nights.filter((n) => n.channel === BOOKING_COM);
    const nightsByChannel = groupBy(nights, (n) => n.channel);
    const bookingsByChannel = groupBy(windowBookings, (b) => b.channel);
    const channels: ChannelRow[] = [...nightsByChannel.entries()]
      .map(([channel, cn]) => ({
        ...economics(cn, bookingsByChannel.get(channel) ?? [], totalNights),
        channel,
        vsBookingCom: channel === BOOKING_COM ? null : sameDate(cn, bcomNights, 'Booking.com'),
      }))
      .sort((a, b) => b.nights - a.nights);
    const bcom = channels.find((c) => c.channel === BOOKING_COM);
    const directPricing: DirectPricingCheck[] = channels
      .filter((c) => DIRECT_CHANNELS.includes(c.channel))
      .map((c) => {
        const tB = bcom?.takeRate ?? 0;
        const tD = c.takeRate;
        const cmp = c.vsBookingCom;
        const net = cmp?.netAdrDelta ?? null;
        return {
          channel: c.channel,
          takeRate: tD,
          bookingComTakeRate: tB,
          breakEvenDiscount: tD < 1 ? 1 - (1 - tB) / (1 - tD) : 0,
          grain: cmp?.grain ?? 'date',
          matchedDates: cmp?.matchedDates ?? 0,
          sameDateGrossDelta: cmp?.adrDelta ?? null,
          sameDateNetDelta: net,
          sameDateGpDelta: cmp?.gpDelta ?? null,
          verdict:
            !bcom || net === null
              ? 'insufficient-data'
              : net < -0.03
                ? 'too-cheap'
                : net <= 0.03
                  ? 'near-break-even'
                  : 'keeping-margin',
        };
      });

    // ── Q3: resale ──
    const resaleByPlan = [...groupBy(cancels, (c) => planKey(c.booking.channel, c.booking.plan)).entries()]
      .map(([key, rows]) => {
        const [channel, plan] = key.split('|');
        return resaleRow(plan, channel, rows);
      })
      .sort((a, b) => b.cancelledNights + b.openNights - (a.cancelledNights + a.openNights));
    const resaleByUnit = SELLABLE_UNITS.filter((u) => cls.id === 'all' || CLASS_BY_UNIT.get(u.id) === cls.id)
      .map((u) => resaleRow(u.shortLabel, null, cancels.filter((c) => c.unitId === u.id)))
      .filter((r) => r.cancelledNights + r.openNights > 0);
    const resaleTotal = resaleRow('All cancellations', null, cancels);

    // ── Far-out test ──
    const leadByBucket = groupBy(
      nights.filter((n) => n.booking?.leadDays != null),
      (n) => bucketOf(input.leadBuckets, n.booking!.leadDays!) ?? 'Unknown',
    );
    const leadBookings = groupBy(
      windowBookings.filter((b) => b.leadDays !== null && b.checkIn >= from && b.checkIn <= to),
      (b) => bucketOf(input.leadBuckets, b.leadDays!) ?? 'Unknown',
    );
    const leadAdr: LeadAdrRow[] = input.leadBuckets.map((bucket) => {
      const e = economics(leadByBucket.get(bucket.label) ?? [], leadBookings.get(bucket.label) ?? [], totalNights);
      return {
        label: bucket.label,
        minDays: bucket.min,
        maxDays: bucket.max,
        nights: e.nights,
        bookings: (leadBookings.get(bucket.label) ?? []).filter((b) => !b.isCancelled).length,
        adr: e.adr,
        gpPerNight: e.gpPerNight,
        vsReference: null,
        nightShare: e.nightShare,
        cancellationRate: e.cancellationRate,
        riskAdjustedAdr: e.adr * (1 - e.cancellationRate),
      };
    });
    const containing = (d: number) => leadAdr.find((b) => d >= b.minDays && (b.maxDays === null || d <= b.maxDays));
    const reference = containing(input.farOut.nearDays);
    if (reference && reference.adr > 0) {
      for (const row of leadAdr) row.vsReference = row.nights > 0 ? row.adr / reference.adr - 1 : null;
    }
    const far = containing(input.farOut.farDays);
    const achievedFarOutPremium =
      reference && far && reference.adr > 0 && far.nights > 0 ? far.adr / reference.adr - 1 : null;

    // ── Monthly channel mix ──
    const channelList = [...new Set(nights.map((n) => n.channel))].sort();
    const mixMonthly: RateMixMonthPoint[] = [...groupBy(nights, (n) => n.stayDate.slice(0, 7)).entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, mn]) => {
        const shares: Record<string, number> = {};
        for (const ch of channelList) shares[ch] = ratio(mn.filter((n) => n.channel === ch).length, mn.length);
        return {
          month,
          adr: ratio(mn.reduce((a, n) => a + n.price, 0), mn.length),
          gpPerNight: ratio(mn.reduce((a, n) => a + n.gp, 0), mn.length),
          shares,
        };
      });

    // ── Genius ──
    const geniusNights = bcomNights.filter((n) => n.booking?.genius);
    const otherBcom = bcomNights.filter((n) => !n.booking?.genius);
    const distinct = (rows: NightRec[]) => new Set(rows.map((n) => n.reservationNumber)).size;
    const comparable = distinct(geniusNights) >= MIN_GENIUS_BOOKINGS && distinct(otherBcom) >= MIN_GENIUS_BOOKINGS;
    const geniusAdr = ratio(geniusNights.reduce((a, n) => a + n.price, 0), geniusNights.length);
    const nonGeniusAdr = ratio(otherBcom.reduce((a, n) => a + n.price, 0), otherBcom.length);
    const genius =
      bcomNights.length > 0
        ? {
            geniusNights: geniusNights.length,
            totalBookingComNights: bcomNights.length,
            geniusNightShare: ratio(geniusNights.length, bcomNights.length),
            geniusAdr,
            nonGeniusAdr,
            adrDelta: comparable && nonGeniusAdr > 0 ? geniusAdr / nonGeniusAdr - 1 : null,
            comparable,
            minComparisonBookings: MIN_GENIUS_BOOKINGS,
          }
        : null;

    // ── Stay length ──
    const byLos = groupBy(nights, (n) => bucketOf(input.losBuckets, n.booking?.spanNights ?? 0) ?? 'Unknown');
    const losMix = input.losBuckets
      .map((bucket) => {
        const e = economics(byLos.get(bucket.label) ?? [], [], totalNights);
        return {
          label: bucket.label,
          bookings: e.bookings,
          nights: e.nights,
          adr: e.adr,
          gpPerNight: e.gpPerNight,
          nightShare: e.nightShare,
        };
      })
      .filter((r) => r.nights > 0);

    const share = (pred: (n: NightRec) => boolean) => ratio(nights.filter(pred).length, totalNights);
    const strengths = nights.filter((n) => n.dateStrength !== null).map((n) => n.dateStrength!);

    return {
      classId: cls.id,
      label: cls.label,
      description: cls.description,
      unitIds: cls.unitIds,
      totals,
      nonRefundableShare: share((n) => n.booking?.plan === 'Non-refundable'),
      promoShare: share((n) => (n.booking?.promo ?? 'No promotion') !== 'No promotion'),
      timeLimitedShare: share((n) => TIME_LIMITED_PROMOS.includes(n.booking?.promo ?? 'No promotion')),
      directShare: share((n) => DIRECT_CHANNELS.includes(n.channel)),
      avgDateStrength: mean(strengths),
      plans,
      promos,
      channels,
      directPricing,
      resaleByPlan,
      resaleByUnit,
      resaleTotal,
      leadAdr,
      achievedFarOutPremium,
      mixMonthly,
      channelList,
      genius,
      losMix,
    };
  });

  return {
    basis: 'stay',
    query: input.query,
    classes: views,
    configuredFarOutPremium: input.farOut,
    minMatchedDates: MIN_MATCHED_DATES,
    minMatchedBookings: MIN_MATCHED_BOOKINGS,
    costCoverage,
    notes,
  };
}
