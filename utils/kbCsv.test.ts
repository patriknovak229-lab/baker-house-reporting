import { describe, expect, it } from 'vitest';
import type { BankTransaction } from '@/types/bankTransaction';
import { decodeCsvBytes, makeTxId, parseKbCsv, selectNewRows } from './kbCsv';

// Windows-1250 bytes for the Czech letters used below
function cp1250(s: string): Uint8Array {
  const map: Record<string, number> = { 'í': 0xed, 'ú': 0xfa, 'Ú': 0xda, 'Á': 0xc1, 'ř': 0xf8, 'ě': 0xec, 'á': 0xe1 };
  return Uint8Array.from([...s].map((c) => map[c] ?? c.charCodeAt(0)));
}

const HEADER = 'Datum zauctovani;Datum provedeni;Protistrana;Nazev protistrany;Castka;Mena;Variabilni symbol;Identifikace transakce;Typ transakce;Zprava pro prijemce';
const ROW = '02.10.2026;02.10.2026;1154630237/0100;ALENA SHORNÁ;-11900;CZK;20260901;8J39R7P2FA5Y4YYY;Odchozí úhrada;Úklid září';

describe('decodeCsvBytes', () => {
  it('decodes KB Windows-1250 exports without mangling Czech letters', () => {
    expect(decodeCsvBytes(cp1250('Odchozí úhrada SHORNÁ'))).toBe('Odchozí úhrada SHORNÁ');
  });
  it('keeps valid UTF-8 as UTF-8', () => {
    expect(decodeCsvBytes(new TextEncoder().encode('Odchozí úhrada'))).toBe('Odchozí úhrada');
  });
});

describe('parseKbCsv', () => {
  it('reads names and the bank id from a Windows-1250 statement', () => {
    const [tx] = parseKbCsv(decodeCsvBytes(cp1250(`${HEADER}\n${ROW}`)));
    expect(tx).toMatchObject({
      id: '8J39R7P2FA5Y4YYY', date: '2026-10-02', amount: 11900, direction: 'debit',
      counterpartyName: 'ALENA SHORNÁ', transactionType: 'Odchozí úhrada', variableSymbol: '20260901', description: 'Úklid září',
    });
  });
});

describe('selectNewRows', () => {
  const base = { date: '2026-06-02', amount: 3135, direction: 'debit' as const, currency: 'CZK', counterpartyAccount: '2701441318/2010', variableSymbol: '2500302', state: 'unmatched' as const, importedAt: '' };
  const legacyId = makeTxId('2026-06-02', 3135, 'debit', '2701441318/2010', '2500302');
  const a: BankTransaction = { ...base, id: '111HKBI58KVX9FVG', description: 'FV2608526 RYWA S.R.O.' };
  const b: BankTransaction = { ...base, id: '0V4AUURT9MRBM876', description: 'FV2610292 RYWA S.R.O.' };

  it('lets a stored legacy row absorb only the statement row with its own message', () => {
    const stored: BankTransaction = { ...base, id: legacyId, description: 'FV2608526 RYWA S.R.O.' };
    expect(selectNewRows([b, a], [stored]).map((t) => t.id)).toEqual(['0V4AUURT9MRBM876']);
  });

  it('skips rows already stored by bank id and rows listed twice', () => {
    expect(selectNewRows([a, a, b], [a]).map((t) => t.id)).toEqual(['0V4AUURT9MRBM876']);
  });

  it('imports both same-day twins when neither is stored', () => {
    expect(selectNewRows([a, b], []).map((t) => t.id)).toEqual([a.id, b.id]);
  });
});
