import { describe, it, expect } from 'vitest';
import { sanitizeVatSettings } from '@/data-access/vatSettings';

describe('vat settings sanitiser', () => {
  it('fills defaults and keeps valid values', () => {
    const s = sanitizeVatSettings({ config: { payerFrom: '2026-09-20', signerLastName: '  Novák  ' } });
    expect(s.config.payerFrom).toBe('2026-09-20');
    expect(s.config.signerLastName).toBe('Novák');
    expect(s.config.dic).toBe('19876106');
    expect(s.otaDocuments).toEqual({});
  });

  it('rejects invalid registration dates and OTA documents', () => {
    expect(() => sanitizeVatSettings({ config: { payerFrom: '2026-13-01' } })).toThrow();
    expect(() => sanitizeVatSettings({ otaDocuments: { g1: [{ number: '1000-1', date: '2026-07-31', amountHal: 12.5 }] } })).toThrow();
    expect(() => sanitizeVatSettings({ otaDocuments: { g1: [{ number: 'X'.repeat(61), date: '2026-07-31', amountHal: 1 }] } })).toThrow();
  });

  it('drops empty documents and unknown decisions', () => {
    const s = sanitizeVatSettings({
      otaDocuments: { g1: [{ number: ' ', date: '2026-07-31', amountHal: 1 }], g2: [{ number: '1000-2', date: '2026-07-31', amountHal: 6331229 }] },
      decisions: { 'dup:a': 'merge', 'dup:b': 'whatever' },
    });
    expect(Object.keys(s.otaDocuments)).toEqual(['g2']);
    expect(s.decisions).toEqual({ 'dup:a': 'merge' });
  });
});
