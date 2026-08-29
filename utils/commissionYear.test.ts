import { describe, it, expect } from 'vitest';
import type { Reservation } from '@/types/reservation';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type { VariableCostBundle } from './commissionCalc';
import { computeSettlement } from './commissionCalc';
import { computeGrossProfit } from './grossProfit';
import { ANNUAL_UNITS, COMMISSION_UNITS, unitCommissionRate } from './commissionConfig';
import {
  buildAnnualOverview,
  annualLineSpecs,
  availableYears,
  UNITEMISED_SUBSCRIPTION_ID,
} from './commissionYear';

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

  it('labels the business total neutrally rather than as one unit\u2019s arrangement', () => {
    // The roll-up mixes 25% units with BHA-owned ones, so it must not claim
    // either — earlier it inherited "(none)" while carrying real commission.
    const o = buildAnnualOverview(2026, reservations, bundle(), []);
    expect(o.total.isAggregate).toBe(true);
    const specs = annualLineSpecs(o.total);
    expect(specs.find((s) => s.key === 'commissionAmount')!.label).toBe('BHA management commission');
    expect(specs.find((s) => s.key === 'payableToOwner')!.label).toBe('Payable to owners');
    // A real unit still states its own terms.
    const k102 = annualLineSpecs(o.rows.find((r) => r.room === 'K.102')!);
    expect(k102.find((s) => s.key === 'commissionAmount')!.label).toBe('BHA management commission (25%)');
    const k103 = annualLineSpecs(o.rows.find((r) => r.room === 'K.103')!);
    expect(k103.find((s) => s.key === 'payableToOwner')!.label).toBe('Payable to owner (BHA-owned)');
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
    const withVr = [...reservations, res({ room: '1KK Urban Studios', checkInDate: '2026-09-01', checkOutDate: '2026-09-04', price: 9_000 })];
    const o = buildAnnualOverview(2026, withVr, bundle(), []);
    expect(o.unallocated).not.toBeNull();
    expect(o.unallocated!.total.netSales).toBeCloseTo(9_000, 6);
    expect(o.total.total.netSales).toBeCloseTo(
      o.rows.reduce((s, r) => s + r.total.netSales, 0) + 9_000,
      6,
    );
  });

  it('leaves the catch-all row out entirely when every booking is allocated', () => {
    expect(buildAnnualOverview(2026, reservations, bundle(), []).unallocated).toBeNull();
  });
});

describe('annualLineSpecs', () => {
  const reservations = [res({ room: 'K.102', checkInDate: '2026-08-05', checkOutDate: '2026-08-10', price: 30_000 })];

  // Cost cells widen the coverage window, so the whole year is in scope here.
  const yearOfCosts = bundle({
    byDateRoom: {
      [`2026-01-04|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
      [`2026-12-28|${K102}`]: { cleaning: 900, laundry: 0, consumables: 0, wearTear: 0, misc: 0 },
    },
  });

  it('runs gross booking value down to the owner payout, with parking on its own line', () => {
    const o = buildAnnualOverview(2026, reservations, yearOfCosts, []);
    const specs = annualLineSpecs(o.rows.find((r) => r.room === 'K.102')!);
    expect(specs[0].key).toBe('gbv');
    expect(specs[specs.length - 1].key).toBe('payableToOwner');
    const parking = specs.find((s) => s.label === 'Parking')!;
    expect(parking.kind).toBe('sub-item');
    // Parking starts 2026-08: nothing before, then every month, pool-split ÷3.
    expect(parking.values[6]).toBe(0);
    expect(parking.values[7]).toBeCloseTo(3025 / 3, 6);
    expect(parking.total).toBeCloseTo((3025 / 3) * 5, 6); // Aug–Dec
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
    const specs = annualLineSpecs(o.total);
    const subs = specs.find((s) => s.key === 'subscriptions')!;
    const items = specs.filter((s) => s.kind === 'sub-item');
    expect(items.reduce((s, l) => s + l.total, 0)).toBeCloseTo(subs.total, 6);
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
    const row = o.rows.find((r) => r.room === 'K.102')!;
    const specs = annualLineSpecs(row);
    const remainder = specs.find((s) => s.key === `sub:${UNITEMISED_SUBSCRIPTION_ID}`)!;
    expect(remainder.values[5]).toBeCloseTo(491, 6); // June, the issued month
    expect(remainder.values[7]).toBe(0);             // August is itemised, nothing left over
    const subs = specs.find((s) => s.key === 'subscriptions')!;
    expect(specs.filter((s) => s.kind === 'sub-item').reduce((s, l) => s + l.total, 0)).toBeCloseTo(subs.total, 6);
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
