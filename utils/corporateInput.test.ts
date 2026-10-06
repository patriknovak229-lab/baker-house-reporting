import { describe, it, expect } from 'vitest';
import {
  parseAgreementInput,
  parseAgreementPatch,
  parseStayInputs,
  parseStayPatch,
  materialiseStays,
  type AgreementInput,
} from './corporateInput';
import { generateStays } from './corporateSchedule';

const VALID = {
  companyName: '  Acme s.r.o. ',
  companyAddress: 'Brno',
  ico: '12345678',
  vatNumber: 'CZ12345678',
  billingEmail: 'invoices@acme.cz',
  billingCadence: 'monthly',
  repName: 'Jana Nová',
  repPhone: '+420 777 000 111',
  guestFirstName: 'Petr',
  guestLastName: 'Svoboda',
  adults: 1,
  children: 0,
  nationality: 'cz',
  roomIds: [648816, 679714, 679714],
  preferredRoomId: 679714,
  startDate: '2026-10-12',
  endDate: '2026-12-17',
  nightWeekdays: [2, 1],
  pricingMode: 'dynamic',
  flatNightPriceCzk: 1850,
  discountPercent: '15',
  notes: '',
};

function agreement(overrides: Partial<AgreementInput> = {}): AgreementInput {
  const parsed = parseAgreementInput(VALID);
  if (!parsed.ok) throw new Error(parsed.error);
  return { ...parsed.value, ...overrides };
}

