import { describe, it, expect } from 'vitest';
import type { Reservation } from '@/types/reservation';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { VariableCostBundle } from './commissionCalc';
import { computeSettlement } from './commissionCalc';
import { computeGrossProfit } from './grossProfit';
import { ANNUAL_UNITS, COMMISSION_UNITS, unitCommissionRate } from './commissionConfig';
import {
  buildAnnualOverview,
  lastCompletedMonth,
  isReliableMonth,
  annualLineTree,
  flattenLineTree,
  availableYears,
  UNITEMISED_SUBSCRIPTION_ID,
  type AnnualLineNode,
} from './commissionYear';

/** Depth-first lookup by key, so a test can name a line without knowing where
 *  in the tree it currently sits. */
function findLine(nodes: AnnualLineNode[], key: string): AnnualLineNode | undefined {
  return flattenLineTree(nodes).find(({ node }) => node.key === key)?.node;
}
function findByLabel(nodes: AnnualLineNode[], label: string): AnnualLineNode | undefined {
  return flattenLineTree(nodes).find(({ node }) => node.label === label)?.node;
}

// Beds24 roomIds: K.102=679703, K.103=679704, K.106=679705, O.308=674672.
const K102 = '679703';

function res(over: Partial<Reservation> & Pick<Reservation, 'room' | 'checkInDate' | 'checkOutDate'>): Reservation {
  const nights =
    (new Date(over.checkOutDate).getTime() - new Date(over.checkInDate).getTime()) / 86_400_000;
  return {
    reservationNumber: `BH-${Math.random().toString(36).slice(2, 8)}`,
    firstName: 'A', lastName: 'B', channel: 'Direct', email: '', phone: '', nationality: 'CZ',
    reservationDate: over.checkInDate, bookingTimestamp: `${over.checkInDate}T10:00:00Z`,
    numberOfNights: nights, numberOfGuests: 2,
    price: 10_000, commissionAmount: 0, paymentChargeAmount: 0,
    cleaningStatus: 'Completed', paymentStatus: 'Paid', amountPaid: 10_000,
    additionalEmail: '', paymentStatusOverride: null, notes: '',
    manualFlagOverrides: {}, ratingStatus: 'None',
    ...over,
  } as unknown as Reservation;
}

/** Parking is a cleaning-app subscription item — the case that motivated
 *  itemisation: it started mid-year and only applies to the Urban rooms. */
const SUBSCRIPTIONS = [
  {
    id: 'internet-tv',
    label: 'Internet + TV',
    rooms: { [K102]: { enabled: true, monthlyAmount: 491 } },
  },
  {
    id: 'custom-parking',
    label: 'Parking',
    startDate: '2026-08-01',
    rooms: { [K102]: { enabled: true, monthlyAmount: 3025 } },
  },
];

function bundle(over: Partial<VariableCostBundle> = {}): VariableCostBundle {
  return {
    byDateRoom: {},
    byReservation: {},
    subscriptionItems: SUBSCRIPTIONS,
    manualCleaningKeys: [],
    noLaundryKeys: [],
    dismissedCleaningKeys: [],
    ...over,
  };
}

describe('subscription itemisation', () => {
  it('splits the subscriptions total into one line per cleaning-app item', () => {
    const t = computeGrossProfit([], { start: '2026-08-01', end: '2026-08-31' }, {}, {}, SUBSCRIPTIONS, [], [], [], ['K.102']);
    expect(t.subscriptions).toBe(491 + 3025);
    expect(t.subscriptionBreakdown).toEqual([
      { id: 'internet-tv', label: 'Internet + TV', amount: 491 },
      { id: 'custom-parking', label: 'Parking', amount: 3025 },
    ]);
    // The lines must always reconstruct the headline figure.
    expect(t.subscriptionBreakdown.reduce((s, l) => s + l.amount, 0)).toBe(t.subscriptions);
  });

  it('omits an item that is not yet active in the period', () => {
    // Parking starts 2026-08 — July must not show it at all, not even as a zero.
    const t = computeGrossProfit([], { start: '2026-07-01', end: '2026-07-31' }, {}, {}, SUBSCRIPTIONS, [], [], [], ['K.102']);
    expect(t.subscriptions).toBe(491);
    expect(t.subscriptionBreakdown.map((l) => l.id)).toEqual(['internet-tv']);
  });

  it('divides each line by the pool divisor so the statement lines still sum', () => {
    const unit = COMMISSION_UNITS.find((u) => u.id === 'K.102')!;
    const s = computeSettlement(unit, '2026-08', [], bundle());
    expect(s.subscriptionBreakdown!.reduce((sum, l) => sum + l.amount, 0)).toBeCloseTo(s.subscriptions, 6);
    // Pool ÷3: only K.102 carries the config here, so each unit takes a third.
    expect(s.subscriptionBreakdown!.find((l) => l.label === 'Parking')!.amount).toBeCloseTo(3025 / 3, 6);
  });
});

