import { describe, it, expect } from 'vitest';
import {
  gapAlertDue,
  gapAlertText,
  planGapAlerts,
  refreshSummary,
  stalestListingAge,
  type RefreshedListing,
} from './marketRefreshHealth';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const ok = (unitId: string): RefreshedListing => ({ unitId, error: null, errorKind: null });
const gap = (unitId: string): RefreshedListing => ({
  unitId,
  error: 'PriceLabs listing_prices unusable (LISTING_NO_DATA: Listing data does not exist in PriceLabs)',
  errorKind: 'upstream-gap',
});
const broken = (unitId: string): RefreshedListing => ({ unitId, error: 'fetch failed', errorKind: 'error' });

describe('refreshSummary', () => {
  it('a clean pull completes', () => {
    expect(refreshSummary([ok('urban-1kk'), ok('k201')])).toEqual({ phase: 'completed', listings: 2, failedListings: 0 });
  });

  it('the 9 Nov case: a PriceLabs gap alone completes the run as degraded, not failed', () => {
    const s = refreshSummary([gap('urban-1kk'), ok('deluxe-1kk'), ok('k201'), ok('o308')]);
    expect(s.phase).toBe('completed');
    expect(s.degraded).toEqual(['urban-1kk']);
    expect(s.degradedDetail).toContain('1 of 4 listings had no PriceLabs data — urban-1kk: ');
    expect(s.error).toBeUndefined();
  });

  it('a broken pull fails the run and still records the gaps', () => {
    const s = refreshSummary([broken('k201'), gap('o308'), ok('urban-1kk')]);
    expect(s.phase).toBe('failed');
    expect(s.failedListings).toBe(1);
    expect(s.error).toBe('1 of 3 listings failed — k201: fetch failed');
    expect(s.degraded).toEqual(['o308']);
  });

  it('an error without a kind (older callers) counts as broken, never as a gap', () => {
    expect(refreshSummary([{ unitId: 'k201', error: 'boom' }]).phase).toBe('failed');
  });
});

describe('stalestListingAge', () => {
  it('the 8 Nov case: one fresh listing must not hide three stale ones', () => {
    expect(stalestListingAge({ 'urban-1kk': 2.2, 'deluxe-1kk': 29, k201: 29, o308: 29 })).toBe(29);
  });

  it('a listing that never had a good pull makes the whole snapshot stale', () => {
    expect(stalestListingAge({ 'urban-1kk': 1, k201: null })).toBeNull();
    expect(stalestListingAge({})).toBeNull();
  });
});

describe('planGapAlerts', () => {
  const now = new Date('2026-11-09T06:53:00Z');
  const ages = { 'urban-1kk': 30, k201: 2, o308: 30 };
  const after24h = (h: number | null) => h === null || h >= 24; // stand-in rule for the tests

  it('announces a gap once it is due, and only then', () => {
    const { alerts, next } = planGapAlerts({}, [gap('urban-1kk'), gap('k201')], ages, now, after24h);
    expect(alerts.map((a) => a.unitId)).toEqual(['urban-1kk']);
    expect(next).toEqual({ 'urban-1kk': now.toISOString() });
  });

  it('stays quiet while the same gap persists', () => {
    const state = { 'urban-1kk': '2026-11-08T06:53:00.000Z' };
    const { alerts, next } = planGapAlerts(state, [gap('urban-1kk')], ages, now, after24h);
    expect(alerts).toEqual([]);
    expect(next).toEqual(state);
  });

  it('a good pull ends the gap and re-arms the alert; a broken pull does not', () => {
    const state = { 'urban-1kk': '2026-11-08T06:53:00.000Z', o308: '2026-11-08T06:53:00.000Z' };
    const { alerts, next } = planGapAlerts(state, [ok('urban-1kk'), broken('o308')], ages, now, after24h);
    expect(alerts).toEqual([]);
    expect(next).toEqual({ o308: '2026-11-08T06:53:00.000Z' });
  });

  it('a broken pull is never announced as a gap (the failed run has its own alert)', () => {
    expect(planGapAlerts({}, [broken('o308')], ages, now, () => true).alerts).toEqual([]);
  });
});

describe('gapAlertDue', () => {
  it('stays quiet through a Monday gap and its same-week retries', () => {
    expect(gapAlertDue(168)).toBe(false); // Monday run, last good pull the previous Monday
    expect(gapAlertDue(174)).toBe(false); // Monday 12:45 retry
  });

  it('speaks once a listing is more than a day past its weekly pull, or was never pulled', () => {
    expect(gapAlertDue(198)).toBe(true); // Tuesday 12:45, third failed attempt
    expect(gapAlertDue(null)).toBe(true);
  });
});

describe('gapAlertText', () => {
  it('says nothing when there is nothing to announce', () => {
    expect(gapAlertText([], esc)).toBeNull();
  });

  it('names the listing, how stale it is, and escapes the upstream text', () => {
    const text = gapAlertText(
      [
        { unitId: 'urban-1kk', hoursSinceGoodPull: 30.4, error: 'unusable <LISTING_NO_DATA>' },
        { unitId: 'k201', hoursSinceGoodPull: null, error: 'x' },
      ],
      esc,
    )!;
    expect(text).toContain('• urban-1kk — last good pull 30h ago: unusable &lt;LISTING_NO_DATA&gt;');
    expect(text).toContain('• k201 — never pulled: x');
  });
});
