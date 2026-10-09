import { describe, expect, it } from 'vitest';
import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import {
  findAutoMatches,
  findSuggestion,
  learnCounterparties,
  nameTokens,
  scoreCandidate,
} from './bankInvoiceMatch';

const CARD = '412501******5296';
let seq = 0;

function debit(p: Partial<BankTransaction> & { date: string; amount: number }): BankTransaction {
  return { id: `tx${++seq}`, direction: 'debit', currency: 'CZK', state: 'unmatched', importedAt: '2026-10-01T00:00:00Z', ...p };
}
function invoice(p: Partial<SupplierInvoice> & { invoiceDate: string; amountCZK: number; supplierName: string }): SupplierInvoice {
  return {
    id: `inv${++seq}`, invoiceNumber: `N${seq}`, category: 'consumables', status: 'pending',
    sourceType: 'drive', createdAt: '2026-10-09T00:00:00Z', ...p,
  };
}
/** A past manual match that teaches "this counterparty = this supplier". */
function history(tx: Partial<BankTransaction>, inv: Partial<SupplierInvoice> & { supplierName: string }) {
  const i = invoice({ invoiceDate: '2026-03-01', amountCZK: 100, status: 'reconciled', ...inv });
  const t = debit({ date: '2026-03-02', amount: 100, state: 'reconciled', invoiceId: i.id, invoiceIds: [i.id], ...tx });
  i.bankTransactionId = t.id;
  return { t, i };
}
function run(txs: BankTransaction[], invs: SupplierInvoice[]) {
  return findAutoMatches(txs, invs, learnCounterparties(txs, invs)).map((m) => [m.tx.id, m.invoice.id]);
}

const ACTION = { supplierName: 'Action Retail Czech s.r.o.', supplierICO: '03439747' };
const ALZA = { supplierName: 'Alza.cz a.s.', supplierICO: '27082440' };

describe('nameTokens', () => {
  it('drops legal forms, gateways, cities and numbers', () => {
    expect(nameTokens('IKEA Česká republika, s.r.o.')).toEqual(['ikea']);
    expect(nameTokens('GOPAY  *VYPRODEJPOVLECENI')).toEqual(['vyprodejpovleceni']);
    expect(nameTokens('PEPCO 130184 BRNO 13')).toEqual(['pepco']);
  });
});