describe('commission rate per unit', () => {
  it('keeps the 25% rate for owner-settled units', () => {
    for (const u of COMMISSION_UNITS) expect(unitCommissionRate(u)).toBe(0.25);
  });

  it('gives BHA-owned rooms a structural zero rather than a default', () => {
    for (const id of ['K.103', 'K.201', 'K.202', 'K.203']) {
      expect(unitCommissionRate(ANNUAL_UNITS.find((u) => u.id === id)!)).toBe(0);
    }
  });

  it('produces zero commission and zero payable for a BHA-owned room that earned money', () => {
    const k201 = ANNUAL_UNITS.find((u) => u.id === 'K.201')!;
    const s = computeSettlement(k201, '2026-08', [res({ room: 'K.201', checkInDate: '2026-08-05', checkOutDate: '2026-08-10' })], bundle());
    expect(s.netSales).toBeGreaterThan(0);
    expect(s.grossProfit).toBeGreaterThan(0);
    expect(s.commissionAmount).toBe(0);
    // Not "the owner keeps 100%" — there is no owner, so nothing is payable out.
    expect(s.payableToOwner).toBe(0);
  });
});

/** A minimal issued settlement — enough to make a month "reliable". */
function issuedFor(unitId: string, month: string, over: Partial<CommissionSettlement> = {}): CommissionSettlement {
  return {
    id: `settle-${unitId}-${month}`, unitId, room: unitId, ownerName: 'Owner',
    mode: unitId === 'O.308' ? 'standalone' : 'urban-pool', month,
    periodStart: `${month}-01`, periodEnd: `${month}-28`,
    gbv: 0, otaCommission: 0, paymentFees: 0, netSales: 0,
    cleaning: 0, laundry: 0, consumables: 0, subscriptions: 3516 / 3, wearTear: 0, misc: 0,
    operationalCosts: 3516 / 3, grossProfit: 0, commissionRate: 0.25, commissionAmount: 0,
    payableToOwner: 0, reconciles: true, status: 'issued', createdAt: '', createdBy: '',
    ...over,
  };
}

