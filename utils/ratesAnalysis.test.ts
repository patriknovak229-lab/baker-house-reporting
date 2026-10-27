import { describe, expect, it } from 'vitest';
import {
  buildRatesResponse,
  classOfRoom,
  MIN_MATCHED_DATES,
  type RateBookingInput,
  type RateNightInput,
  type RatesInput,
} from './ratesAnalysis';

const LEAD = [
  { label: '0–14 days', min: 0, max: 14 },
  { label: '15+ days', min: 15, max: null },
];
const LOS = [
  { label: '1 night', min: 1, max: 1 },
  { label: '2+ nights', min: 2, max: null },
];

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

let seq = 0;
/** A booking plus its nights, the way the data-access layer would hand them over. */
function stay(opts: {
  room: string;
  checkIn: string;
  nights: number;
  perNight: number;
  channel?: string;
  line?: string;
  commissionRate?: number;
  bookedAt?: string;
  cancelledAt?: string;
  rateType?: string | null;
}): { booking: RateBookingInput; nights: RateNightInput[] } {
  seq += 1;
  const res = `BH-${seq}`;
  const channel = opts.channel ?? 'Booking.com';
  const cancelled = !!opts.cancelledAt;
  const price = cancelled ? 0 : opts.perNight * opts.nights;
  const commission = price * (opts.commissionRate ?? (channel === 'Booking.com' ? 0.17 : 0));
  const booking: RateBookingInput = {
    reservationNumber: res,
    source: 'beds24-booking',
    channel,
    room: opts.room,
    rateType: opts.rateType ?? null,
    rateLine: opts.line ?? '',
    originalNightly: cancelled ? opts.perNight : null,
    checkIn: opts.checkIn,
    checkOut: addDays(opts.checkIn, opts.nights),
    spanNights: opts.nights,
    reservationDate: (opts.bookedAt ?? `${addDays(opts.checkIn, -10)}T10:00:00Z`).slice(0, 10),
    bookedAt: opts.bookedAt ?? `${addDays(opts.checkIn, -10)}T10:00:00Z`,
    cancelledAt: opts.cancelledAt ?? null,
    isCancelled: cancelled,
    cancelClass: cancelled ? 'guest' : null,
    price,
    commission,
    fee: 0,
  };
  const nights: RateNightInput[] = cancelled
    ? []
    : Array.from({ length: opts.nights }, (_, i) => ({
        reservationNumber: res,
        room: opts.room,
        channel,
        stayDate: addDays(opts.checkIn, i),
        price: opts.perNight,
        commission: commission / opts.nights,
        fee: 0,
      }));
  return { booking, nights };
}

function build(
  stays: { booking: RateBookingInput; nights: RateNightInput[] }[],
  extra: Partial<RatesInput> = {},
) {
  const from = extra.from ?? '2026-06-01';
  const to = extra.to ?? '2026-06-30';
  const rooms = ['K.102', 'K.103', 'K.106', 'K.202', 'K.203', 'K.201', 'O.308'];
  const available: { room: string; stayDate: string }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) for (const room of rooms) available.push({ room, stayDate: d });
  return buildRatesResponse({
    from,
    to,
    today: '2026-07-15',
    rooms: [],
    channels: [],
    query: { from, to, rooms: [], channels: [] },
    nights: stays.flatMap((s) => s.nights),
    bookings: stays.map((s) => s.booking),
    available,
    turnoverByCheckout: null,
    leadBuckets: LEAD,
    losBuckets: LOS,
    farOut: { nearDays: 7, farDays: 30, premium: 0.15 },
    ...extra,
  });
}

const NR = (d: string) => `${d} (60681829 Non-refundable Rate-One-Bedroom Apartment-1541267401) CZK 2000 genius`;
const STD = (d: string) => `${d} (60681828 Standard Rate) CZK 2300 genius`;

describe('room classes', () => {
  it('puts studios in 1KK, the two-bedroom apartments in 2KK, and unallocated studio labels with the studios', () => {
    expect(classOfRoom('K.102')).toBe('1kk');
    expect(classOfRoom('K.203')).toBe('1kk');
    expect(classOfRoom('K.201')).toBe('2kk');
    expect(classOfRoom('O.308')).toBe('2kk');
    expect(classOfRoom('1KK Urban Studios')).toBe('1kk');
    expect(classOfRoom('Somewhere else')).toBeNull();
  });

  it('returns 1KK, 2KK and the blend, each with its own nights', () => {
    const r = build([
      stay({ room: 'K.102', checkIn: '2026-06-02', nights: 2, perNight: 2000 }),
      stay({ room: 'K.201', checkIn: '2026-06-02', nights: 3, perNight: 4000 }),
    ]);
    expect(r.classes.map((c) => c.classId)).toEqual(['1kk', '2kk', 'all']);
    expect(r.classes.map((c) => c.totals.nights)).toEqual([2, 3, 5]);
    expect(r.classes[1].totals.adr).toBe(4000);
  });
});

