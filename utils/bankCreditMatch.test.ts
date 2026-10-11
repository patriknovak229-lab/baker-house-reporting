import { describe, expect, it } from 'vitest';
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SettlementGroup } from '@/types/settlementGroup';
import { findIssuedInvoiceMatches, findSettlementPayouts } from './bankCreditMatch';

let seq = 0;
function credit(p: Partial<BankTransaction> & { date: string; amount: number }): BankTransaction {
  return { id: `c${++seq}`, direction: 'credit', currency: 'CZK', state: 'revenue', importedAt: '', ...p };
}
function settlement(p: Partial<SettlementGroup> & { source: SettlementGroup['source']; netAmount: number; periodStart: string; periodEnd: string }): SettlementGroup {
  return { id: `g${++seq}`, name: 'x', transactionIds: [], invoiceIds: [], createdAt: '', grossAmount: p.netAmount * 1.2, ...p };
}
function issued(p: Partial<RevenueInvoice> & { invoiceNumber: string; invoiceDate: string; amountCZK: number }): RevenueInvoice {
  return { id: `r${++seq}`, sourceType: 'issued', category: 'accommodation_direct', status: 'pending', createdAt: '', ...p };
}
const ids = (m: { payouts: BankTransaction[] }[]) => m.map((x) => x.payouts.map((p) => p.id).sort());

describe('findSettlementPayouts', () => {
  const BOOKING = 'BOOKING.COM B.V.';
  const CITI = 'CITIBANK EUROPE PLC';

  it('links the single Booking payout equal to the settlement net', () => {
    const g = settlement({ source: 'booking', netAmount: 288695.34, periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    const pay = credit({ date: '2026-08-07', amount: 288695.34, counterpartyName: BOOKING });
    const other = credit({ date: '2026-08-07', amount: 288695.35, counterpartyName: BOOKING });
    const [m] = findSettlementPayouts([pay, other], [g]);
    expect(m.payouts.map((p) => p.id)).toEqual([pay.id]);
    expect(m.reason).toBe('Booking.com payout = settlement net (exact)');
  });

  it('finds the unique Airbnb payout combination (Airbnb June 2026)', () => {
    const g = settlement({ source: 'airbnb', netAmount: 8804.64, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
    const a = credit({ date: '2026-06-08', amount: 4690.83, counterpartyName: CITI });
    const b = credit({ date: '2026-06-09', amount: 1690.55, counterpartyName: CITI });
    const c = credit({ date: '2026-07-01', amount: 2423.26, counterpartyName: CITI });
    const noise = credit({ date: '2026-06-20', amount: 3228.36, counterpartyName: CITI });
    expect(ids(findSettlementPayouts([a, b, c, noise], [g]))).toEqual([[a.id, b.id, c.id].sort()]);
  });

  it('leaves it alone when two combinations fit', () => {
    const g = settlement({ source: 'airbnb', netAmount: 300, periodStart: '2026-06-01', periodEnd: '2026-06-30' });
    const pays = [100, 200, 300].map((amount) => credit({ date: '2026-06-10', amount, counterpartyName: CITI }));
    expect(findSettlementPayouts(pays, [g])).toEqual([]);
  });

  it('only completes the remaining net when some payouts are already linked', () => {
    const linked = credit({ date: '2026-06-08', amount: 1000, counterpartyName: CITI, state: 'grouped' });
    const rest = credit({ date: '2026-06-20', amount: 500, counterpartyName: CITI });
    const g = settlement({ source: 'airbnb', netAmount: 1500, periodStart: '2026-06-01', periodEnd: '2026-06-30', transactionIds: [linked.id] });
    linked.settlementGroupId = g.id;
    expect(ids(findSettlementPayouts([linked, rest], [g]))).toEqual([[rest.id]]);
  });

  it('ignores the wrong payer, other dates and already-claimed credits', () => {
    const g = settlement({ source: 'booking', netAmount: 5000, periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    const wrongPayer = credit({ date: '2026-08-05', amount: 5000, counterpartyName: CITI });
    const tooLate = credit({ date: '2026-09-15', amount: 5000, counterpartyName: BOOKING });
    const claimed = credit({ date: '2026-08-05', amount: 5000, counterpartyName: BOOKING, revenueInvoiceId: 'r' });
    expect(findSettlementPayouts([wrongPayer, tooLate, claimed], [g])).toEqual([]);
  });

  it('skips a payout two settlements could both claim', () => {
    const a = settlement({ source: 'booking', netAmount: 7000, periodStart: '2026-07-01', periodEnd: '2026-07-31' });
    const b = settlement({ source: 'booking', netAmount: 7000, periodStart: '2026-07-15', periodEnd: '2026-08-10' });
    const pay = credit({ date: '2026-08-05', amount: 7000, counterpartyName: BOOKING });
    expect(findSettlementPayouts([pay], [a, b])).toEqual([]);
  });
});

describe('findIssuedInvoiceMatches', () => {
  it('matches by the invoice number paid as variable symbol', () => {
    const inv = issued({ invoiceNumber: 'INV-90497269', invoiceDate: '2026-07-28', amountCZK: 12996, clientName: 'Fakultní nemocnice Hradec Králové' });
    const tx = credit({ date: '2026-08-19', amount: 12996, variableSymbol: '90497269', counterpartyName: 'Fak. nemocnice HK' });
    const [m] = findIssuedInvoiceMatches([tx], [inv]);
    expect(m.invoice.id).toBe(inv.id);
    expect(m.reason).toBe('invoice no. on payment · name match · exact amount · +22 d');
  });

  it('tells two same-amount invoices apart by their -1 / -2 suffix (VS 927983731 / 927983732)', () => {
    const i1 = issued({ invoiceNumber: 'INV-92798373-1', invoiceDate: '2026-09-08', amountCZK: 5796 });
    const i2 = issued({ invoiceNumber: 'INV-92798373-2', invoiceDate: '2026-09-08', amountCZK: 5796 });
    const t2 = credit({ date: '2026-09-24', amount: 5796, variableSymbol: '927983732' });
    const t1 = credit({ date: '2026-09-24', amount: 5796, variableSymbol: '927983731' });
    const m = findIssuedInvoiceMatches([t2, t1], [i1, i2]).map((x) => [x.tx.id, x.invoice.id]).sort();
    expect(m).toEqual([[t1.id, i1.id], [t2.id, i2.id]].sort());
  });

  it('accepts name + exact amount without a VS, but not amount alone', () => {
    const inv = issued({ invoiceNumber: 'INV-1', invoiceDate: '2026-08-01', amountCZK: 18000, guestName: 'Jiří Šindelář' });
    const named = credit({ date: '2026-08-11', amount: 18000, counterpartyName: 'Šindelář, Jiří' });
    const anonymous = credit({ date: '2026-08-11', amount: 18000, counterpartyName: 'Someone Else' });
    expect(findIssuedInvoiceMatches([named], [inv]).map((m) => m.tx.id)).toEqual([named.id]);
    expect(findIssuedInvoiceMatches([anonymous], [inv])).toEqual([]);
  });

  it('skips OTA gross records, reconciled invoices and claimed credits', () => {
    const ota = issued({ invoiceNumber: 'booking-gross-2026-07-01', invoiceDate: '2026-07-01', amountCZK: 5000, category: 'ota_gross' });
    const done = issued({ invoiceNumber: 'INV-2', invoiceDate: '2026-07-01', amountCZK: 5000, status: 'reconciled' });
    const tx = credit({ date: '2026-07-05', amount: 5000, variableSymbol: '2' });
    expect(findIssuedInvoiceMatches([tx], [ota, done])).toEqual([]);
  });
});
