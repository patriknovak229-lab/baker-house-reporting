/**
 * Visibility Booster candidates — which upcoming check-in dates are worth
 * boosting on Booking.com. The model and its reasoning live in
 * `utils/boosterCandidates.ts`; this file only gathers the inputs.
 *
 * Three reads, all local (no Beds24 or PriceLabs call on a page load):
 *   1. Open rooms per unit per night over the horizon — `bookings_mirror`
 *      through the analytics CTE stack, so blackouts, mid-stay moves and
 *      unallocated virtual-room bookings count exactly as on the Analytics tab.
 *   2. The "chance it sells anyway" curve per unit — the same stack over the last
 *      BOOSTER_HISTORY_DAYS of past nights.
 *   3. Demand, minimum stay, live price and market position — `readRadar`, so the
 *      list and the radar above it can never disagree about a date.
 */
import { sql } from 'drizzle-orm';
import { BOOSTER_ECONOMICS, BOOSTER_HISTORY_DAYS, BOOSTER_HORIZON_DAYS } from '@/data/boosterConfig';
import { SELLABLE_UNITS } from '@/data/analyticsConfig';
import { baseCtes, n, query, unitIdOf, unitIdOfLabel, type AnalyticsScope } from '@/data-access/analytics/shared';
import { readRadar } from '@/data-access/pricing/radar';
import { pragueToday } from '@/utils/periodUtils';
import {
  boostedSellChance,
  boosterVerdict,
  breakEvenLift,
  breakEvenSellChance,
  expectedBoostGain,
  openGaps,
  openRuns,
  rollUpDateVerdict,
  sellChanceCurve,
  type BoosterDate,
  type BoosterResponse,
  type BoosterUnitNight,
} from '@/utils/boosterCandidates';
import type { RadarDay } from '@/utils/radarTypes';

/**
 * Extra nights read past the horizon so a gap near its end still knows how long
 * it runs — otherwise a 3-night gap starting on the last day reads as 1 night and
 * gets a false "fix min stay".
 */
const RUN_LOOKAHEAD_DAYS = 14;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

function scopeOf(from: string, to: string): AnalyticsScope {
  return { from, to, rooms: [], channels: [] };
}

// ── Read 1: open rooms per unit per night ────────────────────────────────────

interface OpenDb {
  unit_id: string;
  stay_date: string;
  capacity: number;
  sold: number;
}

async function readOpenRooms(from: string, to: string): Promise<OpenDb[]> {
  const scope = scopeOf(from, to);
  return query<OpenDb>(sql`
    ${baseCtes(scope)},
    cap AS (
      SELECT ${unitIdOf(sql`available.room`)} AS unit_id, available.stay_date, COUNT(*)::int AS capacity
      FROM available
      GROUP BY 1, 2
    ),
    sold AS (
      SELECT ${unitIdOfLabel(sql`nights.room`)} AS unit_id, nights.stay_date, COUNT(*)::int AS sold
      FROM nights
      WHERE nights.stay_date BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1, 2
    )
    SELECT c.unit_id,
           to_char(c.stay_date, 'YYYY-MM-DD') AS stay_date,
           c.capacity,
           COALESCE(s.sold, 0)::int           AS sold
    FROM cap c
    LEFT JOIN sold s ON s.unit_id = c.unit_id AND s.stay_date = c.stay_date
    WHERE c.unit_id <> 'other'
  `);
}

// ── Read 2: the sell-chance curve per unit ───────────────────────────────────

interface HistoryDb {
  unit_id: string;
  /** Night lead in days, capped at the horizon; null on the "empty" rows. */
  lead: number | null;
  nights: number;
}

