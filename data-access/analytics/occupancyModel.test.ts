import { describe, it, expect } from 'vitest';
import type { RoomClass } from '@/data/analyticsConfig';
import { buildOccupancyModel, type ModelNight, type OccupancyModelInput } from './occupancyModel';

// A ten-night window, two studios and one apartment:
//   K.102 — one 7-night stay, 1→8 Mar, 1 000/night, 10 % commission, one 700 turnover
//   K.103 — two 3-night stays, 1→4 and 4→7 Mar, 300 turnover each, a 100 wear & tear
//           incident on 5 Mar and a 200 manual cleaning on 9 Mar (no checkout)
//   K.201 — one 2-night stay, 2→4 Mar
//   plus one unallocated "1KK Urban Studios" night on 9 Mar.

const CLASSES: RoomClass[] = [
  { id: '1kk', label: '1KK', description: 'Studios', rooms: ['K.102', 'K.103'], virtualRoomLabels: ['1KK Urban Studios'] },
  { id: '2kk', label: '2KK', description: 'Apartments', rooms: ['K.201'], virtualRoomLabels: [] },
];

function dates(from: string, nights: number): string[] {
  return Array.from({ length: nights }, (_, i) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function stay(
  reservation: string,
  room: string,
  checkIn: string,
  span: number,
  perNight: number,
  commissionRate = 0,
): ModelNight[] {
  const checkOut = dates(checkIn, span + 1)[span];
  return dates(checkIn, span).map((date) => ({
    room,
    stayRoom: room,
    date,
    reservation,
    channel: 'Booking.com',
    checkIn,
    checkOut,
    span,
    gross: perNight,
    commission: perNight * commissionRate,
    fee: 0,
  }));
}

function baseInput(overrides: Partial<OccupancyModelInput> = {}): OccupancyModelInput {
  const window = dates('2026-03-01', 10);
  return {
    from: '2026-03-01',
    to: '2026-03-10',
    today: '2026-03-20',
    classes: CLASSES,
    available: ['K.102', 'K.103', 'K.201'].flatMap((room) => window.map((date) => ({ room, date }))),
    nights: [
      ...stay('BH-LONG', 'K.102', '2026-03-01', 7, 1000, 0.1),
      ...stay('BH-S1', 'K.103', '2026-03-01', 3, 1000),
      ...stay('BH-S2', 'K.103', '2026-03-04', 3, 1200),
      ...stay('BH-APT', 'K.201', '2026-03-02', 2, 3000),
      ...stay('BH-VR', '1KK Urban Studios', '2026-03-09', 1, 1000),
    ],
    costCells: [
      { date: '2026-03-08', room: 'K.102', turnover: 700, incidents: 0 },
      { date: '2026-03-04', room: 'K.103', turnover: 300, incidents: 0 },
      { date: '2026-03-07', room: 'K.103', turnover: 300, incidents: 0 },
      { date: '2026-03-05', room: 'K.103', turnover: 0, incidents: 100 },
      { date: '2026-03-09', room: 'K.103', turnover: 200, incidents: 0 },
    ],
    checkoutKeys: new Set(['2026-03-08|K.102', '2026-03-04|K.103', '2026-03-07|K.103', '2026-03-04|K.201']),
    subscriptionsByRoomMonth: new Map([['K.102|2026-03', 3100]]),
    listings: [
      { listingId: 'L-1KK', rooms: ['K.102', 'K.103'] },
      { listingId: 'L-2KK', rooms: ['K.201'] },
    ],
    marketMonthly: [
      { listingId: 'L-1KK', month: '2026-03', occupancy: 0.5, adr: 900 },
      { listingId: 'L-2KK', month: '2026-03', occupancy: 0.25, adr: 2500 },
    ],
    forward: { available: [], nights: [], horizons: [], market: [] },
    longStayMinNights: 7,
    ...overrides,
  };
}

describe('buildOccupancyModel', () => {
  const model = buildOccupancyModel(baseInput());
  const kk1 = model.scorecard.find((s) => s.classId === '1kk')!;
  const kk2 = model.scorecard.find((s) => s.classId === '2kk')!;

  it('counts room-nights, not dates — and an unallocated studio night counts for the class', () => {
    expect(kk1.slice.availableNights).toBe(20);
    expect(kk1.slice.soldNights).toBe(7 + 6 + 1);
    expect(kk1.slice.occupancy).toBeCloseTo(0.7);
    expect(kk2.slice.soldNights).toBe(2);
    const all = model.scorecard.find((s) => s.classId === 'all')!;
    expect(all.slice.availableNights).toBe(30);
    expect(model.notes.join(' ')).toMatch(/1 studio night/);
  });

  it('spreads a checkout turnover over the stay and keeps loose costs on their date', () => {
    const k102 = model.roomMonths.find((r) => r.room === 'K.102')!;
    // 7 000 gross − 700 commission − 700 turnover
    expect(k102.slice.profit!.grossProfit).toBeCloseTo(5600);
    const k103 = model.roomMonths.find((r) => r.room === 'K.103')!;
    // 6 600 net − 2×300 turnover − 100 incident − 200 manual cleaning
    expect(k103.slice.profit!.grossProfit).toBeCloseTo(6600 - 600 - 100 - 200);
    expect(k103.slice.profit!.perAvailableNight).toBeCloseTo(5700 / 10);
  });

  it('weights market occupancy by our nights on sale and forms MPI from it', () => {
    expect(kk1.market.occupancy).toBeCloseTo(0.5);
    expect(kk1.market.mpi).toBeCloseTo(0.7 / 0.5);
    const all = model.scorecard.find((s) => s.classId === 'all')!;
    // 20 studio nights at 0.5, 10 apartment nights at 0.25
    expect(all.market.occupancy).toBeCloseTo((20 * 0.5 + 10 * 0.25) / 30);
  });

  it('withholds the market comparison when most of the window has no market figure', () => {
    // Window runs into April, which the snapshot has no month for.
    const april = dates('2026-04-01', 30);
    const forward = buildOccupancyModel(
      baseInput({
        to: '2026-04-30',
        available: ['K.102', 'K.103', 'K.201'].flatMap((room) =>
          [...dates('2026-03-01', 10), ...april].map((date) => ({ room, date })),
        ),
      }),
    );
    expect(forward.scorecard.every((s) => s.market.occupancy === null && s.market.mpi === null)).toBe(true);
    const march = forward.monthly.find((m) => m.classId === '1kk')!.points.find((p) => p.month === '2026-03')!;
    expect(march.market.mpi).toBeCloseTo(0.7 / 0.5);
  });

  it('pro-rates subscriptions by day over the costed nights only', () => {
    expect(kk1.subscriptions).toBeCloseTo((3100 / 31) * 10);
    expect(kk1.grossProfitAfterSubscriptions).toBeCloseTo(kk1.slice.profit!.grossProfit - 1000);
  });

  it('finds sold-out dates per class and the longest consecutive run', () => {
    const so = model.soldOut.find((s) => s.classId === '1kk')!;
    // 1–6 Mar both studios sold; 7 Mar K.103 is free; 9 Mar only the VR night.
    expect(so.soldOutDates).toBe(6);
    expect(so.dates).toBe(10);
    expect(so.longestRun).toBe(6);
    const apt = model.soldOut.find((s) => s.classId === '2kk')!;
    expect(apt.soldOutDates).toBe(2);
  });

  it('compares a long stay with the sibling room over exactly the same nights', () => {
    expect(model.longStayDuels).toHaveLength(1);
    const duel = model.longStayDuels[0];
    expect(duel.reservationNumber).toBe('BH-LONG');
    expect(duel.nights).toBe(7);
    expect(duel.siblings.rooms).toEqual(['K.103']);
    expect(duel.profitPerNight).toBeCloseTo(5600 / 7);
    // K.103 over 1–7 Mar: 6 600 net, 600 turnover, 100 incident, 7 nights on sale
    expect(duel.siblings.occupancy).toBeCloseTo(6 / 7);
    expect(duel.siblings.profitPerAvailableNight).toBeCloseTo((6600 - 700) / 7);
    expect(duel.deltaPerNight).toBeCloseTo(800 - 5900 / 7);
    const summary = model.longStaySummary.find((s) => s.classId === '1kk')!;
    expect(summary.duels).toBe(1);
    expect(summary.won).toBe(0);
  });

  it('puts per-night economics in stay-length buckets', () => {
    const buckets = model.losEconomics.find((l) => l.classId === '1kk')!.buckets;
    const week = buckets.find((b) => b.label === '7–13 nights')!;
    expect(week.nights).toBe(7);
    expect(week.netAdr).toBeCloseTo(900);
    expect(week.turnoverCostPerNight).toBeCloseTo(100);
    expect(week.profitPerNight).toBeCloseTo(800);
  });

  it('withholds gross profit for nights before cost logging began or not yet slept', () => {
    const early = buildOccupancyModel(
      baseInput({
        costCells: [{ date: '2026-04-02', room: 'K.102', turnover: 1, incidents: 0 }],
      }),
    );
    expect(early.profitCoverage.costsFrom).toBe('2026-04-01');
    expect(early.scorecard.every((s) => s.slice.profit === null)).toBe(true);
    expect(early.longStayDuels).toHaveLength(0);

    const future = buildOccupancyModel(baseInput({ today: '2026-03-05' }));
    const k102 = future.roomMonths.find((r) => r.room === 'K.102')!;
    expect(k102.slice.profit!.soldNights).toBe(4);
    expect(k102.slice.soldNights).toBe(7);
  });

  it('hides gross profit entirely when costs are unavailable', () => {
    const none = buildOccupancyModel(baseInput({ costCells: null, subscriptionsByRoomMonth: null }));
    expect(none.profitCoverage.costsAvailable).toBe(false);
    expect(none.scorecard.every((s) => s.slice.profit === null && s.subscriptions === null)).toBe(true);
  });
});
