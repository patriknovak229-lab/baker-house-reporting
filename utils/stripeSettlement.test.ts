import { describe, expect, it } from 'vitest';
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { SettlementGroup } from '@/types/settlementGroup';
import {
  applyStripeSettlement, isOpenStripeCredit, matchWebBooking, planStripeSettlement,
  type PayoutLine, type WebBookingRef,
} from './stripeSettlement';

const STRIPE = 'STRIPE TECHNOLOGY EU';
const payoutTx = (amount: number, p: Partial<BankTransaction> = {}): BankTransaction => ({
  id: 'tx-stripe', date: '2026-08-03', amount, direction: 'credit', currency: 'CZK', state: 'revenue',
  counterpartyName: STRIPE, importedAt: '', ...p,
});
const web = (id: string, date: string, amount: number, fee: number, arrival: string, departure: string, name?: string): PayoutLine => ({
  id, kind: 'charge', date, amount, fee, net: Math.round((amount - fee) * 100) / 100,
  sessionId: `cs_${id}`, metadata: { roomId: '656437', arrival, departure }, customerName: name,
});
const booking = (reservationNumber: string, checkInDate: string, checkOutDate: string, price: number, p: Partial<WebBookingRef> = {}): WebBookingRef => ({
  reservationNumber, channel: 'Direct-Web', checkInDate, checkOutDate, price, isCancelled: false, guestName: 'Guest', ...p,
});
const issued = (p: Partial<RevenueInvoice> & { id: string; amountCZK: number }): RevenueInvoice => ({
  sourceType: 'issued', category: 'accommodation_direct', status: 'pending', invoiceNumber: p.id.toUpperCase(),
  invoiceDate: '2026-08-20', createdAt: '', ...p,
});

// The real 3 Aug 2026 payout: three website bookings, one already invoiced on request (Hlavacova)
const AUG_LINES = [
  web('a', '2026-06-29', 3902.4, 65.04, '2026-06-30', '2026-07-01'),
  web('b', '2026-07-01', 2756.8, 47.85, '2026-07-03', '2026-07-04'),
  web('c', '2026-07-16', 4382.38, 72.24, '2026-08-10', '2026-08-13', 'Angelika Hlavacova'),
];
const AUG_BOOKINGS = [
  booking('BH-89000438', '2026-06-30', '2026-07-01', 3902.4),
  booking('BH-89132870', '2026-07-03', '2026-07-04', 2756.8),
  booking('BH-89925619', '2026-08-10', '2026-08-13', 4382.38),
];
const HLAVACOVA = issued({ id: 'rev-BH-89925619', invoiceNumber: 'INV-89925619', amountCZK: 4382.38, reservationNumber: 'BH-89925619' });
const augPlan = (revenue: RevenueInvoice[] = [HLAVACOVA]) => planStripeSettlement({
  tx: payoutTx(10856.45),
  payout: { payoutId: 'po_1AUG', amount: 10856.45, arrivalDate: '2026-08-03', lines: AUG_LINES },
  revenueInvoices: revenue,
  bookings: AUG_BOOKINGS,
});

describe('planStripeSettlement — 3 Aug 2026 payout', () => {
  it('ties to the bank and books only the bookings without a revenue record', () => {
    const plan = augPlan();
    expect(plan.ties).toBe(true);
    expect(plan.issues).toEqual([]);
    expect(plan.gross).toBe(11041.58);
    expect(plan.fees).toBe(185.13);
    expect(plan.net).toBe(10856.45);
    expect(plan.newRevenue).toBe(6659.2);           // 3 902.40 + 2 756.80
    expect(plan.linkRevenueIds).toEqual(['rev-BH-89925619']);
    expect(plan.lines.map((l) => l.reservationNumbers)).toEqual([['BH-89000438'], ['BH-89132870'], ['BH-89925619']]);
  });

  it('books everything as new revenue when no invoice was issued', () => {
    expect(augPlan([]).newRevenue).toBe(11041.58);
  });

  it('flags a payout whose contents do not add up to the bank credit', () => {
    const plan = planStripeSettlement({
      tx: payoutTx(10856.46),
      payout: { payoutId: 'po_x', amount: 10856.46, arrivalDate: '2026-08-03', lines: AUG_LINES },
      revenueInvoices: [], bookings: AUG_BOOKINGS,
    });
    expect(plan.ties).toBe(false);
    expect(plan.issues[0]).toContain('add up');
  });

  it('flags a website payment it cannot tie to a booking', () => {
    const plan = planStripeSettlement({
      tx: payoutTx(10856.45),
      payout: { payoutId: 'po_1AUG', amount: 10856.45, arrivalDate: '2026-08-03', lines: AUG_LINES },
      revenueInvoices: [HLAVACOVA],
      bookings: AUG_BOOKINGS.slice(1),             // BH-89000438 missing from Beds24
    });
    expect(plan.issues.some((i) => i.includes("Couldn't tie"))).toBe(true);
  });

  it('flags an invoice whose amount differs from what the guest paid', () => {
    const plan = augPlan([{ ...HLAVACOVA, amountCZK: 4000 }]);
    expect(plan.issues.some((i) => i.includes('INV-89925619'))).toBe(true);
  });
});

