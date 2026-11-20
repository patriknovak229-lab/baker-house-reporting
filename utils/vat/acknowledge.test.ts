import { describe, expect, it } from 'vitest';
import type { VatFlag } from '@/types/vat';
import { applyAcknowledgements, flagAckKey } from './acknowledge';

const flag = (over: Partial<VatFlag> = {}): VatFlag => ({ code: 'X', severity: 'warning', title: 'T', items: [{ label: 'a' }, { label: 'b' }], ...over });

describe('VAT flag acknowledgements', () => {
  it('key ignores item order and amounts, but changes with a new item', () => {
    const k = flagAckKey(flag());
    expect(flagAckKey(flag({ items: [{ label: 'b', amountHal: 5 }, { label: 'a' }] }))).toBe(k);
    expect(flagAckKey(flag({ items: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }))).not.toBe(k);
  });
  it('marks confirmed warnings, never errors, and sinks them', () => {
    const w = flag(); const e = flag({ code: 'E', severity: 'error' }); const i = flag({ code: 'I', severity: 'info' });
    const flags = [w, e, i];
    applyAcknowledgements(flags, { [flagAckKey(w)]: { at: '2026-11-20T10:00:00Z', by: 'admin' } });
    expect(e.ackKey).toBeUndefined();
    expect(flags.map((f) => f.code)).toEqual(['E', 'I', 'X']);
    expect(w.acknowledged?.by).toBe('admin');
  });
});
