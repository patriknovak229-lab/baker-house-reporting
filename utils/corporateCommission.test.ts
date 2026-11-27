import { describe, it, expect } from 'vitest';
import {
  agreementCommissionCzk,
  commissionCzk,
  describeCommissionSync,
  planCommissionSync,
  type LiveBookingMoney,
} from './corporateCommission';
import { parseAgreementPatch, parseCommissionPercent } from './corporateInput';
import type { CorporateStay } from './corporateShared';

type SyncStay = Pick<CorporateStay, 'id' | 'seq' | 'status' | 'beds24BookingId' | 'reservationNumber'>;

const stay = (seq: number, bookingId: number | null, status: CorporateStay['status'] = 'created'): SyncStay => ({
  id: `CS-x-${seq}`,
  seq,
  status,
  beds24BookingId: bookingId,
  reservationNumber: bookingId ? `BH-${bookingId}` : null,
});

const live = (...rows: LiveBookingMoney[]) => new Map(rows.map((r) => [r.id, r]));

describe('commissionCzk', () => {
  it('is the % of the price, to the haléř', () => {
    expect(commissionCzk(16321, 10)).toBe(1632.1);
    expect(commissionCzk(143485, 10)).toBe(14348.5);
    expect(commissionCzk(3700, 12.5)).toBe(462.5);
  });

  it('is 0 without a price or a %', () => {
    expect(commissionCzk(null, 10)).toBe(0);
    expect(commissionCzk(0, 10)).toBe(0);
    expect(commissionCzk(5000, 0)).toBe(0);
  });
});

describe('agreementCommissionCzk', () => {
  it('counts planned, created and failed stays only', () => {
    const stays = [
      { status: 'created' as const, priceCzk: 16321 },
      { status: 'planned' as const, priceCzk: 1000 },
      { status: 'failed' as const, priceCzk: 1000 },
      { status: 'skipped' as const, priceCzk: 9999 },
      { status: 'cancelled' as const, priceCzk: 9999 },
      { status: 'planned' as const, priceCzk: null },
    ];
    expect(agreementCommissionCzk(stays, 10)).toBe(1832.1);
    expect(agreementCommissionCzk(stays, 0)).toBe(0);
  });
});

describe('planCommissionSync', () => {
  it('targets % × the LIVE Beds24 price, not the frozen stay price', () => {
    const [item] = planCommissionSync([stay(1, 101)], live({ id: 101, price: 15000, commission: 0, status: 'confirmed' }), 10);
    expect(item).toMatchObject({ bookingId: 101, priceCzk: 15000, currentCzk: 0, targetCzk: 1500, action: 'update' });
  });

  it('is in sync when Beds24 already holds the figure (rounding noise ignored)', () => {
    const [item] = planCommissionSync([stay(1, 101)], live({ id: 101, price: 16321, commission: 1632.1000001, status: 'confirmed' }), 10);
    expect(item.action).toBe('in-sync');
  });

  it('clears a commission when the % drops to 0', () => {
    const [item] = planCommissionSync([stay(1, 101)], live({ id: 101, price: 16321, commission: 1632.1, status: 'confirmed' }), 0);
    expect(item).toMatchObject({ targetCzk: 0, action: 'update' });
  });

  it('skips stays that are not created; flags cancelled and missing bookings', () => {
    const items = planCommissionSync(
      [stay(1, 101), stay(2, 102), stay(3, null, 'planned'), stay(4, 104, 'cancelled')],
      live({ id: 101, price: 5000, commission: 0, status: 'cancelled' }),
      10,
    );
    expect(items.map((i) => [i.seq, i.action])).toEqual([
      [1, 'cancelled'],
      [2, 'missing'],
    ]);
  });
});

describe('describeCommissionSync', () => {
  it('summarises the state in one line', () => {
    const inSync = planCommissionSync([stay(1, 101)], live({ id: 101, price: 1000, commission: 100, status: 'confirmed' }), 10);
    expect(describeCommissionSync(inSync)).toEqual({ tone: 'ok', text: 'Beds24 matches on 1 booking' });
    const drift = planCommissionSync(
      [stay(1, 101), stay(2, 102)],
      live({ id: 101, price: 1000, commission: 0, status: 'confirmed' }),
      10,
    );
    expect(describeCommissionSync(drift)).toEqual({ tone: 'warn', text: '1 booking not updated in Beds24 · 1 booking not found in Beds24' });
    expect(describeCommissionSync([]).tone).toBe('none');
  });
});

describe('parseCommissionPercent', () => {
  it('accepts blanks as 0, decimals with a comma, and rounds to 2 places', () => {
    expect(parseCommissionPercent(undefined)).toEqual({ ok: true, value: 0 });
    expect(parseCommissionPercent('')).toEqual({ ok: true, value: 0 });
    expect(parseCommissionPercent('12,5')).toEqual({ ok: true, value: 12.5 });
    expect(parseCommissionPercent(7.333)).toEqual({ ok: true, value: 7.33 });
  });

  it('rejects negatives, typos above the cap and text', () => {
    expect(parseCommissionPercent(-1).ok).toBe(false);
    expect(parseCommissionPercent(150).ok).toBe(false);
    expect(parseCommissionPercent('ten').ok).toBe(false);
  });

  it('is editable after saving (unlike pricing)', () => {
    const r = parseAgreementPatch({ commissionPercent: '10' });
    expect(r.ok && r.value.commissionPercent).toBe(10);
    expect(parseAgreementPatch({ commissionPercent: 80 }).ok).toBe(false);
  });
});