describe('gross profit', () => {
  it('takes commission, fees and the stay’s turnover (spread over its nights) off gross', () => {
    const s = stay({ room: 'K.102', checkIn: '2026-06-02', nights: 2, perNight: 2000, commissionRate: 0.2 });
    const r = build([s], { turnoverByCheckout: new Map([[`2026-06-04|K.102`, 800]]) });
    const t = r.classes[0].totals;
    expect(t.gbv).toBe(4000);
    expect(t.netSales).toBeCloseTo(3200, 6);
    expect(t.grossProfit).toBeCloseTo(2400, 6);
    expect(t.gpPerNight).toBeCloseTo(1200, 6);
    expect(r.costCoverage).toMatchObject({ actual: 1, estimated: 0 });
  });

  it('costs a stay with no logged cleaning at its unit’s average, and says so', () => {
    const logged = stay({ room: 'K.102', checkIn: '2026-06-02', nights: 2, perNight: 2000 });
    const future = stay({ room: 'K.103', checkIn: '2026-06-20', nights: 2, perNight: 2000 });
    const r = build([logged, future], { turnoverByCheckout: new Map([[`2026-06-04|K.102`, 900]]) });
    expect(r.costCoverage).toMatchObject({ actual: 1, estimated: 1 });
    expect(r.classes[0].totals.turnoverCost).toBeCloseTo(1800, 6);
  });
});

describe('rate plans', () => {
  it('prices a plan against Non-refundable on the same unit and night, by median', () => {
    const stays = [];
    for (let i = 0; i < MIN_MATCHED_DATES; i++) {
      const d = addDays('2026-06-01', i * 2);
      stays.push(stay({ room: 'K.102', checkIn: d, nights: 1, perNight: 2000, line: NR(d) }));
      stays.push(stay({ room: 'K.103', checkIn: d, nights: 1, perNight: 2300, line: STD(d) }));
    }
    // One absurd Standard night must not move the median.
    stays.push(stay({ room: 'K.106', checkIn: '2026-06-01', nights: 1, perNight: 23000, line: STD('2026-06-01') }));
    const view = build(stays).classes[0];
    const std = view.plans.find((p) => p.plan === 'Standard')!;
    expect(std.vsNonRefundable?.comparable).toBe(true);
    expect(std.vsNonRefundable?.grain).toBe('date');
    expect(std.vsNonRefundable?.adrDelta).toBeCloseTo(0.15, 6);
  });

  it('withholds the comparison below the matched-night floor', () => {
    const d = '2026-06-03';
    const view = build([
      stay({ room: 'K.102', checkIn: d, nights: 1, perNight: 2000, line: NR(d) }),
      stay({ room: 'K.103', checkIn: d, nights: 1, perNight: 2300, line: STD(d) }),
    ]).classes[0];
    const cmp = view.plans.find((p) => p.plan === 'Standard')!.vsNonRefundable!;
    expect(cmp.comparable).toBe(false);
    expect(cmp.matchedDates).toBe(1);
    expect(cmp.adrDelta).toBeNull();
  });

  it('matches single-room 2KK units within the same week when no night can be shared', () => {
    const stays = [];
    // 12 weeks; K.201 sells Non-ref on Monday and Standard on Tuesday of each.
    for (let w = 0; w < 12; w++) {
      const mon = addDays('2026-06-01', w * 7);
      const tue = addDays(mon, 1);
      stays.push(stay({ room: 'K.201', checkIn: mon, nights: 1, perNight: 4000, line: NR(mon) }));
      stays.push(stay({ room: 'K.201', checkIn: tue, nights: 1, perNight: 4400, line: STD(tue) }));
    }
    const view = build(stays, { to: '2026-08-31' }).classes[1];
    const cmp = view.plans.find((p) => p.plan === 'Standard')!.vsNonRefundable!;
    expect(cmp.grain).toBe('week');
    expect(cmp.comparable).toBe(true);
    expect(cmp.adrDelta).toBeCloseTo(0.1, 6);
  });

  it('learns a nameless line’s plan from its rate id elsewhere in the archive', () => {
    const named = stay({
      room: 'K.102',
      checkIn: '2026-05-01',
      nights: 7,
      perNight: 1800,
      line: '2026-05-01 (65571709 Weekly rate Urban rewritten from  Early Booker Deal) CZK 1800 genius',
    });
    const nameless = stay({
      room: 'K.103',
      checkIn: '2026-06-05',
      nights: 7,
      perNight: 1800,
      line: '2026-06-05 (65571709 rewritten from  Early Booker Deal) CZK 1800 genius',
    });
    const view = build([named, nameless]).classes[0];
    expect(view.plans.map((p) => p.plan)).toEqual(['Weekly']);
    expect(view.promos[0].promo).toBe('Early Booker Deal');
  });
});