describe('planStripeSettlement — other payout contents', () => {
  it('links a payment-link charge to its pay-<session> record', () => {
    const line: PayoutLine = { id: 'p', kind: 'charge', date: '2026-04-29', amount: 30000, fee: 456.5, net: 29543.5,
      sessionId: 'cs_link', metadata: { reservationNumber: 'BH-85864218' } };
    const pay = issued({ id: 'pay-cs_link', invoiceNumber: 'PAY-M6TYKTS3', amountCZK: 30000, reservationNumber: 'BH-85864218' });
    const plan = planStripeSettlement({ tx: payoutTx(29543.5), payout: { payoutId: 'po_j', amount: 29543.5, arrivalDate: '2026-06-01', lines: [line] },
      revenueInvoices: [pay], bookings: [] });
    expect(plan.issues).toEqual([]);
    expect(plan.newRevenue).toBe(0);
    expect(plan.linkRevenueIds).toEqual(['pay-cs_link']);
  });

  it('nets refunds and standalone Stripe fees', () => {
    const lines: PayoutLine[] = [
      web('a', '2026-09-03', 1000, 20, '2026-09-10', '2026-09-11'),
      { id: 'r', kind: 'refund', date: '2026-09-04', amount: -300, fee: 0, net: -300, metadata: { arrival: '2026-09-10', departure: '2026-09-11' } },
      { id: 'f', kind: 'fee', date: '2026-09-05', amount: -10, fee: 0, net: -10 },
    ];
    const plan = planStripeSettlement({ tx: payoutTx(670), payout: { payoutId: 'po_r', amount: 670, arrivalDate: '2026-09-07', lines },
      revenueInvoices: [], bookings: [booking('BH-1', '2026-09-10', '2026-09-11', 1000)] });
    expect(plan.ties).toBe(true);
    expect(plan.gross).toBe(700);
    expect(plan.fees).toBe(30);
    expect(plan.newRevenue).toBe(700);
  });
});

describe('matchWebBooking', () => {
  it('ties a multi-room website order to all its rows', () => {
    const rows = [booking('BH-1', '2026-09-12', '2026-09-27', 15000), booking('BH-2', '2026-09-12', '2026-09-27', 12521.6)];
    expect(matchWebBooking('2026-09-12', '2026-09-27', 27521.6, rows).map((b) => b.reservationNumber)).toEqual(['BH-1', 'BH-2']);
  });
  it('ignores other channels and other stays', () => {
    const rows = [booking('BH-3', '2026-09-12', '2026-09-27', 500, { channel: 'Booking.com' }), booking('BH-4', '2026-09-13', '2026-09-27', 500)];
    expect(matchWebBooking('2026-09-12', '2026-09-27', 500, rows)).toEqual([]);
  });
});

describe('applyStripeSettlement', () => {
  const fresh = () => ({
    transactions: [payoutTx(10856.45)],
    revenueInvoices: [HLAVACOVA],
    supplierInvoices: [] as SupplierInvoice[],
    groups: [] as SettlementGroup[],
  });

  it('books revenue + fees, links the invoice and groups the payout', () => {
    const data = fresh();
    const { group, revenueRecord, feeRecord } = applyStripeSettlement(augPlan(), data, 'g1', '2026-10-13T00:00:00Z');
    expect(group).toMatchObject({ source: 'stripe', stripePayoutId: 'po_1AUG', netAmount: 10856.45, grossAmount: 11041.58, commissionAmount: 185.13 });
    expect(revenueRecord).toMatchObject({ amountCZK: 6659.2, category: 'accommodation_direct', invoiceDate: '2026-08-03', settlementGroupId: 'g1' });
    expect(feeRecord).toMatchObject({ amountCZK: 185.13, category: 'distribution-fees', settlementGroupId: 'g1' });
    expect(data.revenueInvoices.find((r) => r.id === 'rev-BH-89925619')).toMatchObject({ status: 'reconciled', settlementGroupId: 'g1' });
    expect(data.transactions[0]).toMatchObject({ state: 'grouped', settlementGroupId: 'g1' });
    // revenue in the P&L = linked invoice + new record = everything the guests paid
    expect(data.revenueInvoices.reduce((s, r) => s + r.amountCZK, 0)).toBeCloseTo(11041.58, 2);
  });

  it('refuses to book the same payout twice', () => {
    const data = fresh();
    applyStripeSettlement(augPlan(), data, 'g1', '');
    expect(() => applyStripeSettlement(augPlan(), data, 'g2', '')).toThrow();
  });
});

describe('isOpenStripeCredit', () => {
  it('covers unlinked Stripe credits only — hand-tagged ones (closed months) are left alone', () => {
    expect(isOpenStripeCredit(payoutTx(1))).toBe(true);
    expect(isOpenStripeCredit(payoutTx(1, { state: 'net_settlement' }))).toBe(false);
    expect(isOpenStripeCredit(payoutTx(1, { state: 'grouped', settlementGroupId: 'g' }))).toBe(false);
    expect(isOpenStripeCredit(payoutTx(1, { counterpartyName: 'BOOKING.COM B.V.' }))).toBe(false);
  });
});
