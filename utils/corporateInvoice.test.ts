import { describe, expect, it } from 'vitest';
import {
  buildInvoiceLines,
  corporateInvoiceNumber,
  dayOfMonth,
  dueDateFor,
  issueDateFor,
  lastDayOfMonth,
  missingBillingDetails,
  monthsWithNights,
  needsPaymentCheck,
  overlappingInvoice,
  parseDueRule,
  perNightAmounts,
  shiftMonth,
  variableSymbol,
  type InvoiceSourceStay,
} from './corporateInvoice';

const stay = (over: Partial<InvoiceSourceStay>): InvoiceSourceStay => ({
  stayId: 'CS-x-001',
  seq: 1,
  reservationNumber: 'BH-1',
  roomId: 679714,
  guestName: '',
  arrival: '2026-12-09',
  departure: '2026-12-18',
  priceCzk: 16321,
  source: 'agreement',
  ...over,
});

// A long corporate stay with a room change: 9 nights in one room, then 73 in another.
const LONG_STAY = [
  stay({}),
  stay({ stayId: 'CS-x-002', seq: 2, reservationNumber: 'BH-2', roomId: 648816, arrival: '2026-12-18', departure: '2027-03-01', priceCzk: 143485 }),
];

describe('month helpers', () => {
  it('shifts across years both ways', () => {
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2027-01', -1)).toBe('2026-12');
    expect(shiftMonth('2026-11', 14)).toBe('2028-01');
  });
  it('knows month lengths', () => {
    expect(lastDayOfMonth('2027-02')).toBe('2027-02-28');
    expect(lastDayOfMonth('2028-02')).toBe('2028-02-29');
    expect(dayOfMonth('2027-02', 31)).toBe('2027-02-28');
    expect(dayOfMonth('2026-12', 15)).toBe('2026-12-15');
  });
  it('lists the months a set of stays sleeps in', () => {
    expect(monthsWithNights(LONG_STAY)).toEqual(['2026-12', '2027-01', '2027-02']);
    // Checkout on the 1st adds no night to that month.
    expect(monthsWithNights([{ arrival: '2026-12-30', departure: '2027-01-01' }])).toEqual(['2026-12']);
  });
});

describe('perNightAmounts', () => {
  it('spreads a price over nights in whole crowns, summing exactly', () => {
    const n = perNightAmounts(143485, 73);
    expect(n).toHaveLength(73);
    expect(n.reduce((a, b) => a + b, 0)).toBe(143485);
    expect(n.every((x) => Number.isInteger(x) && (x === 1965 || x === 1966))).toBe(true);
  });
  it('handles zero nights and zero price', () => {
    expect(perNightAmounts(1000, 0)).toEqual([]);
    expect(perNightAmounts(0, 3)).toEqual([0, 0, 0]);
  });
});

describe('buildInvoiceLines', () => {
  it('splits LONG_STAY into months that add back to the agreement total', () => {
    const dec = buildInvoiceLines(LONG_STAY, '2026-12-01', '2026-12-31');
    const jan = buildInvoiceLines(LONG_STAY, '2027-01-01', '2027-01-31');
    const feb = buildInvoiceLines(LONG_STAY, '2027-02-01', '2027-02-28');
    expect(dec.lines.map((l) => [l.seq, l.nights])).toEqual([[1, 9], [2, 14]]);
    expect(dec.lines[0].amountCzk).toBe(16321);
    expect(dec.lines[1].until).toBe('2027-01-01');
    expect(jan.nights).toBe(31);
    expect(feb.nights).toBe(28);
    expect(dec.totalCzk + jan.totalCzk + feb.totalCzk).toBe(16321 + 143485);
    expect(dec.lines[1].amountCzk + jan.totalCzk + feb.totalCzk).toBe(143485);
  });
  it('an ad hoc range over everything bills each stay in full', () => {
    const all = buildInvoiceLines(LONG_STAY, '2026-12-09', '2027-02-28');
    expect(all.lines.map((l) => l.amountCzk)).toEqual([16321, 143485]);
    expect(all.nights).toBe(82);
  });
  it('a range with no nights of a stay leaves it off', () => {
    expect(buildInvoiceLines(LONG_STAY, '2027-03-01', '2027-03-31').lines).toEqual([]);
  });
});

describe('issueDateFor', () => {
  const today = '2026-11-25';
  it('places the issue date relative to the billed month, never in the past', () => {
    expect(issueDateFor({ kind: 'before_month', days: 14 }, '2027-01', today)).toBe('2026-12-18');
    expect(issueDateFor({ kind: 'before_month', days: 14 }, '2026-12', today)).toBe(today); // 17 Nov is past
    expect(issueDateFor({ kind: 'month_start' }, '2027-02', today)).toBe('2027-02-01');
    expect(issueDateFor({ kind: 'month_end' }, '2027-02', today)).toBe('2027-02-28');
    expect(issueDateFor({ kind: 'after_month' }, '2026-12', today)).toBe('2027-01-01');
  });
});

