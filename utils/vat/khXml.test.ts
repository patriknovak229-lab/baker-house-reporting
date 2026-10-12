/**
 * The generated EPO XML must validate against the official XSDs (vendored in
 * utils/vat/xsd). A file that breaks the published structure is legally
 * "neúčinné" — treated as never filed — so this is the most important test.
 * Uses xmllint (macOS / most Linux have it); skipped when unavailable.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDpXml, buildKhXml, khXmlIssues } from './khXml';
import { computeVatMonth } from './engine';
import { DEFAULT_VAT_CONFIG } from './config';
import type { VatConfig, VatMonthResult } from '@/types/vat';

const XSD_DIR = join(dirname(fileURLToPath(import.meta.url)), 'xsd');

function hasXmllint(): boolean {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function validate(xml: string, xsd: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'vat-xml-'));
  const file = join(dir, 'doc.xml');
  writeFileSync(file, xml, 'utf8');
  execFileSync('xmllint', ['--noout', '--schema', join(XSD_DIR, xsd), file], { stdio: 'pipe' });
}

const cfg: VatConfig = {
  ...DEFAULT_VAT_CONFIG, payerFrom: '2027-01-01',
  signerFirstName: 'Test', signerLastName: 'Jednatel', compilerFirstName: 'Test', compilerLastName: 'Účetní', compilerPhone: '+420123456789', email: 'dph@example.cz',
};

function sample(): VatMonthResult {
  return computeVatMonth({
    month: '2027-02', today: '2027-03-10',
    settings: { config: cfg, otaDocuments: {}, decisions: {} },
    fx: (cur) => (cur === 'EUR' ? { rateMilli: 24250, unit: 1, fixingDate: '2027-02-01' } : null),
    settlements: [
      { id: 'b1', name: 'Booking.com February 2027', source: 'booking', periodStart: '2027-02-01', periodEnd: '2027-02-28', grossHal: 10_000_000, commissionHal: 1_800_000, adjustmentsHal: null },
    ],
    revenueInvoices: [
      { id: 'r3', number: 'INV-3', date: '2027-02-15', amountHal: 121_000, category: 'other_services', sourceType: 'manual', reservationNumber: null, clientName: null, guestName: null, settlementGroupId: null, paidDate: null },
    ],
    stripePayments: [], refunds: [], reservations: {},
    supplierInvoices: [
      { id: 'd1', supplierName: 'Shop s.r.o.', supplierIco: '64945880', invoiceNumber: 'P-1', date: '2027-02-03', invoiceDate: '2027-02-03', dueDate: null, currency: 'CZK',
        amountMinor: 317_440, vatMinor: 45_381, breakdown: [{ rate: 12, baseMinor: 130_571, vatMinor: 15_669 }, { rate: 21, baseMinor: 141_488, vatMinor: 29_712 }],
        category: 'consumables', creditNote: false, status: 'reconciled', settlementGroupId: null, paid: true },
      { id: 'd3', supplierName: 'Dodavatel s.r.o.', supplierIco: '12345679', invoiceNumber: 'FV-2027/0042', date: '2027-02-10', invoiceDate: '2027-02-10', dueDate: null, currency: 'CZK',
        amountMinor: 1_452_000, vatMinor: 252_000, breakdown: [{ rate: 21, baseMinor: 1_200_000, vatMinor: 252_000 }],
        category: 'services', creditNote: false, status: 'reconciled', settlementGroupId: null, paid: true },
      { id: 'f1', supplierName: 'Beds24 GmbH', supplierIco: 'DE328454604', invoiceNumber: 'B-1', date: '2027-02-01', invoiceDate: '2027-02-01', dueDate: null, currency: 'EUR',
        amountMinor: 5_935, vatMinor: 0, breakdown: null, category: 'software', creditNote: false, status: 'reconciled', settlementGroupId: null, paid: true },
    ],
  });
}

describe('vat/khXml', () => {
  const r = sample();
  const kh = buildKhXml(r, cfg, { preparedOn: '2027-03-10' });
  const dp = buildDpXml(r, cfg, { preparedOn: '2027-03-10' });

  it('writes the control statement with the right sections and values', () => {
    expect(kh).toContain('<VetaD dokument="KH1" k_uladis="DPH" rok="2027" mesic="2" khdph_forma="B" d_poddp="10.03.2027"/>');
    expect(kh).toContain('dic="19876106"');
    expect(kh).not.toMatch(/dic(_dod|_odb)?="CZ/);
    expect(kh).toContain('<VetaA2 c_radku="1" k_stat="DE" vatid_dod="328454604" c_evid_dd="B-1" dppd="01.02.2027" zakl_dane1="1439.24" dan1="302.24"/>');
    expect(kh).toContain('k_stat="NL" vatid_dod="805734958B01" dppd="28.02.2027" zakl_dane1="18000.00" dan1="3780.00"');
    expect(kh).toContain('<VetaB2 c_radku="1" dic_dod="12345679" c_evid_dd="FV-2027/0042" dppd="10.02.2027" zakl_dane1="12000.00" dan1="2520.00" pomer="N" zdph_44="N"/>');
    expect(kh).toContain('<VetaB3 zakl_dane1="1414.88" dan1="297.12" zakl_dane2="1305.71" dan2="156.69"/>');
    expect(kh).toMatch(/<VetaC obrat23="1000.00" obrat5="89285.71" pln23="13414.88" pln5="1305.71" celk_zd_a2="19439.24"\/>/);
    expect(kh.indexOf('<VetaA2')).toBeLessThan(kh.indexOf('<VetaA5'));
    expect(kh.indexOf('<VetaB2')).toBeLessThan(kh.indexOf('<VetaB3'));
  });

  it('writes the VAT return in whole crowns', () => {
    expect(dp).toContain('dokument="DP3" k_uladis="DPH" rok="2027" mesic="2" dapdph_forma="B" typ_platce="P" trans="A"');
    expect(dp).toContain('<Veta1 obrat23="1000" dan23="210" obrat5="89286" dan5="10714" p_sl23_e="19439" dan_psl23_e="4082"/>');
    expect(dp).toContain('<Veta4 pln23="13415" odp_tuz23_nar="2817" pln5="1306" odp_tuz5_nar="157" nar_zdp23="19439" od_zdp23="4082" odp_sum_nar="7056"/>');
    expect(dp).toContain('<Veta6 dan_zocelk="15006" odp_zocelk="7056" dano_da="7950"/>');
  });

  it.skipIf(!hasXmllint())('validates against the official XSDs', () => {
    expect(() => validate(kh, 'dphkh1_epo2.xsd')).not.toThrow();
    expect(() => validate(dp, 'dphdp3_epo2.xsd')).not.toThrow();
  });

  it.skipIf(!hasXmllint())('the XSD check really rejects a broken file', () => {
    expect(() => validate(kh.replace('dic_dod="12345679"', 'dic_dod="CZ12345679"'), 'dphkh1_epo2.xsd')).toThrow();
  });

  it('reports values that would break the format before generating', () => {
    const broken: VatMonthResult = { ...r, b2: [{ ...r.b2[0], ico: null, documentNumber: 'X'.repeat(61) }] };
    const issues = khXmlIssues(broken, { ...cfg, dic: 'CZ19876106', signerLastName: 'Y'.repeat(37) });
    const labels = issues.map((i) => i.label).join(' | ');
    expect(labels).toContain('Company DIČ');
    expect(labels).toContain('Signer last name');
    expect(issues.filter((i) => i.label.startsWith('B.2'))).toHaveLength(2);
  });

  it('marks simulation files', () => {
    const sim = computeVatMonth({ ...sampleInputForSimulation() });
    expect(buildKhXml(sim, cfg, { preparedOn: '2027-03-10' })).toContain('<!-- SIMULATION DPHKH1 2027-02');
  });
});

function sampleInputForSimulation() {
  return {
    month: '2027-02', today: '2027-03-10',
    settings: { config: { ...cfg, payerFrom: null }, otaDocuments: {}, decisions: {} },
    fx: () => null, settlements: [], revenueInvoices: [], stripePayments: [], refunds: [], reservations: {}, supplierInvoices: [],
  };
}
