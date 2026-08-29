/**
 * Price Radar — demand calendar + price-vs-market position, per sellable unit.
 *
 * Everything here is a Postgres read over `market_daily` (the PriceLabs
 * snapshot the 06:30 cron maintains) joined with the curated event calendar.
 * No external call ever happens on a page load; a stale snapshot degrades to
 * a visible vintage warning, never to a hang.
 *
 * DEMAND SEMANTICS — the one subtlety worth internalising: PriceLabs masks the
 * demand level with 'Unavailable' whenever OUR calendar is closed or booked
 * for a night. The night still HAS market demand, we just can't read it from
 * that unit's own row. So the radar derives a per-date CITY demand level = the
 * max demand across all four units (they share one Brno demand curve), and
 * uses that wherever the unit's own reading is masked — most importantly for
 * the "hot date but we're not sellable" flag.
 */
import { and, gte, inArray, lte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { marketDaily } from '@/lib/db/schema';
import { DEMAND_EVENTS, SELLABLE_UNITS } from '@/data/analyticsConfig';
import { pragueToday } from '@/utils/periodUtils';
import type {
  DemandLevel,
  PricePosition,
  RadarDay,
  RadarEvent,
  RadarFlagKind,
  RadarResponse,
  RadarUnit,
} from '@/utils/radarTypes';

// ── Mapping helpers ───────────────────────────────────────────────────────────

const DEMAND_BY_DESC: Record<string, DemandLevel> = {
  'Low Demand': 'low',
  'Normal Demand': 'normal',
  'Good Demand': 'good',
  'High Demand': 'high',
};

const DEMAND_RANK: Record<DemandLevel, number> = { low: 0, normal: 1, good: 2, high: 3 };

function maxDemand(a: DemandLevel | null, b: DemandLevel | null): DemandLevel | null {
  if (a === null) return b;
  if (b === null) return a;
  return DEMAND_RANK[a] >= DEMAND_RANK[b] ? a : b;
}

function toNum(value: string | null): number | null {
  if (value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function positionOf(
  live: number | null,
  p25: number | null,
  p50: number | null,
  p75: number | null,
  p90: number | null,
): PricePosition | null {
  if (live === null) return null;
  if (p25 !== null && live < p25) return 'below-p25';
  if (p90 !== null && live > p90) return 'above-p90';
  if (p50 !== null && live <= p50) return 'p25-50';
  if (p75 !== null && live <= p75) return 'p50-75';
  if (p90 !== null && live <= p90) return 'p75-90';
  return null;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── The read ─────────────────────────────────────────────────────────────────

export async function readRadar(daysAhead: number): Promise<RadarResponse> {
  const from = pragueToday();
  const to = addDays(from, daysAhead);

  const units = SELLABLE_UNITS.filter((u) => u.priceLabsListingId);
  const listingIds = units.map((u) => u.priceLabsListingId!);

  const rows = await db
    .select()
    .from(marketDaily)
    .where(
      and(
        inArray(marketDaily.listingId, listingIds),
        gte(marketDaily.stayDate, from),
        lte(marketDaily.stayDate, to),
      ),
    );

  // City demand per date: max unmasked reading across the four units. The
  // four listings sit a few hundred metres apart in one city — a date that is
  // 'High Demand' for any of them is a high-demand date, full stop.
  const cityDemand = new Map<string, DemandLevel | null>();
  for (const r of rows) {
    const level = r.demandDesc ? (DEMAND_BY_DESC[r.demandDesc] ?? null) : null;
    cityDemand.set(r.stayDate, maxDemand(cityDemand.get(r.stayDate) ?? null, level));
  }

  // Curated events, clipped to the window.
  const events: RadarEvent[] = DEMAND_EVENTS.filter((e) => e.end >= from && e.start <= to).map(
    (e) => ({ id: e.id, label: e.label, start: e.start, end: e.end, kind: e.kind }),
  );
  const eventsOn = (date: string): string[] =>
    events.filter((e) => date >= e.start && date <= e.end).map((e) => e.label);

  const byListing = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = byListing.get(r.listingId) ?? [];
    list.push(r);
    byListing.set(r.listingId, list);
  }

  const outUnits: RadarUnit[] = units.map((unit) => {
    const unitRows = (byListing.get(unit.priceLabsListingId!) ?? []).sort((a, b) =>
      a.stayDate.localeCompare(b.stayDate),
    );

    let oldestCapture: Date | null = null;
    const days: RadarDay[] = unitRows.map((r) => {
      if (!oldestCapture || r.capturedAt < oldestCapture) oldestCapture = r.capturedAt;

      const unavailable = r.demandDesc === 'Unavailable';
      const demand = r.demandDesc ? (DEMAND_BY_DESC[r.demandDesc] ?? null) : null;
      const city = cityDemand.get(r.stayDate) ?? null;
      const live = toNum(r.livePrice);
      const p25 = toNum(r.p25);
      const p50 = toNum(r.p50);
      const p75 = toNum(r.p75);
      const p90 = toNum(r.p90);
      const position = positionOf(live, p25, p50, p75, p90);

      // Flag rules — deliberately blunt. These are "look here" markers for an
      // operator, not pricing advice; every threshold is visible in the UI copy.
      const effective = demand ?? city;
      const flags: RadarFlagKind[] = [];
      if (!unavailable && live !== null) {
        if ((effective === 'good' || effective === 'high') && p50 !== null && live < p50) {
          flags.push('underpriced');
        }
        // Above the 90th percentile is the only "too expensive" worth flagging —
        // p75 fired on ~20% of low-demand days here, which is a wallpaper, not a
        // flag. Sitting high on quiet dates is often deliberate (long-stay bait).
        if (effective === 'low' && p90 !== null && live > p90) {
          flags.push('overpriced');
        }
      }
      if (unavailable && (city === 'good' || city === 'high')) {
        // Can't distinguish booked (fine) from blocked (money on the table)
        // here — market_daily has no reservation join. The flag says "hot date
        // you cannot sell"; whether that is good news is for the operator.
        flags.push('blocked-hot');
      }

      return {
        date: r.stayDate,
        demand,
        cityDemand: city,
        unavailable,
        demandColor: r.demandColor,
        livePrice: live,
        recommendedPrice: toNum(r.recommendedPrice),
        p25,
        p50,
        p75,
        p90,
        medianBooked: toNum(r.medianBookedPrice),
        marketOccupancy: toNum(r.marketOccupancy),
        marketPickup7: toNum(r.marketPickup7),
        nBookings: toNum(r.nBookings),
        minStay: r.minStay,
        position,
        flags,
        events: eventsOn(r.stayDate),
      };
    });

    return {
      unitId: unit.id,
      label: unit.label,
      listingId: unit.priceLabsListingId!,
      days,
      capturedAt: oldestCapture ? (oldestCapture as Date).toISOString() : null,
    };
  });

  return { units: outUnits, events, from, to, generatedAt: new Date().toISOString() };
}

// ── Telegram digest ───────────────────────────────────────────────────────────

/**
 * Compact flag summary for the ops group. Returns null when there is nothing
 * worth saying — the caller should send nothing rather than a "all quiet" ping.
 */
export async function buildRadarDigest(daysAhead = 120): Promise<string | null> {
  const radar = await readRadar(daysAhead);

  const lines: string[] = [];
  const hotDates = new Set<string>();
  for (const unit of radar.units) {
    for (const day of unit.days) {
      if (day.cityDemand === 'high' || day.cityDemand === 'good') hotDates.add(day.date);
    }
  }

  const collect = (kind: RadarFlagKind): { unit: string; day: RadarDay }[] =>
    radar.units.flatMap((u) =>
      u.days.filter((d) => d.flags.includes(kind)).map((day) => ({ unit: u.label, day })),
    );

  const fmtKc = (n: number | null) => (n === null ? '—' : `${Math.round(n).toLocaleString('cs-CZ')} Kč`);

  const under = collect('underpriced');
  const over = collect('overpriced');

  if (under.length > 0) {
    lines.push(`⚠️ <b>Underpriced on busy dates</b> (live &lt; market median):`);
    for (const { unit, day } of under.slice(0, 6)) {
      lines.push(`  • ${day.date} ${unit}: ${fmtKc(day.livePrice)} vs p50 ${fmtKc(day.p50)}`);
    }
    if (under.length > 6) lines.push(`  … and ${under.length - 6} more`);
  }
  if (over.length > 0) {
    lines.push(`🧊 <b>Above p90 on low-demand dates</b>:`);
    for (const { unit, day } of over.slice(0, 4)) {
      lines.push(`  • ${day.date} ${unit}: ${fmtKc(day.livePrice)} vs p90 ${fmtKc(day.p90)}`);
    }
    if (over.length > 4) lines.push(`  … and ${over.length - 4} more`);
  }

  if (lines.length === 0) return null;

  return [
    `📡 <b>Price Radar</b> — next ${daysAhead} days, ${hotDates.size} good/high-demand dates`,
    ...lines,
  ].join('\n');
}
