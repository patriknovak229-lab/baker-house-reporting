import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  addFunnel,
  bucketOf,
  bucketRows,
  dayList,
  funnelDayKey,
  funnelFromMetrics,
  funnelSearchesKey,
  parseCounterHash,
  parseGaReport,
  parseSearchRecord,
  rate,
  resolveSyncRange,
  roomCounters,
  EMPTY_FUNNEL,
} from './webFunnel';

describe('Redis contract (mirrors rental-site src/lib/funnel-events.ts)', () => {
  it('builds the same keys the site writes', () => {
    expect(funnelDayKey('bh:funnel', '2026-10-26')).toBe('bh:funnel:d:2026-10-26');
    expect(funnelSearchesKey('bh:funnel', '2026-10-26')).toBe('bh:funnel:s:2026-10-26');
  });
});

describe('parseCounterHash', () => {
  it('accepts both number and numeric-string values (Upstash deserialises some)', () => {
    const rows = parseCounterHash('2026-10-26', {
      view_item_list: 2,
      'view_item_list|lang=cs': '2',
      'select_item|room=679714': 1,
      'select_item|method=preselected': 1,
      'purchase|value': '6343',
      _accepted: 7,
      '_dropped|bot': 1,
    });
    expect(rows).toHaveLength(7);
    expect(rows.find((r) => r.metric === 'purchase|value')).toEqual({
      day: '2026-10-26',
      metric: 'purchase|value',
      value: 6343,
    });
  });

  it('skips fields that are not ours and values that are not counts', () => {
    const rows = parseCounterHash('2026-10-26', {
      view_item_list: 3,
      'Robert"); DROP TABLE': 1,
      'select_item|room=1 OR 1': 1,
      begin_checkout: -4,
      add_payment_info: 'abc',
    });
    expect(rows.map((r) => r.metric)).toEqual(['view_item_list']);
  });

  it('treats an expired / missing day as nothing to copy', () => {
    expect(parseCounterHash('2026-10-26', null)).toEqual([]);
    expect(parseCounterHash('2026-10-26', [])).toEqual([]);
  });
});

describe('parseSearchRecord', () => {
  it('parses an already-deserialised record (what Upstash returns)', () => {
    expect(
      parseSearchRecord('2026-10-26', 0, {
        e: 'v',
        a: '2026-11-10',
        d: '2026-11-12',
        ad: 2,
        ch: 0,
        o: 4,
        r: [648816, 656437, 674672, 679714],
        l: 'cs',
      }),
    ).toEqual({
      day: '2026-10-26',
      seq: 0,
      kind: 'offers',
      arrival: '2026-11-10',
      departure: '2026-11-12',
      nights: 2,
      adults: 2,
      children: 0,
      offersCount: 4,
      rooms: [648816, 656437, 674672, 679714],
      lang: 'cs',
    });
  });

  it('parses a JSON string too, and maps "n" to no availability', () => {
    const row = parseSearchRecord(
      '2026-10-26',
      2,
      '{"e":"n","a":"2026-12-30","d":"2027-01-02","ad":6,"ch":4,"o":0,"r":[],"l":"en"}',
    );
    expect(row?.kind).toBe('none');
    expect(row?.nights).toBe(3);
    expect(row?.seq).toBe(2);
  });

  it('rejects malformed records instead of storing junk', () => {
    const base = { e: 'v', a: '2026-11-10', d: '2026-11-12', ad: 2, ch: 0, o: 1, r: [] };
    expect(parseSearchRecord('d', 0, '{not json')).toBeNull();
    expect(parseSearchRecord('d', 0, { ...base, e: 'x' })).toBeNull();
    expect(parseSearchRecord('d', 0, { ...base, d: '2026-11-10' })).toBeNull(); // 0 nights
    expect(parseSearchRecord('d', 0, { ...base, a: '2026-02-30' })).toBeNull();
    expect(parseSearchRecord('d', 0, { ...base, ad: 2.5 })).toBeNull();
    expect(parseSearchRecord('d', 0, { ...base, ad: 99 })).toBeNull();
  });
});

describe('funnelFromMetrics', () => {
  const metrics = {
    view_item_list: 40,
    no_availability: 10,
    select_item: 30,
    begin_checkout: 12,
    add_payment_info: 5,
    'add_payment_info|value': 25_000,
    purchase: 3,
    'purchase|value': 16_000,
    generate_lead: 1,
    'view_item_list|lang=en': 15,
    'no_availability|lang=en': 5,
    'begin_checkout|lang=en': 4,
  };

  it('adds offers-shown and no-availability up to searches', () => {
    const f = funnelFromMetrics(metrics);
    expect(f.searches).toBe(50);
    expect(f.offersShown).toBe(40);
    expect(f.contactForm).toBe(12);
    expect(f.toStripe).toBe(5);
    expect(f.confirmed).toBe(3);
    expect(f.toStripeValue).toBe(25_000);
  });

  it('slices by language, without values (those are not split by language)', () => {
    const en = funnelFromMetrics(metrics, '|lang=en');
    expect(en.searches).toBe(20);
    expect(en.contactForm).toBe(4);
    expect(en.toStripeValue).toBe(0);
  });

  it('sums funnels field by field', () => {
    const f = funnelFromMetrics(metrics);
    expect(addFunnel(f, f).searches).toBe(100);
    expect(addFunnel(EMPTY_FUNNEL, f)).toEqual(f);
  });

  it('groups room counters by Beds24 room id', () => {
    expect(
      roomCounters({ 'select_item|room=679714': 3, 'purchase|room=679714': 1, 'view_item_list|room=648816': 9, select_item: 3 }),
    ).toEqual({ '679714': { select_item: 3, purchase: 1 }, '648816': { view_item_list: 9 } });
  });

  it('has no conversion rate when nothing came in', () => {
    expect(rate(1, 0)).toBeNull();
    expect(rate(1, 4)).toBe(0.25);
  });
});