describe('findAutoMatches', () => {
  it('learns a trading name from a past manual match (B080 Modrice = Action)', () => {
    const h = history({ counterpartyName: 'B080 Modrice', counterpartyAccount: CARD }, ACTION);
    const tx = debit({ date: '2026-08-03', amount: 2397, counterpartyName: 'B080 Modrice', counterpartyAccount: CARD });
    const inv = invoice({ ...ACTION, invoiceDate: '2026-07-31', amountCZK: 2397 });
    expect(run([h.t, tx], [h.i, inv])).toEqual([[tx.id, inv.id]]);
  });

  it('never matches on amount alone', () => {
    const tx = debit({ date: '2026-08-03', amount: 2397, counterpartyName: 'B080 Modrice', counterpartyAccount: CARD });
    const inv = invoice({ ...ACTION, invoiceDate: '2026-07-31', amountCZK: 2397 });
    expect(run([tx], [inv])).toEqual([]);
  });

  it('learns a bank account for name-less transfers', () => {
    const h = history({ counterpartyAccount: '377377203/0300' }, { supplierName: 'Homola Pavel', supplierICO: '68070632' });
    const tx = debit({ date: '2026-07-13', amount: 3107, counterpartyAccount: '377377203/0300', description: 'PRANI A MANDLOVANI' });
    const inv = invoice({ supplierName: 'Homola Pavel - Pradelna', supplierICO: '68070632', invoiceDate: '2026-07-10', amountCZK: 3107 });
    expect(run([h.t, tx], [h.i, inv])).toEqual([[tx.id, inv.id]]);
  });

  it('uses the invoice number in the payment message to pick between same-amount invoices', () => {
    const rywa = { supplierName: 'RYWA s.r.o.', supplierICO: '07092644' };
    const tx = debit({ date: '2026-02-16', amount: 1718, counterpartyAccount: '2701441318/2010', variableSymbol: '2500302', description: 'FV2603200 RYWA S.R.O.' });
    const right = invoice({ ...rywa, invoiceNumber: 'FV2603200', invoiceDate: '2026-02-03', dueDate: '2026-02-17', amountCZK: 1718 });
    const other = invoice({ ...rywa, invoiceNumber: 'FV2605061', invoiceDate: '2026-03-04', dueDate: '2026-03-18', amountCZK: 1718 });
    expect(run([tx], [other, right])).toEqual([[tx.id, right.id]]);
  });

  it('matches a variable symbol equal to the invoice number, with no name at all', () => {
    const tx = debit({ date: '2026-09-21', amount: 14000, counterpartyAccount: '4656296033/0800', variableSymbol: '126014', description: 'SKRINKA POD TV' });
    const inv = invoice({ supplierName: 'Viktor Yakymenko', invoiceNumber: '126014', invoiceDate: '2026-09-18', amountCZK: 14000 });
    expect(run([tx], [inv])).toEqual([[tx.id, inv.id]]);
  });

  it('a near amount (1 %) is not enough without the invoice number', () => {
    const tx = debit({ date: '2026-08-10', amount: 316, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const inv318 = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 318 });
    expect(run([tx], [inv318])).toEqual([]);
  });

  it('an exact amount beats a 1 %-off one instead of blocking it (316 vs 318)', () => {
    const tx = debit({ date: '2026-08-10', amount: 316, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const inv316 = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 316 });
    const inv318 = invoice({ ...ALZA, invoiceDate: '2026-09-17', amountCZK: 318 });
    expect(run([tx], [inv318, inv316])).toEqual([[tx.id, inv316.id]]);
  });

  it('leaves twins (two equal invoices, one payment) for the user', () => {
    const ikea = { supplierName: 'IKEA Česká republika, s.r.o.', supplierICO: '27081052' };
    const tx = debit({ date: '2026-08-26', amount: 5308, counterpartyName: 'IKEA CZ ecom', counterpartyAccount: CARD });
    const a = invoice({ ...ikea, invoiceDate: '2026-08-25', amountCZK: 5308 });
    const b = invoice({ ...ikea, invoiceDate: '2026-08-29', amountCZK: 5308 });
    expect(run([tx], [a, b])).toEqual([]);
  });

  it('resolves independent of order once a rival is taken', () => {
    // Two Alza payments, two Alza invoices of different amounts — both resolve.
    const t1 = debit({ date: '2026-08-10', amount: 949, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const t2 = debit({ date: '2026-08-10', amount: 316, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const i1 = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 316 });
    const i2 = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 949 });
    expect(run([t1, t2], [i1, i2]).sort()).toEqual([[t1.id, i2.id], [t2.id, i1.id]].sort());
  });

  it('respects the date window', () => {
    const tx = debit({ date: '2026-01-05', amount: 2397, counterpartyName: 'Action B029', counterpartyAccount: CARD });
    const tooLate = invoice({ ...ACTION, invoiceDate: '2026-03-01', amountCZK: 2397 }); // paid 55 d before
    const tooEarly = invoice({ ...ACTION, invoiceDate: '2025-10-01', amountCZK: 2397 }); // 96 d after
    expect(run([tx], [tooLate])).toEqual([]);
    expect(run([tx], [tooEarly])).toEqual([]);
  });

  it('compares foreign invoices in their own currency', () => {
    const pl = { supplierName: 'PriceLabs Revenue Inc.', supplierICO: '41-4535625' };
    const tx = debit({ date: '2026-07-24', amount: 1763.79, originalAmount: 79.96, originalCurrency: 'USD', counterpartyName: 'PRICELABSINC*DYNAPRICE', counterpartyAccount: CARD });
    const usd = invoice({ ...pl, invoiceDate: '2026-07-22', amountCZK: 79.96, invoiceCurrency: 'USD' });
    const eur = invoice({ ...pl, invoiceDate: '2026-07-22', amountCZK: 79.96, invoiceCurrency: 'EUR' });
    expect(run([tx], [eur])).toEqual([]);
    expect(run([tx], [usd])).toEqual([[tx.id, usd.id]]);
  });

  it('ignores credit notes and already-linked invoices', () => {
    const tx = debit({ date: '2026-07-11', amount: 1499, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const cn = invoice({ ...ALZA, invoiceDate: '2026-07-10', amountCZK: -1499, documentType: 'credit_note' });
    const linked = invoice({ ...ALZA, invoiceDate: '2026-07-10', amountCZK: 1499, bankTransactionId: 'other' });
    expect(run([tx], [cn, linked])).toEqual([]);
  });

  it('only touches unmatched debits', () => {
    const tx = debit({ date: '2026-08-10', amount: 949, counterpartyName: 'Alza.cz', counterpartyAccount: CARD, state: 'non_deductible' });
    const inv = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 949 });
    expect(run([tx], [inv])).toEqual([]);
  });

  it('records why it matched', () => {
    const tx = debit({ date: '2026-08-10', amount: 949, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const inv = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 949 });
    const [m] = findAutoMatches([tx], [inv], new Map());
    expect(m.reason).toBe('name match · exact amount · +3 d');
  });
});

