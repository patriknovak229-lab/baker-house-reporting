'use client';
/**
 * Price Radar — the no-scraping half of the Pricing tab.
 *
 * Renders the PriceLabs-derived demand calendar and our price position against
 * the market, entirely from `/api/pricing/radar` (a Postgres read). The parity
 * scraper can be dead for a week and this view keeps working.
 *
 * Reading guide for the position chips: percentiles are the ASKING prices of
 * the Airbnb/VRBO comp set for that night and bedroom count. Sitting p50–75 is
 * the neutral zone; below p50 on a good/high-demand date is the "money left on
 * the table" signal; above p90 on a low-demand date is the "why would anyone
 * pick us" signal. Chips label the band, tooltips carry the numbers.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Card, Empty, czk, pct } from '@/components/analytics/kit';
import type {
  DemandLevel,
  RadarDay,
  RadarFlagKind,
  RadarResponse,
  RadarUnit,
} from '@/utils/radarTypes';

// ── Demand styling ────────────────────────────────────────────────────────────

const DEMAND_META: Record<DemandLevel, { label: string; cell: string; badge: string }> = {
  low: { label: 'Low', cell: 'bg-slate-200/70 text-slate-500', badge: 'bg-slate-100 text-slate-600' },
  normal: { label: 'Normal', cell: 'bg-emerald-100 text-emerald-900', badge: 'bg-emerald-100 text-emerald-800' },
  good: { label: 'Good', cell: 'bg-amber-300 text-amber-950', badge: 'bg-amber-200 text-amber-900' },
  high: { label: 'High', cell: 'bg-rose-500 text-white', badge: 'bg-rose-500 text-white' },
};

const FLAG_META: Record<RadarFlagKind, { label: string; explain: string; tone: string }> = {
  underpriced: {
    label: 'Underpriced on busy dates',
    explain: 'Good/High demand and our live price is below the market median (p50).',
    tone: 'text-rose-700 bg-rose-50 border-rose-200',
  },
  overpriced: {
    label: 'Premium on quiet dates',
    explain: 'Low demand and our live price is above the market 90th percentile.',
    tone: 'text-sky-800 bg-sky-50 border-sky-200',
  },
  'blocked-hot': {
    label: 'Hot date, not sellable',
    explain: 'Good/High city demand but this unit is booked or blocked. Booked is fine; blocked is money on the table.',
    tone: 'text-amber-800 bg-amber-50 border-amber-200',
  },
};

const POSITION_META: Record<NonNullable<RadarDay['position']>, { label: string; chip: string }> = {
  'below-p25': { label: '<p25', chip: 'bg-rose-100 text-rose-800 ring-1 ring-rose-200' },
  'p25-50': { label: 'p25–50', chip: 'bg-orange-100 text-orange-800 ring-1 ring-orange-200' },
  'p50-75': { label: 'p50–75', chip: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200' },
  'p75-90': { label: 'p75–90', chip: 'bg-sky-100 text-sky-800 ring-1 ring-sky-200' },
  'above-p90': { label: '>p90', chip: 'bg-violet-100 text-violet-800 ring-1 ring-violet-200' },
};

function fmtDateShort(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ── City-level day merge ──────────────────────────────────────────────────────

interface CityDay {
  date: string;
  demand: DemandLevel | null;
  events: string[];
  marketOccupancy: number | null;
  marketPickup7: number | null;
  /** How many of the 4 units are sellable that night. */
  sellableUnits: number;
  unitCount: number;
}

function mergeCityDays(units: RadarUnit[]): Map<string, CityDay> {
  const map = new Map<string, CityDay>();
  for (const unit of units) {
    for (const day of unit.days) {
      let entry = map.get(day.date);
      if (!entry) {
        entry = {
          date: day.date,
          demand: day.cityDemand,
          events: day.events,
          marketOccupancy: null,
          marketPickup7: null,
          sellableUnits: 0,
          unitCount: 0,
        };
        map.set(day.date, entry);
      }
      entry.unitCount += 1;
      if (!day.unavailable) entry.sellableUnits += 1;
      // Occupancy/pickup differ by bedroom category — keep the max as the
      // "how busy is the city" reading; this is a headline, not a metric.
      if (day.marketOccupancy !== null) {
        entry.marketOccupancy = Math.max(entry.marketOccupancy ?? 0, day.marketOccupancy);
      }
      if (day.marketPickup7 !== null) {
        entry.marketPickup7 = Math.max(entry.marketPickup7 ?? 0, day.marketPickup7);
      }
    }
  }
  return map;
}

