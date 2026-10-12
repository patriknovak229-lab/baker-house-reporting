/**
 * VAT engine — one synthetic month (February 2027) covering every flow.
 * Expected numbers are worked out by hand (comments), not by the engine.
 * Synthetic data only: the reporting repo is public.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRevenue, computeThreshold, computeVatMonth, thresholdFlags,
  type FxLookup, type InSupplierInvoice, type VatEngineInput,
} from './engine';
import { DEFAULT_VAT_CONFIG } from './config';
import type { VatSettings } from '@/types/vat';

const fx: FxLookup = (currency, date) => {
  if (currency === 'EUR') return { rateMilli: 24250, unit: 1, fixingDate: '2027-02-01' };
  if (currency === 'USD' && date >= '2027-02-19') return { rateMilli: 21000, unit: 1, fixingDate: '2027-02-19' };
  return null;
};

function sup(p: Partial<InSupplierInvoice> & Pick<InSupplierInvoice, 'id' | 'supplierName' | 'invoiceNumber' | 'date' | 'amountMinor'>): InSupplierInvoice {
  return {
    supplierIco: null, invoiceDate: p.date, dueDate: null, currency: 'CZK', vatMinor: 0, breakdown: null, category: 'consumables',
    creditNote: false, status: 'reconciled', settlementGroupId: null, paid: true, ...p,
  };
}

function settings(over: Partial<VatSettings> = {}): VatSettings {
  return { config: { ...DEFAULT_VAT_CONFIG, payerFrom: '2027-01-01' }, otaDocuments: {}, decisions: {}, ...over };
}

function input(over: Partial<VatEngineInput> = {}): VatEngineInput {
  return {
    month: '2027-02',
    today: '2027-03-10',
    settings: settings(),
    fx,
    settlements: [
      // Booking: gross 100 000,00; commission 18 000,00
      { id: 'b1', name: 'Booking.com February 2027', source: 'booking', periodStart: '2027-02-01', periodEnd: '2027-02-28', grossHal: 10_000_000, commissionHal: 1_800_000, adjustmentsHal: null },
      // Airbnb: gross 10 000,00; fee 1 875,50 = 18,755 % → 15,5 % + 21 % VAT
      { id: 'a1', name: 'Airbnb February 2027', source: 'airbnb', periodStart: '2027-02-01', periodEnd: '2027-02-28', grossHal: 1_000_000, commissionHal: 187_550, adjustmentsHal: 0 },
    ],
    revenueInvoices: [
      // Direct, paid by bank 5 Feb before the stay (check-out 20 Feb) → tax point 5 Feb
      { id: 'r1', number: 'INV-1', date: '2027-02-10', amountHal: 500_000, category: 'accommodation_direct', sourceType: 'issued', reservationNumber: 'BH-1', clientName: null, guestName: 'Guest One', settlementGroupId: null, paidDate: '2027-02-05' },
      // Invoice for a live Booking.com reservation, not paid to us → excluded by default
      { id: 'r2', number: 'INV-2', date: '2027-02-12', amountHal: 300_000, category: 'accommodation_direct', sourceType: 'issued', reservationNumber: 'BH-2', clientName: null, guestName: 'Guest Two', settlementGroupId: null, paidDate: null },
      // Other services, no stay / payment data → invoice date, 21 %
      { id: 'r3', number: 'INV-3', date: '2027-02-15', amountHal: 121_000, category: 'other_services', sourceType: 'manual', reservationNumber: null, clientName: null, guestName: null, settlementGroupId: null, paidDate: null },
      // Payment-link record for BH-4 (paid by Stripe)
      { id: 'r4', number: 'PAY-X', date: '2027-02-18', amountHal: 200_000, category: 'accommodation_direct', sourceType: 'issued', reservationNumber: 'BH-4', clientName: null, guestName: 'Guest Four', settlementGroupId: null, paidDate: null },
      // Invoice issued later for a web booking already paid by Stripe on 3 Feb
      { id: 'r5', number: 'INV-5', date: '2027-02-25', amountHal: 438_238, category: 'accommodation_direct', sourceType: 'issued', reservationNumber: 'BH-5', clientName: null, guestName: 'Guest Five', settlementGroupId: null, paidDate: null },
      // OTA gross record — comes from the settlement, must be ignored here
      { id: 'r6', number: 'booking-gross', date: '2027-02-01', amountHal: 10_000_000, category: 'ota_gross', sourceType: 'ota', reservationNumber: null, clientName: 'Booking.com B.V.', guestName: null, settlementGroupId: 'b1', paidDate: null },
    ],
    stripePayments: [
      { sessionId: 'cs_live_p4', description: 'Baker House — reservation BH-4', amountHal: 200_000, reservationNumber: 'BH-4', paidDate: '2027-02-18', live: true, stayFrom: null, stayTo: null },
      { sessionId: 'cs_live_p5', description: 'Web booking 2027-02-20 → 2027-02-23', amountHal: 438_238, reservationNumber: null, paidDate: '2027-02-03', live: true, stayFrom: '2027-02-20', stayTo: '2027-02-23' },
      { sessionId: 'cs_live_p6', description: 'Web booking 2027-03-10 → 2027-03-12', amountHal: 300_000, reservationNumber: null, paidDate: '2027-02-27', live: true, stayFrom: '2027-03-10', stayTo: '2027-03-12' },
      { sessionId: 'cs_test_p7', description: 'test', amountHal: 11_100, reservationNumber: null, paidDate: '2027-02-10', live: false, stayFrom: null, stayTo: null },
    ],
    refunds: [{ id: 're_1', reservationNumber: 'BH-9', amountHal: 50_000, date: '2027-02-26', description: 'Late check-out' }],
    reservations: {
      'BH-1': { channel: 'Direct-Phone', checkIn: '2027-02-18', checkOut: '2027-02-20', cancelled: false },
      'BH-2': { channel: 'Booking.com', checkIn: '2027-02-12', checkOut: '2027-02-14', cancelled: false },
      'BH-4': { channel: 'Direct-Phone', checkIn: '2027-03-01', checkOut: '2027-03-05', cancelled: false },
      'BH-5': { channel: 'Direct-Web', checkIn: '2027-02-20', checkOut: '2027-02-23', cancelled: false },
    },
    supplierInvoices: [
      sup({ id: 'd1', supplierName: 'PENNY MARKET s.r.o.', supplierIco: '64945880', invoiceNumber: 'P-1', date: '2027-02-03', amountMinor: 121_000, vatMinor: 21_000, breakdown: [{ rate: 21, baseMinor: 100_000, vatMinor: 21_000 }] }),
      sup({ id: 'd1b', supplierName: 'PENNY MARKET s.r.o.', supplierIco: '64945880', invoiceNumber: 'P 1', date: '2027-02-04', amountMinor: 121_000, vatMinor: 21_000, breakdown: [{ rate: 21, baseMinor: 100_000, vatMinor: 21_000 }] }),
      sup({ id: 'd2', supplierName: 'Action Retail Czech s.r.o.', supplierIco: '03439747', invoiceNumber: 'A-1', date: '2027-02-05', amountMinor: 317_440, vatMinor: 45_381,
        breakdown: [{ rate: 12, baseMinor: 130_571, vatMinor: 15_669 }, { rate: 21, baseMinor: 141_488, vatMinor: 29_712 }] }),
      sup({ id: 'd3', supplierName: 'Jan Novák', supplierIco: '12345679', invoiceNumber: 'N-1', date: '2027-02-10', amountMinor: 1_400_000, vatMinor: 150_000, category: 'equipment',
        breakdown: [{ rate: 12, baseMinor: 1_250_000, vatMinor: 150_000 }] }),
      sup({ id: 'd4', supplierName: 'Alza.cz a.s.', supplierIco: '27082440', invoiceNumber: 'D-1', date: '2027-02-11', amountMinor: -149_900, vatMinor: -26_016, creditNote: true,
        breakdown: [{ rate: 21, baseMinor: -123_884, vatMinor: -26_016 }] }),
      sup({ id: 'f1', supplierName: 'Beds24 GmbH', supplierIco: 'DE328454604', invoiceNumber: 'B-1', date: '2027-02-01', currency: 'EUR', amountMinor: 7_181, vatMinor: 1_246, category: 'software' }),
      sup({ id: 'f2', supplierName: 'PriceLabs Revenue Inc.', supplierIco: '41-4535625', invoiceNumber: 'PL-1', date: '2027-02-21', currency: 'USD', amountMinor: 8_396, vatMinor: 0, category: 'software' }),
      sup({ id: 'f3', supplierName: 'ARTGEIST SPÓŁKA Z O.O.', supplierIco: '7262622485', invoiceNumber: 'AG-1', date: '2027-02-14', amountMinor: 452_850, vatMinor: 78_594, category: 'equipment' }),
      sup({ id: 'm1', supplierName: 'Temu', invoiceNumber: 'T-1', date: '2027-02-04', amountMinor: 145_800, vatMinor: 25_305 }),
      sup({ id: 'n1', supplierName: 'Jana Uklízečka', supplierIco: '87654326', invoiceNumber: 'U-1', date: '2027-02-28', amountMinor: 680_000, category: 'cleaning' }),
      sup({ id: 'o1', supplierName: 'Booking.com B.V.', invoiceNumber: 'booking-fees', date: '2027-02-01', amountMinor: 1_800_000, settlementGroupId: 'b1', category: 'distribution-fees' }),
      sup({ id: 'o2', supplierName: 'Airbnb', invoiceNumber: 'AIRBNB-123', date: '2027-02-09', amountMinor: 50_000, category: 'distribution-fees' }),
      sup({ id: 'x1', supplierName: 'Last Month s.r.o.', supplierIco: '11111111', invoiceNumber: 'L-1', date: '2027-01-31', amountMinor: 121_000, vatMinor: 21_000, breakdown: [{ rate: 21, baseMinor: 100_000, vatMinor: 21_000 }] }),
    ],
    ...over,
  };
}

const codes = (r: ReturnType<typeof computeVatMonth>) => r.flags.map((f) => `${f.severity}:${f.code}`);

describe('vat/engine — February 2027 (live)', () => {
  const r = computeVatMonth(input());

  it('taxes every sale on the right date and counts double-recorded bookings once', () => {
    const ids = r.revenue.lines.map((l) => l.id).sort();
    expect(ids).toEqual(['inv:r1', 'inv:r3', 'refund:re_1', 'stl:a1', 'stl:b1', 'stripe:cs_live_p4', 'stripe:cs_live_p5', 'stripe:cs_live_p6'].sort());
    expect(r.revenue.lines.find((l) => l.id === 'inv:r1')?.taxPoint).toBe('2027-02-05'); // prepayment
    expect(r.revenue.lines.find((l) => l.id === 'stripe:cs_live_p4')?.taxPoint).toBe('2027-02-18'); // before the March stay
    expect(r.revenue.lines.find((l) => l.id === 'stripe:cs_live_p6')?.taxPoint).toBe('2027-02-27');
    // A.5 at 12 %: booking 8 928 571 / 1 071 429; airbnb 892 857 / 107 143; r1 446 429 / 53 571;
    // p4 178 571 / 21 429; p5 391 284 / 46 954; p6 267 857 / 32 143; refund −44 643 / −5 357
    expect(r.a5.base12Hal).toBe(11_060_926);
    expect(r.a5.vat12Hal).toBe(1_327_312);
    // other services at 21 %: 1 210,00 → 1 000,00 + 210,00
    expect(r.a5.base21Hal).toBe(100_000);
    expect(r.a5.vat21Hal).toBe(21_000);
  });

  it('builds A.2 from settlements and foreign invoices (net of any VAT they charged)', () => {
    const byId = Object.fromEntries(r.a2.map((a) => [a.id, a]));
    expect(byId['otastl:b1']).toMatchObject({ baseHal: 1_800_000, vatHal: 378_000, countryCode: 'NL', vatId: '805734958B01', dapRow: 5, documentNumber: null });
    expect(byId['otastl:a1']).toMatchObject({ baseHal: 155_000, vatHal: 32_550, foreignVatChargedHal: 32_550, countryCode: 'IE' });
    expect(byId['sup:f1']).toMatchObject({ baseHal: 143_924, vatHal: 30_224, foreignVatChargedHal: 30_216, dapRow: 5, fxFixingDate: '2027-02-01' });
    expect(byId['sup:f2']).toMatchObject({ baseHal: 176_316, vatHal: 37_026, dapRow: 12, countryCode: null, fxFixingDate: '2027-02-19' });
    expect(byId['sup:f3']).toMatchObject({ baseHal: 374_256, vatHal: 78_594, dapRow: 3, kind: 'goods_eu', countryCode: 'PL' });
    expect(r.a2).toHaveLength(5);
  });

  it('splits Czech purchases into B.2 / B.3 and keeps the rest out with a reason', () => {
    expect(r.b2.map((d) => d.id)).toEqual(['d3']);
    expect(r.b3.docs.map((d) => d.id).sort()).toEqual(['d1', 'd2', 'd4']);
    expect(r.b3.totals).toEqual({ base21Hal: 117_604, vat21Hal: 24_696, base12Hal: 130_571, vat12Hal: 15_669 });
    const reasons = Object.fromEntries(r.excluded.map((x) => [x.id, x.reason]));
    expect(reasons).toEqual({ d1b: 'duplicate', m1: 'marketplace', n1: 'no_vat', o2: 'legacy_ota' });
  });

  it('produces the VAT return in whole crowns and a matching section C', () => {
    const v = r.dap.values;
    expect([v.r1b, v.r1t, v.r2b, v.r2t]).toEqual([1_000, 210, 110_609, 13_273]);
    expect([v.r3b, v.r3t, v.r5b, v.r5t, v.r12b, v.r12t]).toEqual([3_743, 786, 20_989, 4_408, 1_763, 370]);
    expect([v.r40b, v.r40t, v.r41b, v.r41t, v.r43b, v.r43t]).toEqual([1_176, 247, 13_806, 1_657, 26_495, 5_564]);
    expect([v.r46, v.r62, v.r63, v.r64, v.r65]).toEqual([7_468, 19_047, 7_468, 11_579, 0]);
    expect(r.totals.payableHal).toBe(1_157_947);
    expect(r.totals.reverseChargeVatHal).toBe(r.totals.reverseChargeDeductionHal);
    expect(r.khC).toEqual({ obrat23: 100_000, obrat5: 11_060_926, pln23: 117_604, pln5: 1_380_571, rezPren23: 0, rezPren5: 0, plnRezPren: 0, celkZdA2: 2_649_496 });
    expect(codes(r)).not.toContain('error:KH_C_MISMATCH');
  });

  it('raises the red flags an operator must see', () => {
    const c = codes(r);
    for (const expected of [
      'error:DUPLICATE_INVOICE', 'error:LEGACY_OTA_INVOICE',
      'warning:DOUBLE_RECORDED', 'warning:OTA_INVOICE_DUPLICATE', 'warning:FOREIGN_VAT_CHARGED', 'warning:NATURAL_PERSON_DIC',
      'warning:UNUSUAL_RATE', 'warning:REFUND', 'warning:OTHER_SERVICES_RATE', 'warning:OTA_DOC_MISSING',
      'info:STRIPE_NOT_IN_BOOKS', 'info:MARKETPLACE_VAT', 'info:NO_VAT_SUPPLIERS', 'info:EU_GOODS_WITH_VAT', 'info:NO_STAY_DATES',
    ]) expect(c).toContain(expected);
    expect(c).not.toContain('info:SIMULATION');
    // errors sort first
    expect(r.flags[0].severity).toBe('error');
    const foreign = r.flags.find((f) => f.code === 'FOREIGN_VAT_CHARGED');
    expect(foreign?.items?.length).toBe(3); // Airbnb + Beds24 + Artgeist
  });

  it('applies operator decisions', () => {
    const decided = computeVatMonth(input({ settings: settings({ decisions: { 'dup:cs_live_p5': 'separate', 'ota-inv:r2': 'include' } }) }));
    // + INV-5 again (391 284 / 46 954, tax point = check-out 23 Feb) + INV-2 (267 857 / 32 143, check-out 14 Feb)
    expect(decided.a5.base12Hal).toBe(11_060_926 + 391_284 + 267_857);
    expect(decided.a5.vat12Hal).toBe(1_327_312 + 46_954 + 32_143);
    const dup = decided.flags.find((f) => f.code === 'DOUBLE_RECORDED')?.items?.[0];
    expect(dup).toMatchObject({ decision: 'separate', decided: true });
  });

  it('uses the OTA’s own documents when entered', () => {
    const withDocs = computeVatMonth(input({ settings: settings({ otaDocuments: { b1: [{ number: '1000-123', date: '2027-02-28', amountHal: 1_780_000 }] } }) }));
    const row = withDocs.a2.find((a) => a.settlementGroupId === 'b1');
    expect(row).toMatchObject({ documentNumber: '1000-123', baseHal: 1_780_000, vatHal: 373_800, source: 'ota_document' });
    expect(codes(withDocs)).toContain('info:OTA_DOC_DIFF');
  });
});

describe('vat/engine — periods and simulation', () => {
  it('marks months before registration as a simulation', () => {
    const r = computeVatMonth(input({ settings: { ...settings(), config: { ...DEFAULT_VAT_CONFIG, payerFrom: null } } }));
    expect(r.mode).toBe('simulation');
    expect(codes(r)).toContain('info:SIMULATION');
    expect(codes(r)).toContain('info:OTA_DOC_MISSING');
  });

  it('counts only from the registration date in the first month', () => {
    const r = computeVatMonth(input({ settings: { ...settings(), config: { ...DEFAULT_VAT_CONFIG, payerFrom: '2027-02-15' } } }));
    expect(r.mode).toBe('live');
    expect(r.periodStart).toBe('2027-02-15');
    expect(r.revenue.lines.every((l) => l.taxPoint >= '2027-02-15')).toBe(true);
    expect(r.b3.docs).toHaveLength(0); // all Czech purchases were before the 15th
    expect(codes(r)).toContain('error:SETTLEMENT_PARTIAL_PERIOD');
    expect(codes(r)).toContain('warning:PARTIAL_PERIOD');
  });

  it('flags a missing settlement in a closed month', () => {
    const base = input();
    const r = computeVatMonth({ ...base, month: '2027-03', today: '2027-04-10',
      settlements: [...base.settlements], supplierInvoices: [], revenueInvoices: [], stripePayments: [], refunds: [] });
    expect(codes(r)).toContain('error:SETTLEMENT_MISSING');
  });
});

describe('vat/engine — data-quality regressions found on live data', () => {
  it('does not move an old invoice to the month it was finally paid', () => {
    const base = input();
    const late = { id: 'old', number: 'FV/2025/89', date: '2025-11-30', amountHal: 1_800_000, category: 'other_services', sourceType: 'manual',
      reservationNumber: null, clientName: 'Someone', guestName: null, settlementGroupId: null, paidDate: '2027-02-11' };
    const r = computeVatMonth({ ...base, revenueInvoices: [...base.revenueInvoices, late] });
    expect(r.revenue.lines.find((l) => l.id === 'inv:old')).toBeUndefined();
    const all = buildRevenue({ ...base, revenueInvoices: [late] });
    expect(all.items.find((i) => i.id === 'inv:old')?.taxPoint).toBe('2025-11-30');
  });

  it('flags a CZK record from a supplier that otherwise bills in EUR', () => {
    const base = input();
    const r = computeVatMonth({
      ...base,
      supplierInvoices: [
        sup({ id: 'g1', supplierName: 'Google Cloud EMEA Limited', supplierIco: 'IE66988070', invoiceNumber: 'G-1', date: '2027-02-01', amountMinor: 680, category: 'software' }),
        sup({ id: 'g2', supplierName: 'Google Cloud EMEA Limited', supplierIco: 'IE3668997OH', invoiceNumber: 'G-2', date: '2027-01-31', currency: 'EUR', amountMinor: 680, category: 'software' }),
      ],
    });
    expect(codes(r)).toContain('warning:CURRENCY_SUSPECT');
  });
});

describe('vat/engine — registration threshold', () => {
  it('finds the month the 2 000 000 / 2 536 500 Kč limits were crossed', () => {
    const settlementsPerMonth = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      return { id: `s${m}`, name: `Booking ${m}`, source: 'booking' as const, periodStart: `2026-${m}-01`, periodEnd: `2026-${m}-28`, grossHal: 40_000_000, commissionHal: 0, adjustmentsHal: null };
    });
    const rev = buildRevenue({ ...input(), settlements: settlementsPerMonth, revenueInvoices: [], stripePayments: [], refunds: [] });
    const t = computeThreshold(rev, 2026);
    // 400 000 Kč / month → 2 000 000 reached at the end of May (not exceeded), exceeded in June; 2 536 500 exceeded in July
    expect(t.crossedStandard).toBe('2026-06');
    expect(t.crossedImmediate).toBe('2026-07');
    expect(thresholdFlags(t, null).map((f) => f.code)).toEqual(['THRESHOLD_IMMEDIATE']);
    expect(thresholdFlags(t, '2026-07-20')).toEqual([]);
  });
});