describe('findSuggestion', () => {
  it('suggests on a looser bar the user confirms (1 % off, name match)', () => {
    const tx = debit({ date: '2026-05-11', amount: 16359, counterpartyName: 'IKEA BRNO OD ECO', counterpartyAccount: CARD });
    const inv = invoice({ supplierName: 'IKEA Česká republika, s.r.o.', invoiceDate: '2026-05-10', amountCZK: 16366 });
    expect(findSuggestion(tx, [inv])?.id).toBe(inv.id);
  });

  it('suggests the only candidate even without a name signal', () => {
    const tx = debit({ date: '2026-08-03', amount: 2397, counterpartyName: 'B080 Modrice', counterpartyAccount: CARD });
    const inv = invoice({ ...ACTION, invoiceDate: '2026-07-31', amountCZK: 2397 });
    expect(findSuggestion(tx, [inv])?.id).toBe(inv.id);
  });

  it('does not suggest a 1 %-off amount with no identity signal', () => {
    const tx = debit({ date: '2026-07-13', amount: 3107, counterpartyAccount: '377377203/0300', description: 'PRANI A MANDLOVANI' });
    const penny = invoice({ supplierName: 'PENNY MARKET s.r.o.', invoiceDate: '2026-08-06', amountCZK: 3095.86 });
    expect(findSuggestion(tx, [penny])).toBeNull();
  });

  it('returns null when several candidates have no identity signal', () => {
    const tx = debit({ date: '2026-08-03', amount: 500, counterpartyAccount: '1/0100' });
    const a = invoice({ supplierName: 'Foo s.r.o.', invoiceDate: '2026-08-01', amountCZK: 500 });
    const b = invoice({ supplierName: 'Bar s.r.o.', invoiceDate: '2026-08-02', amountCZK: 500 });
    expect(findSuggestion(tx, [a, b])).toBeNull();
  });
});

describe('scoreCandidate', () => {
  it('flags auto-eligibility', () => {
    const tx = debit({ date: '2026-08-10', amount: 949, counterpartyName: 'Alza.cz', counterpartyAccount: CARD });
    const inv = invoice({ ...ALZA, invoiceDate: '2026-08-07', amountCZK: 949 });
    const c = scoreCandidate(tx, inv, new Map(), 'auto');
    expect(c?.autoEligible).toBe(true);
    expect(c?.evidence).toEqual(['name']);
  });
});