describe('bucketing', () => {
  it('puts a day into its ISO week (Monday) and month', () => {
    expect(bucketOf('2026-10-26', 'week')).toBe('2026-10-26'); // a Monday
    expect(bucketOf('2026-11-01', 'week')).toBe('2026-10-26'); // the Sunday after
    expect(bucketOf('2026-11-01', 'month')).toBe('2026-11');
    expect(bucketOf('2026-11-01', 'day')).toBe('2026-11-01');
  });

  it('sums rows per bucket in date order', () => {
    const rows = dayList('2026-10-30', '2026-11-02').map((day) => ({ day, n: 1 }));
    const weeks = bucketRows(rows, 'week', (a, b) => ({ ...a, n: a.n + b.n }));
    expect(weeks.map((w) => [w.bucket, w.n])).toEqual([
      ['2026-10-26', 3],
      ['2026-11-02', 1],
    ]);
  });
});

describe('resolveSyncRange', () => {
  const opts = { todayIso: '2026-10-26', defaultBackDays: 3, maxDays: 180 };

  it('defaults to the last few days through today', () => {
    expect(resolveSyncRange({ from: null, to: null }, opts)).toEqual({ from: '2026-10-23', to: '2026-10-26' });
  });

  it('can end the default window before today (GA keeps revising recent days)', () => {
    expect(
      resolveSyncRange({ from: null, to: null }, { ...opts, defaultBackDays: 4, defaultEndBackDays: 1 }),
    ).toEqual({ from: '2026-10-22', to: '2026-10-25' });
  });

  it('takes an explicit backfill window', () => {
    expect(resolveSyncRange({ from: '2026-09-01', to: '2026-09-30' }, opts)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('rejects bad, inverted, future and oversized windows rather than clamping them', () => {
    expect(resolveSyncRange({ from: '2026-9-1', to: null }, opts)).toHaveProperty('error');
    expect(resolveSyncRange({ from: null, to: '2026-10-01' }, opts)).toHaveProperty('error');
    expect(resolveSyncRange({ from: '2026-10-20', to: '2026-10-10' }, opts)).toHaveProperty('error');
    expect(resolveSyncRange({ from: '2026-10-20', to: '2026-10-27' }, opts)).toHaveProperty('error');
    expect(resolveSyncRange({ from: '2026-01-01', to: '2026-10-26' }, opts)).toHaveProperty('error');
  });
});

describe('parseGaReport', () => {
  it('matches columns by header name and converts GA dates', () => {
    const rows = parseGaReport({
      dimensionHeaders: [{ name: 'sessionSourceMedium' }, { name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
      metricHeaders: [
        { name: 'totalUsers' },
        { name: 'sessions' },
        { name: 'purchaseRevenue' },
        { name: 'ecommercePurchases' },
      ],
      rows: [
        {
          dimensionValues: [{ value: 'google / organic' }, { value: '20261025' }, { value: 'Organic Search' }],
          metricValues: [{ value: '11' }, { value: '14' }, { value: '9150.5' }, { value: '1' }],
        },
        {
          dimensionValues: [{ value: '' }, { value: 'bad' }, { value: 'Direct' }],
          metricValues: [{ value: '1' }, { value: '1' }, { value: '0' }, { value: '0' }],
        },
      ],
    });
    expect(rows).toEqual([
      {
        day: '2026-10-25',
        channelGroup: 'Organic Search',
        sourceMedium: 'google / organic',
        sessions: 14,
        totalUsers: 11,
        purchases: 1,
        purchaseRevenue: 9150.5,
      },
    ]);
  });

  it('copes with an empty report', () => {
    expect(parseGaReport({})).toEqual([]);
  });
});

describe('cron wiring', () => {
  // Each of these has failed silently in this repo before: a cron in vercel.json
  // that proxy.ts still 307s to /login never runs, and nothing errors.
  it('exempts every scheduled cron path from the auth middleware, except the payments job', () => {
    const root = join(__dirname, '..');
    const crons = (JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { crons: { path: string }[] }).crons;
    const proxy = readFileSync(join(root, 'proxy.ts'), 'utf8');
    const matcher = /matcher:\s*\['([^']+)'\]/.exec(proxy)?.[1] ?? '';
    for (const { path } of crons) {
      const exempt = matcher.includes(`|${path.slice(1)}|`) || matcher.includes(`|${path.slice(1)})`);
      if (path === '/api/cron/send-scheduled-payments') expect(exempt, path).toBe(false);
      else expect(exempt, path).toBe(true);
    }
    expect(crons.map((c) => c.path)).toContain('/api/cron/web-funnel-sync');
    expect(crons.map((c) => c.path)).toContain('/api/cron/ga-traffic-sync');
  });
});