describe('reliable months', () => {
  // Pin "today" so the cap on finished months can't make these tests drift with
  // the calendar. Standing in late August 2026, July is the last month done.
  const THROUGH = '2026-07';

  const reservations = [
    res({ room: 'K.102', checkInDate: '2026-08-05', checkOutDate: '2026-08-10', price: 30_000 }),
    // K.201 earns in an excluded month (Jan) and a counted one (May), so the
    // total can actually differ from the naive twelve-month sum.
    res({ room: 'K.201', checkInDate: '2026-01-06', checkOutDate: '2026-01-11', price: 40_000 }),
    res({ room: 'K.201', checkInDate: '2026-05-06', checkOutDate: '2026-05-11', price: 60_000 }),
  ];
  // Cost cells at both ends of the year so every month is inside coverage.
  const costs = bundle({
    byDateRoom: {
      [`2026-01-04|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
      [`2026-12-28|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
    },
  });
  const marks = (o: ReturnType<typeof buildAnnualOverview>, room: string) =>
    o.rows.find((r) => r.room === room)!.cells.map((c) => (c ? c.reliable : null));

  it('trusts the Urban pool only where a settlement was issued', () => {
    const o = buildAnnualOverview(2026, reservations, costs, [issuedFor('K.102', '2026-06'), issuedFor('K.106', '2026-06')], THROUGH);
    expect(marks(o, 'K.102')).toEqual([false, false, false, false, false, true, false, false, false, false, false, false]);
    expect(o.rows.find((r) => r.room === 'K.102')!.reliableCount).toBe(1);
  });

  it('lets K.103 inherit its pool sibling\u2019s settlements, having none of its own', () => {
    // K.103 is BHA-owned so never settles, but it shares the Urban pool with
    // K.102 — it is trustworthy exactly when K.102 is.
    const o = buildAnnualOverview(2026, reservations, costs, [issuedFor('K.102', '2026-06')], THROUGH);
    expect(marks(o, 'K.103')).toEqual(marks(o, 'K.102'));
    expect(o.rows.find((r) => r.room === 'K.103')!.reliableCount).toBe(1);
  });

  it('trusts K.202 / K.203 from March and K.201 from April, up to the last finished month', () => {
    const o = buildAnnualOverview(2026, reservations, costs, [], THROUGH);
    const window = (room: string, first: number, last: number) =>
      expect(marks(o, room)).toEqual(Array.from({ length: 12 }, (_, i) => i >= first && i <= last));
    window('K.202', 2, 6); // March–July
    window('K.203', 2, 6);
    window('K.201', 3, 6); // April (launched mid-March) – July
    expect(o.rows.find((r) => r.room === 'K.201')!.reliableCount).toBe(4);
    expect(o.rows.find((r) => r.room === 'K.202')!.reliableCount).toBe(5);
  });

  it('never counts the month in progress or anything after it', () => {
    // The month in progress is part-empty by definition, and later months are
    // pure forecast — counting either would flatter the yearly average.
    const o = buildAnnualOverview(2026, reservations, costs, [], THROUGH);
    for (const room of ['K.201', 'K.202', 'K.203']) {
      const cells = o.rows.find((r) => r.room === room)!.cells;
      expect(cells.slice(7).every((c) => c === null || !c.reliable)).toBe(true); // Aug onward
      expect(cells[6]!.reliable).toBe(true);                                      // July still counts
    }
  });

  it('lets an issued settlement count even in a month that has not finished', () => {
    // Issuing is a deliberate, frozen decision by the operator — the cap on
    // finished months must not overrule it.
    const o = buildAnnualOverview(2026, reservations, costs, [issuedFor('K.102', '2026-08')], THROUGH);
    expect(o.rows.find((r) => r.room === 'K.102')!.cells[7]!.reliable).toBe(true);
  });

  it('bounds a `from` rule at both ends', () => {
    const k202 = ANNUAL_UNITS.find((u) => u.id === 'K.202')!; // from 2026-03
    expect(isReliableMonth(k202, '2026-02', new Map(), THROUGH)).toBe(false); // before it was connected
    expect(isReliableMonth(k202, '2026-05', new Map(), THROUGH)).toBe(true);  // finished, in window
    expect(isReliableMonth(k202, '2026-07', new Map(), THROUGH)).toBe(true);  // the cap month itself
    expect(isReliableMonth(k202, '2026-08', new Map(), THROUGH)).toBe(false); // still running
    expect(isReliableMonth(k202, '2026-11', new Map(), THROUGH)).toBe(false); // hasn't happened
  });

  it('counts only reliable months in the total, and divides the average by them', () => {
    const o = buildAnnualOverview(2026, reservations, costs, [], THROUGH);
    const k201 = o.rows.find((r) => r.room === 'K.201')!;
    const reliableSum = k201.cells.reduce((sum, c) => sum + (c?.reliable ? c.grossProfit : 0), 0);
    const everyMonth = k201.cells.reduce((sum, c) => sum + (c?.grossProfit ?? 0), 0);
    expect(k201.reliableCount).toBe(4); // Apr–Jul
    expect(k201.total.grossProfit).toBeCloseTo(reliableSum, 6);
    expect(k201.total.grossProfit).not.toBeCloseTo(everyMonth, 6); // Jan–Mar and Aug+ really are excluded
    expect(k201.average.grossProfit).toBeCloseTo(reliableSum / k201.reliableCount, 6);
  });

  it('keeps the business Total equal to the sum of the apartment Totals', () => {
    // The property the table is read for: whatever each room excludes, the
    // roll-up must exclude the same money.
    const o = buildAnnualOverview(2026, reservations, costs, [issuedFor('K.102', '2026-06'), issuedFor('K.106', '2026-06')], THROUGH);
    const sumOfRooms = [...o.rows, ...(o.unallocated ? [o.unallocated] : [])]
      .reduce((sum, r) => sum + r.total.grossProfit, 0);
    expect(o.total.total.grossProfit).toBeCloseTo(sumOfRooms, 6);
  });

  it('still shows an excluded month\u2019s figures rather than hiding them', () => {
    const o = buildAnnualOverview(2026, reservations, costs, [], THROUGH);
    const jan = o.rows.find((r) => r.room === 'K.201')!.cells[0]!;
    expect(jan).not.toBeNull();      // rendered, greyed
    expect(jan.reliable).toBe(false); // but not counted
  });
});

describe('buildAnnualOverview', () => {
  const reservations = [
    res({ room: 'K.102', checkInDate: '2026-08-05', checkOutDate: '2026-08-10', price: 30_000 }),
    res({ room: 'O.308', checkInDate: '2026-07-05', checkOutDate: '2026-07-10', price: 50_000 }),
  ];

  const issued: CommissionSettlement = {
    id: 'settle-O.308-2026-07', unitId: 'O.308', room: 'O.308', ownerName: 'Stanislav Stefanic',
    mode: 'standalone', month: '2026-07', periodStart: '2026-07-01', periodEnd: '2026-07-31',
    gbv: 111_111, otaCommission: 0, paymentFees: 0, netSales: 111_111,
    cleaning: 0, laundry: 0, consumables: 0, subscriptions: 0, wearTear: 0, misc: 0, operationalCosts: 0,
    grossProfit: 111_111, commissionRate: 0.25, commissionAmount: 27_778, payableToOwner: 83_333,
    reconciles: true, status: 'issued', createdAt: '', createdBy: '',
  };

  it('covers every physical room, including the ones that never settle', () => {
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    expect(o.rows.map((r) => r.room)).toEqual(['K.102', 'K.103', 'K.106', 'K.201', 'K.202', 'K.203', 'O.308']);
    expect(o.rows.filter((r) => !r.commissionable).map((r) => r.room)).toEqual(['K.103', 'K.201', 'K.202', 'K.203']);
  });

  it('collapses to four P&L lines, deepest detail reachable by expanding', () => {
    // The operator's default view: Gross Booking Value, Net Sales, Operational
    // costs, Gross Profit — everything else hangs off one of them.
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    const tree = annualLineTree(o.rows.find((r) => r.room === 'K.102')!);
    expect(tree.map((n) => n.key)).toEqual(['gbv', 'netSales', 'operationalCosts', 'grossProfit']);
    expect(tree.map((n) => n.label)).toEqual([
      'Gross Booking Value', 'Net Sales', 'Operational costs', 'Gross Profit',
    ]);
    // Gross Booking Value owns the channel deductions between it and Net Sales.
    expect(tree[0].children?.map((n) => n.key)).toEqual(['otaCommission', 'paymentFees']);
    // Net Sales owns the operating costs between it and Operational costs.
    expect(tree[1].children?.map((n) => n.key)).toEqual([
      'cleaning', 'laundry', 'consumables', 'subscriptions', 'wearTear', 'misc',
    ]);
    // Subscriptions nests one level deeper still.
    expect(findLine(tree, 'subscriptions')?.children?.map((n) => n.label)).toEqual(['Internet + TV', 'Parking']);
    // The two summary lines carry no children of their own.
    expect(tree[2].children).toBeUndefined();
    expect(tree[3].children).toBeUndefined();
  });

  it('leaves management commission out of the annual view', () => {
    // Deliberate: this is a trading overview. The commission split belongs to
    // the monthly settlement statement, which still shows it.
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    for (const row of [o.total, ...o.rows]) {
      const keys = flattenLineTree(annualLineTree(row)).map(({ node }) => node.key);
      expect(keys).not.toContain('commissionAmount');
      expect(keys).not.toContain('payableToOwner');
    }
  });

  it('prefers an issued settlement over the live recomputation, and says so', () => {
    const o = buildAnnualOverview(2026, reservations, bundle(), [issued]);
    const o308 = o.rows.find((r) => r.room === 'O.308')!;
    const july = o308.cells[6]!;
    expect(july.source).toBe('issued');
    expect(july.netSales).toBe(111_111); // frozen figure, not the 50 000 booking
    expect(o308.issuedCount).toBe(1);
    // Everything else stays provisional.
    expect(o308.cells[7]!.source).toBe('computed');
  });

  it('adds up the room rows into the business total', () => {
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    const sumOfRooms = o.rows.reduce((s, r) => s + r.total.netSales, 0);
    expect(o.total.total.netSales).toBeCloseTo(sumOfRooms, 6);
    expect(o.total.total.grossProfit).toBeCloseTo(o.rows.reduce((s, r) => s + r.total.grossProfit, 0), 6);
  });

  it('averages every row over the same divisor, so room averages still add up', () => {
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    expect(o.activeMonths).toBeGreaterThan(0);
    expect(o.total.average.netSales).toBeCloseTo(o.total.total.netSales / o.activeMonths, 6);
    expect(o.rows.reduce((s, r) => s + r.average.grossProfit, 0)).toBeCloseTo(o.total.average.grossProfit, 6);
  });

  it('shows "—" rather than 0 for months the booking sync never loaded', () => {
    // Reservations only span Jul–Aug 2026, so 2025 is entirely uncoverable.
    const o = buildAnnualOverview(2025, reservations, bundle(), []);
    expect(o.rows.every((r) => r.cells.every((c) => c === null))).toBe(true);
    expect(o.uncoveredMonths).toHaveLength(12);
    expect(o.total.total.netSales).toBe(0);
  });

  it('still surfaces a month outside the booking window when a settlement was issued for it', () => {
    const old = { ...issued, id: 'settle-O.308-2025-03', month: '2025-03', periodStart: '2025-03-01', periodEnd: '2025-03-31' };
    const o = buildAnnualOverview(2025, reservations, bundle(), [old]);
    const march = o.rows.find((r) => r.room === 'O.308')!.cells[2]!;
    expect(march.source).toBe('issued');
    expect(march.payableToOwner).toBe(83_333);
    expect(o.uncoveredMonths).not.toContain('2025-03');
  });

  it('catches revenue on bookings not yet allocated to a physical unit', () => {
    // A booking still sitting on the virtual room type belongs to no room row —
    // without the catch-all it would silently vanish from the business total.
    const withVr = [...reservations, res({ room: '1KK Urban Studios', checkInDate: '2026-06-01', checkOutDate: '2026-06-04', price: 9_000 })];
    const o = buildAnnualOverview(2026, withVr, bundle(), [], '2026-07');
    expect(o.unallocated).not.toBeNull();
    expect(o.unallocated!.total.netSales).toBeCloseTo(9_000, 6);
    expect(o.total.total.netSales).toBeCloseTo(
      o.rows.reduce((s, r) => s + r.total.netSales, 0) + 9_000,
      6,
    );
  });

  it('keeps the catch-all row visible even when its revenue is in an unfinished month', () => {
    // The row exists so stray revenue can't disappear. A September booking does
    // not count towards the year yet, but it must still be on screen.
    const withVr = [...reservations, res({ room: '1KK Urban Studios', checkInDate: '2026-09-01', checkOutDate: '2026-09-04', price: 9_000 })];
    const o = buildAnnualOverview(2026, withVr, bundle(), [], '2026-07');
    expect(o.unallocated).not.toBeNull();
    expect(o.unallocated!.cells[8]!.netSales).toBeCloseTo(9_000, 6); // shown, greyed
    expect(o.unallocated!.total.netSales).toBe(0);                    // but not counted
  });

  it('leaves the catch-all row out entirely when every booking is allocated', () => {
    expect(buildAnnualOverview(2026, reservations, bundle(), []).unallocated).toBeNull();
  });
});

describe('annualLineTree', () => {
  const reservations = [res({ room: 'K.102', checkInDate: '2026-08-05', checkOutDate: '2026-08-10', price: 30_000 })];

  // Cost cells widen the coverage window, so the whole year is in scope here.
  const yearOfCosts = bundle({
    byDateRoom: {
      [`2026-01-04|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
      [`2026-12-28|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
    },
  });

  it('runs gross booking value down to gross profit, with parking on its own line', () => {
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, []);
    const tree = annualLineTree(o.rows.find((r) => r.room === 'K.102')!);
    const flat = flattenLineTree(tree);
    expect(flat[0].node.key).toBe('gbv');
    expect(flat[flat.length - 1].node.key).toBe('grossProfit');
    const parking = findByLabel(tree, 'Parking')!;
    expect(parking.kind).toBe('sub-item');
    // Parking starts 2026-08: nothing before, then every month, pool-split ÷3.
    expect(parking.values[6]).toBe(0);
    expect(parking.values[7]).toBeCloseTo(3025 / 3, 6);
    // K.102 is an "issued" room and nothing is issued here, so no month counts
    // towards the year — the monthly figures still show, the total stays empty.
    expect(parking.total).toBe(0);
  });

  it('totals the itemised lines over reliable months once settlements exist', () => {
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, [
      issuedFor('K.102', '2026-08'), issuedFor('K.102', '2026-09'),
    ]);
    const tree = annualLineTree(o.rows.find((r) => r.room === 'K.102')!);
    // The issued snapshots carry no itemisation, so their subscriptions land on
    // the remainder line — but Parking must still be listed, at zero, because
    // the greyed Aug–Dec months on screen do show a Parking figure.
    expect(findByLabel(tree, 'Parking')).toBeDefined();
    expect(findLine(tree, 'subscriptions')!.total).toBeCloseTo(2 * 3516 / 3, 6);
  });

  it('nests each line one level below its parent when flattened for the PDF', () => {
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, []);
    const flat = flattenLineTree(annualLineTree(o.rows.find((r) => r.room === 'K.102')!));
    const depthOf = (key: string) => flat.find(({ node }) => node.key === key)!.depth;
    expect(depthOf('gbv')).toBe(0);
    expect(depthOf('otaCommission')).toBe(1);
    expect(depthOf('subscriptions')).toBe(1);
    expect(flat.find(({ node }) => node.label === 'Parking')!.depth).toBe(2);
  });

  it('keeps showing a quiet month\u2019s costs instead of blanking it as "no data"', () => {
    // January has a cleaning cost but no booking. It is inside the loaded data
    // span, so it must report that cost rather than render "—".
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, []);
    const january = o.rows.find((r) => r.room === 'K.102')!.cells[0];
    expect(january).not.toBeNull();
    expect(january!.cleaning).toBeCloseTo(900 / 3, 6);
    expect(o.uncoveredMonths).toHaveLength(0);
  });

  it('keeps the itemised lines summing to the Subscriptions row', () => {
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, []);
    const subs = findLine(annualLineTree(o.total), 'subscriptions')!;
    expect(subs.children!.reduce((sum, l) => sum + l.total, 0)).toBeCloseTo(subs.total, 6);
  });

  it('books an old settlement’s un-itemised subscriptions to a remainder line', () => {
    // Settlements issued before itemisation existed carry only a lump total —
    // it must still appear, or the sub-lines would silently under-report.
    const legacy: CommissionSettlement = {
      id: 'settle-K.102-2026-06', unitId: 'K.102', room: 'K.102', ownerName: 'Stanislav Stefanic',
      mode: 'urban-pool', month: '2026-06', periodStart: '2026-06-01', periodEnd: '2026-06-30',
      gbv: 60_000, otaCommission: 0, paymentFees: 0, netSales: 60_000,
      cleaning: 0, laundry: 0, consumables: 0, subscriptions: 491, wearTear: 0, misc: 0, operationalCosts: 491,
      grossProfit: 59_509, commissionRate: 0.25, commissionAmount: 14_877, payableToOwner: 44_632,
      reconciles: true, status: 'issued', createdAt: '', createdBy: '',
    };
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, [legacy]);
    const subs = findLine(annualLineTree(o.rows.find((r) => r.room === 'K.102')!), 'subscriptions')!;
    const remainder = subs.children!.find((n) => n.key === `sub:${UNITEMISED_SUBSCRIPTION_ID}`)!;
    expect(remainder.values[5]).toBeCloseTo(491, 6); // June, the issued month
    expect(remainder.values[7]).toBe(0);             // August is itemised, nothing left over
    expect(subs.children!.reduce((sum, l) => sum + l.total, 0)).toBeCloseTo(subs.total, 6);
  });
});

describe('lastCompletedMonth', () => {
  it('is the month before the one we are standing in', () => {
    expect(lastCompletedMonth(new Date(2026, 7, 29))).toBe('2026-07'); // 29 Aug 2026
    expect(lastCompletedMonth(new Date(2026, 7, 1))).toBe('2026-07');  // 1 Aug, August not done
  });

  it('rolls back across the year boundary', () => {
    expect(lastCompletedMonth(new Date(2026, 0, 3))).toBe('2025-12');
  });
});

describe('availableYears', () => {
  it('always offers the current year, newest first', () => {
    expect(availableYears([], [], 2026)).toEqual([2026]);
  });

  it('includes years that only exist in settlement history', () => {
    const s = { month: '2024-11' } as CommissionSettlement;
    expect(availableYears([s], [], 2026)).toEqual([2026, 2024]);
  });

  it('includes every year the loaded bookings span', () => {
    const rs = [res({ room: 'K.102', checkInDate: '2025-12-28', checkOutDate: '2026-01-03' })];
    expect(availableYears([], rs, 2026)).toEqual([2026, 2025]);
  });
});