describe('cancellation resale', () => {
  it('counts a cancelled night as resold only when the unit ran out of rooms afterwards', () => {
    // O.308 is one room: Standard booking cancels, a later booking takes the night.
    const cancelled = stay({
      room: 'O.308',
      checkIn: '2026-06-10',
      nights: 2,
      perNight: 4000,
      line: STD('2026-06-10'),
      bookedAt: '2026-05-01T10:00:00Z',
      cancelledAt: '2026-06-01T10:00:00Z',
    });
    const resale = stay({
      room: 'O.308',
      checkIn: '2026-06-10',
      nights: 1,
      perNight: 3600,
      line: NR('2026-06-10'),
      bookedAt: '2026-06-05T10:00:00Z',
    });
    const view = build([cancelled, resale]).classes[1];
    expect(view.resaleTotal.cancelledNights).toBe(2);
    expect(view.resaleTotal.resoldNights).toBe(1);
    expect(view.resaleTotal.priceRatio).toBeCloseTo(0.9, 6);
    expect(view.resaleTotal.avgDaysToResell).toBe(4);
    const std = view.plans.find((p) => p.plan === 'Standard')!;
    expect(std.cancelledNights).toBe(2);
    expect(std.resoldNights).toBe(1);
  });

  it('does not credit a resale while the unit still had empty rooms', () => {
    // Urban has three rooms; one cancels, one later booking arrives — two rooms
    // stayed empty, so the later guest had room anyway.
    const cancelled = stay({
      room: 'K.102',
      checkIn: '2026-06-10',
      nights: 1,
      perNight: 2000,
      line: STD('2026-06-10'),
      cancelledAt: '2026-06-01T10:00:00Z',
      bookedAt: '2026-05-01T10:00:00Z',
    });
    const later = stay({ room: 'K.103', checkIn: '2026-06-10', nights: 1, perNight: 2000, bookedAt: '2026-06-05T10:00:00Z' });
    const view = build([cancelled, later]).classes[0];
    expect(view.resaleTotal.cancelledNights).toBe(1);
    expect(view.resaleTotal.resoldNights).toBe(0);
  });

  it('credits the resale to the unit, not the room, when the studios filled up', () => {
    const cancelled = stay({
      room: 'K.102',
      checkIn: '2026-06-10',
      nights: 1,
      perNight: 2000,
      cancelledAt: '2026-06-01T10:00:00Z',
      bookedAt: '2026-05-01T10:00:00Z',
    });
    const before = [
      stay({ room: 'K.103', checkIn: '2026-06-10', nights: 1, perNight: 2000, bookedAt: '2026-05-02T10:00:00Z' }),
      stay({ room: 'K.106', checkIn: '2026-06-10', nights: 1, perNight: 2000, bookedAt: '2026-05-03T10:00:00Z' }),
    ];
    // Lands in K.106's sibling slot after Beds24 reshuffles — still the same unit.
    const after = stay({ room: 'K.102', checkIn: '2026-06-10', nights: 1, perNight: 2200, bookedAt: '2026-06-03T10:00:00Z' });
    const view = build([cancelled, ...before, after]).classes[0];
    expect(view.resaleTotal.resoldNights).toBe(1);
    expect(view.resaleByUnit[0].label).toBe('Urban 1KK');
    expect(view.resaleTotal.priceRatio).toBeCloseTo(1.1, 6);
  });

  it('leaves future cancelled nights open rather than unsold', () => {
    const cancelled = stay({
      room: 'K.201',
      checkIn: '2026-07-20',
      nights: 3,
      perNight: 4000,
      cancelledAt: '2026-07-01T10:00:00Z',
      bookedAt: '2026-06-01T10:00:00Z',
    });
    const view = build([cancelled], { from: '2026-07-01', to: '2026-07-31' }).classes[1];
    expect(view.resaleTotal.cancelledNights).toBe(0);
    expect(view.resaleTotal.openNights).toBe(3);
  });
});

describe('direct pricing', () => {
  it('reports how far below Booking.com direct sells, and what it nets', () => {
    const stays = [];
    for (let i = 0; i < MIN_MATCHED_DATES; i++) {
      const d = addDays('2026-06-01', i * 2);
      stays.push(stay({ room: 'K.102', checkIn: d, nights: 1, perNight: 2000, channel: 'Booking.com', commissionRate: 0.17 }));
      stays.push(stay({ room: 'K.103', checkIn: d, nights: 1, perNight: 1800, channel: 'Direct-Web' }));
    }
    const view = build(stays).classes[0];
    const d = view.directPricing.find((x) => x.channel === 'Direct-Web')!;
    expect(d.sameDateGrossDelta).toBeCloseTo(-0.1, 6);
    expect(d.sameDateNetDelta).toBeCloseTo(1800 / 1660 - 1, 6);
    expect(d.breakEvenDiscount).toBeCloseTo(0.17, 6);
    expect(d.verdict).toBe('keeping-margin');
  });
});