describe('dueDateFor', () => {
  it('days after issue', () => {
    expect(dueDateFor({ kind: 'days_after_issue', days: 14 }, '2026-12', '2026-11-25')).toBe('2026-12-09');
  });
  it('end of the previous month (paid in advance)', () => {
    expect(dueDateFor({ kind: 'day_of_month', day: 31, monthOffset: -1 }, '2026-12', '2026-11-25')).toBe('2026-11-30');
  });
  it('a fixed day of the billed month', () => {
    expect(dueDateFor({ kind: 'day_of_month', day: 15, monthOffset: 0 }, '2027-01', '2026-12-18')).toBe('2027-01-15');
  });
  it('the last day clamps to short months', () => {
    expect(dueDateFor({ kind: 'day_of_month', day: 31, monthOffset: 0 }, '2027-02', '2027-02-01')).toBe('2027-02-28');
  });
  it('the following month crosses the year', () => {
    expect(dueDateFor({ kind: 'day_of_month', day: 15, monthOffset: 1 }, '2026-12', '2027-01-01')).toBe('2027-01-15');
  });
  it('does not clamp a due date that falls before the issue date', () => {
    expect(dueDateFor({ kind: 'day_of_month', day: 31, monthOffset: -1 }, '2026-12', '2026-12-05')).toBe('2026-11-30');
  });
});

describe('parseDueRule', () => {
  it('accepts the two shapes and rejects junk', () => {
    expect(parseDueRule({ kind: 'days_after_issue', days: 14 })).toEqual({ kind: 'days_after_issue', days: 14 });
    expect(parseDueRule({ kind: 'day_of_month', day: 31, monthOffset: -1 })).toEqual({ kind: 'day_of_month', day: 31, monthOffset: -1 });
    expect(parseDueRule({ kind: 'day_of_month', day: 32, monthOffset: 0 })).toBeNull();
    expect(parseDueRule({ kind: 'day_of_month', day: 5, monthOffset: 2 })).toBeNull();
    expect(parseDueRule('14')).toBeNull();
  });
});

describe('numbering', () => {
  it('pads the yearly sequence and yields a 7-digit variable symbol', () => {
    expect(corporateInvoiceNumber(2026, 1)).toBe('INV-C2026-001');
    expect(variableSymbol('INV-C2026-001')).toBe('2026001');
    expect(variableSymbol(corporateInvoiceNumber(2026, 1)).length).toBeLessThan(8);
  });
});

describe('overlap + payment checks', () => {
  const existing = [
    { status: 'sent' as const, periodFrom: '2026-12-01', periodTo: '2026-12-31' },
    { status: 'void' as const, periodFrom: '2027-01-01', periodTo: '2027-01-31' },
  ];
  it('finds a live invoice that already bills a night, ignoring void ones', () => {
    expect(overlappingInvoice(existing, '2026-12-31', '2027-01-05')?.periodFrom).toBe('2026-12-01');
    expect(overlappingInvoice(existing, '2027-01-01', '2027-01-31')).toBeNull();
  });
  it('shows a payment check from the day after the due date', () => {
    const inv = { status: 'sent' as const, dueDate: '2026-12-09', paymentCheckSnoozedUntil: null };
    expect(needsPaymentCheck(inv, '2026-12-09')).toBe(false);
    expect(needsPaymentCheck(inv, '2026-12-10')).toBe(true);
    expect(needsPaymentCheck({ ...inv, status: 'paid' }, '2026-12-20')).toBe(false);
    expect(needsPaymentCheck({ ...inv, paymentCheckSnoozedUntil: '2026-12-13' }, '2026-12-11')).toBe(false);
    expect(needsPaymentCheck({ ...inv, paymentCheckSnoozedUntil: '2026-12-13' }, '2026-12-13')).toBe(true);
  });
});

describe('missingBillingDetails', () => {
  it('needs name, address, an identifier and a valid email', () => {
    expect(
      missingBillingDetails({ companyName: 'Acme s.r.o.', companyAddress: 'Praha 1', ico: '12345678', vatNumber: null, billingEmail: 'billing@example.com' }),
    ).toEqual([]);
    expect(missingBillingDetails({ companyName: 'X', companyAddress: '', ico: '', vatNumber: '', billingEmail: 'nope' })).toEqual([
      'address',
      'IČO or DIČ',
      'invoice email',
    ]);
  });
});