describe('parseAgreementInput', () => {
  it('normalises a valid body', () => {
    const r = parseAgreementInput(VALID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.companyName).toBe('Acme s.r.o.');
    expect(r.value.nationality).toBe('CZ');
    expect(r.value.roomIds).toEqual([648816, 679714]); // deduped
    expect(r.value.nightWeekdays).toEqual([1, 2]); // sorted
    expect(r.value.discountPercent).toBe(15);
    expect(r.value.flatNightPriceCzk).toBeNull(); // dynamic mode ignores the flat rate
    expect(r.value.notes).toBeNull();
    expect(r.value.billingCadence).toBe('monthly');
  });

  it('flat mode keeps the rate and zeroes the discount', () => {
    const r = parseAgreementInput({ ...VALID, pricingMode: 'flat', discountPercent: 20 });
    expect(r.ok && r.value.flatNightPriceCzk).toBe(1850);
    expect(r.ok && r.value.discountPercent).toBe(0);
  });

  it.each([
    [{ companyName: '' }, /Company name/],
    [{ billingCadence: 'yearly' }, /billing cadence/],
    [{ adults: 0 }, /Adults/],
    [{ children: -1 }, /Children/],
    [{ nationality: 'Czechia' }, /2-letter/],
    [{ roomIds: [] }, /at least one suitable room/],
    [{ roomIds: [123] }, /not a sellable room/],
    [{ preferredRoomId: 656437 }, /preferred room type/],
    [{ startDate: '2026-12-17', endDate: '2026-10-12' }, /before/],
    [{ nightWeekdays: [] }, /at least one night/],
    [{ pricingMode: 'auction' }, /flat.*dynamic/],
    [{ pricingMode: 'flat', flatNightPriceCzk: 0 }, /nightly price/],
    [{ discountPercent: 120 }, /Discount/],
  ])('rejects %j', (patch, re) => {
    const r = parseAgreementInput({ ...VALID, ...patch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });

  it('rejects a non-object body', () => {
    expect(parseAgreementInput(null).ok).toBe(false);
    expect(parseAgreementInput('x').ok).toBe(false);
  });
});

describe('parseStayInputs', () => {

  it('accepts rows and defaults include to true', () => {
    const r = parseStayInputs([{ seq: 1, roomId: 679714, priceCzk: '3825', listPriceCzk: 4500, priceSource: 'offers' }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ seq: 1, roomId: 679714, priceCzk: 3825, listPriceCzk: 4500, priceSource: 'offers', include: true });
  });

  it('treats a missing list as no rows', () => {
    expect(parseStayInputs(undefined)).toEqual({ ok: true, value: [] });
  });

  it.each([
    [[{ seq: 0 }], /positive integer seq/],
    [[{ seq: 1 }, { seq: 1 }], /twice/],
    [[{ seq: 1, roomId: 123 }], /not a sellable room/],
    [[{ seq: 1, priceCzk: -5 }], /negative/],
    [[{ seq: 1, priceSource: 'guess' }], /price source/],
    ['nope', /array/],
  ])('rejects %j', (rows, re) => {
    const r = parseStayInputs(rows);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(re);
  });
});

describe('materialiseStays', () => {
  const occ = generateStays({ startDate: '2026-10-12', endDate: '2026-10-27', nightWeekdays: [1, 2] }); // 3 stays

  it('flat: prices every stay from the rate and marks the source', () => {
    const a = agreement({ pricingMode: 'flat', flatNightPriceCzk: 1850, discountPercent: 0 });
    const r = materialiseStays(a, occ, []);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(3);
    expect(r.value.every((s) => s.priceCzk === 3700 && s.priceSource === 'flat' && s.status === 'planned')).toBe(true);
    expect(r.value.every((s) => s.roomId === 679714)).toBe(true); // preferred
  });

  it('dynamic: uses the quoted list price minus discount, keeps the quote source', () => {
    const a = agreement(); // dynamic, 15%
    const r = materialiseStays(a, occ, [{ seq: 2, roomId: null, priceCzk: null, listPriceCzk: 4500, priceSource: 'offers', guestFirstName: null, guestLastName: null, guestPhone: null, guestEmail: null, include: true }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[1]).toMatchObject({ seq: 2, listPriceCzk: 4500, priceCzk: 3825, priceSource: 'offers' });
    // Unquoted stays stay unpriced rather than inventing a number.
    expect(r.value[0].priceCzk).toBeNull();
    expect(r.value[0].priceSource).toBeNull();
  });

  it('an operator-typed price that differs from the rule becomes manual', () => {
    const a = agreement({ pricingMode: 'flat', flatNightPriceCzk: 1850, discountPercent: 0 });
    const r = materialiseStays(a, occ, [{ seq: 1, roomId: 648816, priceCzk: 3000, listPriceCzk: null, priceSource: null, guestFirstName: 'Eva', guestLastName: 'K', guestPhone: null, guestEmail: null, include: true }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]).toMatchObject({ roomId: 648816, priceCzk: 3000, priceSource: 'manual', guestFirstName: 'Eva', guestLastName: 'K' });
  });

  it('an excluded row is saved as skipped', () => {
    const a = agreement({ pricingMode: 'flat', flatNightPriceCzk: 1850, discountPercent: 0 });
    const r = materialiseStays(a, occ, [{ seq: 3, roomId: null, priceCzk: null, listPriceCzk: null, priceSource: null, guestFirstName: null, guestLastName: null, guestPhone: null, guestEmail: null, include: false }]);
    expect(r.ok && r.value[2].status).toBe('skipped');
  });

  it('refuses a row for a seq the pattern does not produce', () => {
    const r = materialiseStays(agreement(), occ, [{ seq: 9, roomId: null, priceCzk: null, listPriceCzk: null, priceSource: null, guestFirstName: null, guestLastName: null, guestPhone: null, guestEmail: null, include: true }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });
});

describe('parseAgreementPatch / parseStayPatch', () => {
  it('agreement patch: subset, status checked, empty refused', () => {
    expect(parseAgreementPatch({})).toMatchObject({ ok: false });
    expect(parseAgreementPatch({ status: 'paused' })).toMatchObject({ ok: false });
    expect(parseAgreementPatch({ companyName: '' })).toMatchObject({ ok: false });
    const r = parseAgreementPatch({ repPhone: ' +420 1 ', notes: '', status: 'completed', billingCadence: 'upfront' });
    expect(r).toEqual({ ok: true, value: { repPhone: '+420 1', notes: null, status: 'completed', billingCadence: 'upfront' } });
  });

  it('stay patch: clears with null, rounds price, checks room and status', () => {
    const r = parseStayPatch({ guestFirstName: null, guestLastName: ' Novák ', priceCzk: '3699.6', roomId: 674672, status: 'skipped' });
    expect(r).toEqual({ ok: true, value: { guestFirstName: null, guestLastName: 'Novák', priceCzk: 3700, roomId: 674672, status: 'skipped' } });
    expect(parseStayPatch({ priceCzk: -1 })).toMatchObject({ ok: false });
    expect(parseStayPatch({ roomId: 1 })).toMatchObject({ ok: false });
    expect(parseStayPatch({ status: 'created' })).toMatchObject({ ok: false });
    expect(parseStayPatch({})).toMatchObject({ ok: false });
  });
});