async function readHistory(from: string, to: string, maxLead: number): Promise<HistoryDb[]> {
  const scope = scopeOf(from, to);
  return query<HistoryDb>(sql`
    ${baseCtes(scope)},
    cap AS (
      SELECT ${unitIdOf(sql`available.room`)} AS unit_id, available.stay_date, COUNT(*)::int AS capacity
      FROM available
      GROUP BY 1, 2
    ),
    sold_nights AS (
      SELECT ${unitIdOfLabel(sql`nights.room`)} AS unit_id,
             nights.stay_date,
             LEAST(GREATEST(nights.stay_date - nights.reservation_date, 0), ${maxLead}::int) AS lead
      FROM nights
      WHERE nights.stay_date BETWEEN ${from}::date AND ${to}::date
        AND nights.reservation_date IS NOT NULL
    ),
    sold_per_night AS (
      SELECT unit_id, stay_date, COUNT(*)::int AS sold FROM sold_nights GROUP BY 1, 2
    )
    SELECT unit_id, lead, COUNT(*)::int AS nights
    FROM sold_nights
    WHERE unit_id <> 'other'
    GROUP BY 1, 2
    UNION ALL
    SELECT c.unit_id, NULL::int AS lead,
           SUM(GREATEST(c.capacity - COALESCE(s.sold, 0), 0))::int AS nights
    FROM cap c
    LEFT JOIN sold_per_night s ON s.unit_id = c.unit_id AND s.stay_date = c.stay_date
    WHERE c.unit_id <> 'other'
    GROUP BY 1
  `);
}

/** unitId → sell chance by days out (index = days out). */
function curvesByUnit(rows: HistoryDb[], maxLead: number): Map<string, (number | null)[]> {
  const sold = new Map<string, number[]>();
  const empty = new Map<string, number>();
  for (const r of rows) {
    if (r.lead === null) {
      empty.set(r.unit_id, n(r.nights));
      continue;
    }
    const list = sold.get(r.unit_id) ?? new Array<number>(maxLead + 1).fill(0);
    list[Math.min(maxLead, Math.max(0, n(r.lead)))] += n(r.nights);
    sold.set(r.unit_id, list);
  }
  const out = new Map<string, (number | null)[]>();
  for (const unit of SELLABLE_UNITS) {
    out.set(unit.id, sellChanceCurve(sold.get(unit.id) ?? new Array<number>(maxLead + 1).fill(0), empty.get(unit.id) ?? 0));
  }
  return out;
}