// ── Calendar ─────────────────────────────────────────────────────────────────

function monthsBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  let cursor = fromIso.slice(0, 7);
  const last = toIso.slice(0, 7);
  while (cursor <= last) {
    out.push(cursor);
    const [y, m] = cursor.split('-').map(Number);
    cursor = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  }
  return out;
}

function MonthGrid({
  month,
  cityDays,
  today,
}: {
  month: string;
  cityDays: Map<string, CityDay>;
  today: string;
}) {
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7; // Monday = 0

  const cells: (CityDay | null | undefined)[] = [];
  for (let i = 0; i < firstDow; i++) cells.push(undefined); // leading blanks
  for (let d = 1; d <= daysInMonth; d++) {
    const iso = `${month}-${String(d).padStart(2, '0')}`;
    cells.push(cityDays.get(iso) ?? null); // null = date outside snapshot
  }

  const monthLabel = new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <div className="w-[232px]">
      <div className="text-xs font-semibold text-gray-700 mb-1.5">{monthLabel}</div>
      <div className="grid grid-cols-7 gap-[3px] text-[9px] text-gray-400 mb-1">
        {['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map((d) => (
          <div key={d} className="w-7 text-center">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {cells.map((cell, i) => {
          if (cell === undefined) return <div key={i} className="w-7 h-7" />;
          if (cell === null) {
            return <div key={i} className="w-7 h-7 rounded bg-gray-50 border border-dashed border-gray-200" />;
          }
          const meta = cell.demand ? DEMAND_META[cell.demand] : null;
          const dayNum = Number(cell.date.slice(8, 10));
          const isToday = cell.date === today;
          const hasEvent = cell.events.length > 0;
          const tooltip = [
            fmtDateShort(cell.date),
            cell.demand ? `${DEMAND_META[cell.demand].label} demand` : 'No demand reading',
            cell.marketOccupancy !== null ? `Market occupancy ${pct(cell.marketOccupancy)}` : null,
            `${cell.sellableUnits}/${cell.unitCount} units sellable`,
            ...cell.events.map((e) => `★ ${e}`),
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div
              key={i}
              title={tooltip}
              className={`w-7 h-7 rounded flex items-center justify-center text-[10px] font-medium cursor-default relative
                ${meta ? meta.cell : 'bg-gray-100 text-gray-400'}
                ${isToday ? 'ring-2 ring-indigo-500 ring-offset-1' : ''}`}
            >
              {dayNum}
              {hasEvent && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-indigo-600 border border-white" />
              )}
              {cell.sellableUnits === 0 && (
                <span className="absolute bottom-[2px] left-1/2 -translate-x-1/2 w-3 h-[2px] rounded bg-black/25" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Hot dates table ───────────────────────────────────────────────────────────

function UnitPriceCell({ day }: { day: RadarDay | undefined }) {
  if (!day) return <td className="px-3 py-2 text-right text-gray-300">—</td>;
  if (day.unavailable || day.livePrice === null) {
    return (
      <td className="px-3 py-2 text-right">
        <span
          className="text-xs text-gray-400 italic"
          title="Not sellable this night (booked or blocked)"
        >
          {day.flags.includes('blocked-hot') ? '🔥 n/a' : 'n/a'}
        </span>
      </td>
    );
  }
  const pos = day.position ? POSITION_META[day.position] : null;
  const tooltip = [
    `Live ${czk(day.livePrice)}`,
    day.recommendedPrice !== null ? `PriceLabs rec ${czk(day.recommendedPrice)}` : null,
    day.p50 !== null ? `Market p50 ${czk(day.p50)}` : null,
    day.p90 !== null ? `Market p90 ${czk(day.p90)}` : null,
    day.medianBooked !== null ? `Median booked ${czk(day.medianBooked)}` : null,
    day.minStay !== null ? `Min stay ${day.minStay}` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <td className="px-3 py-2 text-right whitespace-nowrap" title={tooltip}>
      <span className={`tabular-nums text-sm ${day.flags.includes('underpriced') ? 'font-bold text-rose-700' : 'text-gray-800'}`}>
        {czk(day.livePrice)}
      </span>
      {pos && (
        <span className={`ml-1.5 inline-block px-1 py-0.5 rounded text-[10px] font-semibold ${pos.chip}`}>
          {pos.label}
        </span>
      )}
    </td>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function RadarView() {
  const [radar, setRadar] = useState<RadarResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [horizon, setHorizon] = useState<60 | 120 | 365>(120);
  const [highOnly, setHighOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/pricing/radar?days=365');
      if (!res.ok) throw new Error(`Radar failed (${res.status})`);
      setRadar(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load radar');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const cityDays = useMemo(() => (radar ? mergeCityDays(radar.units) : new Map<string, CityDay>()), [radar]);

  const staleHours = useMemo(() => {
    if (!radar) return null;
    const oldest = radar.units
      .map((u) => (u.capturedAt ? new Date(u.capturedAt).getTime() : null))
      .filter((t): t is number => t !== null);
    if (oldest.length === 0) return null;
    return (Date.now() - Math.min(...oldest)) / 3_600_000;
  }, [radar]);

  const flagRows = useMemo(() => {
    const out: Record<RadarFlagKind, { unit: string; day: RadarDay }[]> = {
      underpriced: [],
      overpriced: [],
      'blocked-hot': [],
    };
    for (const unit of radar?.units ?? []) {
      for (const day of unit.days) {
        for (const f of day.flags) out[f].push({ unit: unit.label, day });
      }
    }
    for (const k of Object.keys(out) as RadarFlagKind[]) {
      out[k].sort((a, b) => a.day.date.localeCompare(b.day.date));
    }
    return out;
  }, [radar]);

  const hotDates = useMemo(() => {
    if (!radar) return [];
    const cutoff = new Date(`${radar.from}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() + horizon);
    const cutoffIso = cutoff.toISOString().slice(0, 10);
    return [...cityDays.values()]
      .filter((d) => d.date <= cutoffIso)
      .filter((d) => (highOnly ? d.demand === 'high' : d.demand === 'high' || d.demand === 'good'))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [radar, cityDays, horizon, highOnly]);

  const dayByUnit = useMemo(() => {
    const map = new Map<string, Map<string, RadarDay>>();
    for (const unit of radar?.units ?? []) {
      map.set(unit.unitId, new Map(unit.days.map((d) => [d.date, d])));
    }
    return map;
  }, [radar]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400 text-sm gap-2">
        <span className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
        Loading radar…
      </div>
    );
  }
  if (error) {
    return <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>;
  }
  if (!radar || radar.units.every((u) => u.days.length === 0)) {
    return (
      <Card title="Price Radar">
        <Empty message="No market snapshot yet — run the market refresh from the Analytics page (or wait for the 06:30 cron)." />
      </Card>
    );
  }

  const months = monthsBetween(radar.from, radar.to);
  const totalFlags = flagRows.underpriced.length + flagRows.overpriced.length + flagRows['blocked-hot'].length;

  return (
    <div className="space-y-8">
      {staleHours !== null && staleHours > 48 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Market snapshot is {Math.round(staleHours)} h old — the 06:30 refresh may be failing. Data below reflects the last successful pull.
        </div>
      )}

      {/* Flag summary */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {(Object.keys(FLAG_META) as RadarFlagKind[]).map((kind) => {
          const meta = FLAG_META[kind];
          const rows = flagRows[kind];
          return (
            <div key={kind} className={`rounded-xl border px-4 py-3 ${meta.tone}`}>
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">{meta.label}</span>
                <span className="text-2xl font-bold tabular-nums">{rows.length}</span>
              </div>
              <p className="text-xs opacity-80 mt-1">{meta.explain}</p>
              {rows.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs">
                  {rows.slice(0, 3).map(({ unit, day }, i) => (
                    <li key={i} className="tabular-nums">
                      {day.date} · {unit}
                      {kind === 'underpriced' && day.livePrice !== null && day.p50 !== null && (
                        <> — {czk(day.livePrice)} vs p50 {czk(day.p50)}</>
                      )}
                      {kind === 'overpriced' && day.livePrice !== null && day.p90 !== null && (
                        <> — {czk(day.livePrice)} vs p90 {czk(day.p90)}</>
                      )}
                    </li>
                  ))}
                  {rows.length > 3 && <li className="opacity-70">… and {rows.length - 3} more</li>}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      {/* Demand calendar */}
      <Card
        title="Demand calendar — Brno, next 12 months"
        subtitle="PriceLabs' per-date demand read across the comp set (max over our four units). Dot = curated event; dash under the number = no unit sellable that night."
      >
        <div className="flex items-center gap-4 flex-wrap text-xs text-gray-600 mb-4">
          {(Object.keys(DEMAND_META) as DemandLevel[]).map((d) => (
            <span key={d} className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-3.5 h-3.5 rounded ${DEMAND_META[d].cell.split(' ')[0]}`} />
              {DEMAND_META[d].label}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block w-2 h-2 rounded-full bg-indigo-600" /> Event
          </span>
          {radar.events.length > 0 && (
            <span className="text-gray-400">
              {radar.events.map((e) => `${e.label} (${e.start.slice(5)}→${e.end.slice(5)})`).join(' · ')}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-8 gap-y-6">
          {months.map((m) => (
            <MonthGrid key={m} month={m} cityDays={cityDays} today={radar.from} />
          ))}
        </div>
      </Card>

      {/* Hot dates table */}
      <Card
        title="High-demand dates — our position"
        subtitle="Every upcoming date PriceLabs rates Good or High demand, with our live price per unit and where it sits inside the market's asking-price percentiles (Airbnb/VRBO comp set — Booking.com listings are not in it)."
      >
        <div className="flex items-center gap-3 mb-4 text-xs">
          <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 font-medium">
            {([60, 120, 365] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={`px-3 py-1.5 rounded-md transition-colors ${horizon === h ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {h} days
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer">
            <input type="checkbox" checked={highOnly} onChange={(e) => setHighOnly(e.target.checked)} />
            High demand only
          </label>
          <span className="text-gray-400 ml-auto">
            Position chips: {(Object.values(POSITION_META)).map((p) => p.label).join(' · ')} of market asking prices
          </span>
        </div>

        {hotDates.length === 0 ? (
          <Empty message="No good/high-demand dates inside this horizon." />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Demand</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase" title="Highest market occupancy across bedroom categories">Mkt occ</th>
                  {radar.units.map((u) => (
                    <th key={u.unitId} className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">
                      {u.label.replace('Baker House Apartments', '').trim()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {hotDates.map((d) => {
                  const demandMeta = d.demand ? DEMAND_META[d.demand] : null;
                  return (
                    <tr key={d.date} className={d.demand === 'high' ? 'bg-rose-50/40' : ''}>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className="text-gray-800">{fmtDateShort(d.date)}</span>
                        {d.events.length > 0 && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-800 text-[10px] font-medium">
                            {d.events.join(' · ')}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {demandMeta && (
                          <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${demandMeta.badge}`}>
                            {demandMeta.label}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                        {d.marketOccupancy !== null ? pct(d.marketOccupancy) : '—'}
                      </td>
                      {radar.units.map((u) => (
                        <UnitPriceCell key={u.unitId} day={dayByUnit.get(u.unitId)?.get(d.date)} />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-gray-400">
        {totalFlags} flag{totalFlags === 1 ? '' : 's'} across the snapshot · market data: PriceLabs comp set (Airbnb/VRBO
        view of Brno; Booking.com-only listings invisible) · snapshot refreshes daily at 06:30 with a Monday Telegram digest.
      </p>
    </div>
  );
}
