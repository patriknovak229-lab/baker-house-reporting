import { describe, it, expect } from 'vitest';
import { upsertFunnelMetrics, upsertFunnelSearches, upsertGaTraffic } from './webFunnelSync';

// drizzle's .toSQL() renders the statement without touching the database, so the
// idempotency contract — re-copying a day overwrites, never duplicates — is
// checkable offline. Without DB env vars lib/db only throws on EXECUTION.

describe('web funnel upserts', () => {
  it('counter rows upsert on (day, metric) and overwrite the value', () => {
    const { sql, params } = upsertFunnelMetrics([
      { day: '2026-10-26', metric: 'view_item_list', value: 2 },
      { day: '2026-10-26', metric: 'purchase|value', value: 6343 },
    ]).toSQL();
    expect(sql).toMatch(/^insert into "web_funnel_daily"/);
    expect(sql).toMatch(/on conflict \("day","metric"\) do update set "value" = excluded\.value, "copied_at" = now\(\)/);
    expect(params).toEqual(expect.arrayContaining(['2026-10-26', 'view_item_list', '2', 'purchase|value', '6343']));
  });

  it('search rows upsert on (day, seq) — the stable position in the append-only list', () => {
    const { sql, params } = upsertFunnelSearches([
      {
        day: '2026-10-26',
        seq: 0,
        kind: 'none',
        arrival: '2026-12-30',
        departure: '2027-01-02',
        nights: 3,
        adults: 6,
        children: 4,
        offersCount: 0,
        rooms: [],
        lang: 'en',
      },
    ]).toSQL();
    expect(sql).toMatch(/^insert into "web_funnel_searches"/);
    expect(sql).toMatch(/on conflict \("day","seq"\) do update set/);
    expect(sql).toContain('"rooms" = excluded.rooms');
    expect(params).toEqual(expect.arrayContaining(['2026-12-30', 'none', 6, 4]));
  });

  it('GA rows upsert on (day, channel, source/medium)', () => {
    const { sql } = upsertGaTraffic([
      {
        day: '2026-10-25',
        channelGroup: 'Organic Search',
        sourceMedium: 'google / organic',
        sessions: 14,
        totalUsers: 11,
        purchases: 1,
        purchaseRevenue: 9150.5,
      },
    ]).toSQL();
    expect(sql).toMatch(/on conflict \("day","channel_group","source_medium"\) do update set/);
    expect(sql).toContain('"fetched_at" = now()');
  });
});