async function readMirrorSyncedAt(): Promise<string | null> {
  const rows = await query<{ last_synced_at: string | null }>(sql`
    -- UTC with a "Z": Postgres' OF pattern gives "+00", which JS Date rejects.
    SELECT to_char(MAX(synced_at) FILTER (WHERE source <> 'legacy-import') AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last_synced_at
    FROM bookings_mirror
  `);
  return rows[0]?.last_synced_at ?? null;
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export async function readBoosterCandidates(): Promise<BoosterResponse> {
  const today = pragueToday();
  const horizonEnd = addDays(today, BOOSTER_HORIZON_DAYS - 1);
  const historyFrom = addDays(today, -BOOSTER_HISTORY_DAYS);
  const historyTo = addDays(today, -1);
  const maxLead = BOOSTER_HORIZON_DAYS;

  const [openRows, historyRows, radar, mirrorSyncedAt] = await Promise.all([
    readOpenRooms(today, addDays(horizonEnd, RUN_LOOKAHEAD_DAYS)),
    readHistory(historyFrom, historyTo, maxLead),
    readRadar(BOOSTER_HORIZON_DAYS),
    readMirrorSyncedAt(),
  ]);

  const econ = { ...BOOSTER_ECONOMICS };
  const threshold = breakEvenSellChance(econ);
  const curves = curvesByUnit(historyRows, maxLead);

  // Dense per-unit series over horizon + lookahead, so runs can be computed.
  const seriesLength = BOOSTER_HORIZON_DAYS + RUN_LOOKAHEAD_DAYS;
  const dates = Array.from({ length: seriesLength }, (_, i) => addDays(today, i));
  const openByUnit = new Map<string, { open: number[]; capacity: number[] }>();
  for (const unit of SELLABLE_UNITS) {
    openByUnit.set(unit.id, {
      open: new Array<number>(seriesLength).fill(0),
      capacity: new Array<number>(seriesLength).fill(0),
    });
  }
  for (const r of openRows) {
    const series = openByUnit.get(r.unit_id);
    const i = daysBetween(today, r.stay_date);
    if (!series || i < 0 || i >= seriesLength) continue;
    series.capacity[i] = n(r.capacity);
    series.open[i] = Math.max(0, n(r.capacity) - n(r.sold));
  }

  const radarDay = new Map<string, Map<string, RadarDay>>();
  for (const unit of radar.units) {
    radarDay.set(unit.unitId, new Map(unit.days.map((d) => [d.date, d])));
  }

  const out: BoosterDate[] = [];
  const runsByUnit = new Map(
    [...openByUnit].map(([unitId, series]) => [unitId, openRuns(series.open)] as const),
  );
  const gapsByUnit = new Map(
    [...openByUnit].map(([unitId, series]) => [unitId, openGaps(series.open)] as const),
  );

  for (let i = 0; i < BOOSTER_HORIZON_DAYS; i += 1) {
    const date = dates[i];
    const units: BoosterUnitNight[] = [];
    let cityDemand: BoosterDate['cityDemand'] = null;
    let marketOccupancy: number | null = null;

    for (const unit of SELLABLE_UNITS) {
      const day = radarDay.get(unit.id)?.get(date);
      if (day) {
        cityDemand = cityDemand ?? day.cityDemand;
        if (day.marketOccupancy !== null) marketOccupancy = Math.max(marketOccupancy ?? 0, day.marketOccupancy);
      }
      const series = openByUnit.get(unit.id)!;
      const openRooms = series.open[i];
      if (openRooms <= 0) continue;

      const sellChance = curves.get(unit.id)?.[Math.min(i, maxLead)] ?? null;
      const livePrice = day?.livePrice ?? null;
      const openRunNights = runsByUnit.get(unit.id)![i];
      const openGapNights = gapsByUnit.get(unit.id)![i];
      const minStay = day?.minStay ?? null;
      const position = day?.position ?? null;

      // The booster boosts CHECK-IN dates. The tail of a gap long enough for the
      // minimum stay cannot start a stay of its own — it is filled from the gap's
      // earlier check-in dates, whose rows already carry it — so it is no
      // candidate here, and certainly no orphan.
      if (minStay !== null && openRunNights < minStay && openGapNights >= minStay) continue;

      units.push({
        unitId: unit.id,
        label: unit.shortLabel,
        openRooms,
        capacity: series.capacity[i],
        sellChance,
        boostedSellChance: sellChance === null ? null : boostedSellChance(sellChance, econ.assumedDemandUplift),
        openRunNights,
        openGapNights,
        minStay,
        livePrice,
        position,
        expectedGain:
          sellChance === null || livePrice === null ? null : expectedBoostGain(openRooms, livePrice, sellChance, econ),
        verdict: boosterVerdict({
          daysOut: i,
          sellChance,
          breakEvenSellChance: threshold,
          cityDemand: day?.cityDemand ?? cityDemand,
          openGapNights,
          minStay,
          position,
        }),
      });
    }

    if (units.length === 0) continue;
    const expectedGain = units.reduce((sum, u) => sum + (u.expectedGain ?? 0), 0);
    out.push({
      date,
      daysOut: i,
      cityDemand,
      marketOccupancy,
      units,
      expectedGain,
      verdict: rollUpDateVerdict(units, expectedGain),
    });
  }

  return {
    dates: out,
    economics: econ,
    breakEvenLift: breakEvenLift(econ),
    breakEvenSellChance: threshold,
    historyFrom,
    historyTo,
    mirrorSyncedAt,
    generatedAt: new Date().toISOString(),
  };
}
