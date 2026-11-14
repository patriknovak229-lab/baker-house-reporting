'use client';
/**
 * Visibility Booster candidates — the Radar card that answers "which check-in
 * dates should I boost on Booking.com this month?".
 *
 * Fetches `/api/pricing/booster` on its own, so a slow history query never holds
 * up the demand calendar. The model behind every number is documented in
 * `utils/boosterCandidates.ts`; the subtitle spells out the live thresholds so
 * the operator can see why a date is (not) on the list.
 */
import { useEffect, useMemo, useState } from 'react';
import { Card, Empty, czk, pct } from '@/components/analytics/kit';
import { PARITY_UNITS } from '@/data/parityConfig';
import type { BoosterResponse, BoosterUnitNight, BoosterVerdict } from '@/utils/boosterCandidates';
import type { DemandLevel } from '@/utils/radarTypes';

const VERDICT_META: Record<BoosterVerdict, { label: string; chip: string; explain: string }> = {
  boost: {
    label: 'Boost',
    chip: 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-300',
    explain: 'Likely to stay empty, nothing else blocks it — boosting this check-in date should pay.',
  },
  'fix-min-stay': {
    label: 'Fix min stay',
    chip: 'bg-amber-100 text-amber-800 ring-1 ring-amber-300',
    explain:
      'The open gap is shorter than the minimum stay, so no booking can start here. PriceLabs’ orphan-day rule should have handled it — check that setting.',
  },
  'check-price': {
    label: 'Price too high',
    chip: 'bg-violet-100 text-violet-800 ring-1 ring-violet-300',
    explain:
      'Normal or low demand and we sit above the market’s 90th percentile — we are not competitive on this date. Fix the price before paying for visibility.',
  },
  watch: {
    label: 'Watch',
    chip: 'bg-sky-100 text-sky-800 ring-1 ring-sky-300',
    explain: 'Within 10 points of the break-even line, or no history to judge — check again nearer the date.',
  },
  'sells-anyway': {
    label: 'Sells anyway',
    chip: 'bg-gray-100 text-gray-600 ring-1 ring-gray-200',
    explain:
      'Likely to sell on its own, or PriceLabs rates the date Good/High demand and is already pricing it — a boost would mostly pay extra commission on bookings you get anyway.',
  },
};

const DEMAND_BADGE: Record<DemandLevel, { label: string; badge: string }> = {
  low: { label: 'Low', badge: 'bg-slate-100 text-slate-600' },
  normal: { label: 'Normal', badge: 'bg-emerald-100 text-emerald-800' },
  good: { label: 'Good', badge: 'bg-amber-200 text-amber-900' },
  high: { label: 'High', badge: 'bg-rose-500 text-white' },
};

function fmtDateShort(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}

function fmtStamp(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function signedCzk(value: number): string {
  if (Math.round(value) === 0) return '0 Kč';
  return `${value > 0 ? '+' : '−'}${czk(Math.abs(value))}`;
}

function unitTooltip(u: BoosterUnitNight): string {
  const parts = [
    `${u.label}: ${u.openRooms} of ${u.capacity} open`,
    u.sellChance === null
      ? 'no history for the sell chance'
      : `sells anyway ${pct(u.sellChance)} → ${pct(u.boostedSellChance ?? u.sellChance)} if boosted`,
    `open ${u.openRunNights} night${u.openRunNights === 1 ? '' : 's'} from here (gap ${u.openGapNights}), min stay ${u.minStay ?? '—'}`,
    u.livePrice === null ? 'no live price' : `live ${czk(u.livePrice)}${u.position ? ` (${u.position} of market)` : ''}`,
    u.expectedGain === null ? 'boost value unknown' : `boosting: ${signedCzk(u.expectedGain)} expected`,
    VERDICT_META[u.verdict].label,
  ];
  return parts.join(' · ');
}

export default function BoosterCandidates() {
  const [data, setData] = useState<BoosterResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [boostOnly, setBoostOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/pricing/booster')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as BoosterResponse;
      })
      .then((body) => !cancelled && setData(body))
      .catch((err: unknown) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, []);

  // Same unit order as the parity boards and the hot-dates table.
  const unitRank = useMemo(() => new Map(PARITY_UNITS.map((u, i) => [u.id, i])), []);

  const rows = useMemo(
    () => (data?.dates ?? []).filter((d) => !boostOnly || d.verdict === 'boost'),
    [data, boostOnly],
  );
  const boostCount = useMemo(() => (data?.dates ?? []).filter((d) => d.verdict === 'boost').length, [data]);

  if (error) {
    return (
      <Card title="Visibility Booster — which check-in dates to boost">
        <p className="text-sm text-red-700">Could not load booster candidates: {error}</p>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card title="Visibility Booster — which check-in dates to boost">
        <Empty message="Loading booster candidates…" />
      </Card>
    );
  }

  const econ = data.economics;
  const subtitle = (
    <>
      A boosted check-in date costs {pct(econ.boostedCommission, 1)} instead of {pct(econ.baseCommission, 1)} on every
      Booking.com booking for it — including the ones you would get anyway — so it needs{' '}
      <strong>+{pct(data.breakEvenLift)} more bookings</strong> just to break even. Assuming the booster lifts demand by{' '}
      {pct(econ.assumedDemandUplift)}, that only happens where an open night has less than a{' '}
      <strong>{pct(data.breakEvenSellChance)} chance of selling on its own</strong>. Chances are learned from stays{' '}
      {data.historyFrom} → {data.historyTo}, mostly high season, so in winter they read high (the list errs towards
      &ldquo;don&rsquo;t boost&rdquo;).
    </>
  );

  return (
    <Card title="Visibility Booster — which check-in dates to boost" subtitle={subtitle}>
      <div className="flex flex-wrap items-center gap-3 mb-4 text-xs">
        <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 font-medium">
          {([false, true] as const).map((only) => (
            <button
              key={String(only)}
              type="button"
              onClick={() => setBoostOnly(only)}
              className={`px-3 py-1.5 rounded-md transition-colors ${boostOnly === only ? 'bg-gray-800 text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {only ? `Boost only (${boostCount})` : `All open dates (${data.dates.length})`}
            </button>
          ))}
        </div>
        <span className="text-gray-400">
          Next 30 days · open rooms as of the last bookings sync, {fmtStamp(data.mirrorSyncedAt)} · hover a unit for the
          numbers
        </span>
      </div>

      {rows.length === 0 ? (
        <Empty
          message={
            boostOnly
              ? 'No check-in date in the next 30 days is worth boosting — every open night is likely to sell on its own, or something else blocks it.'
              : 'Nothing is open in the next 30 days.'
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">Check-in</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase">Days out</th>
                <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Demand</th>
                <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 uppercase">
                  Open rooms · chance it sells anyway
                </th>
                <th
                  className="px-3 py-2 text-right text-xs font-medium text-gray-500 uppercase"
                  title="Expected contribution from boosting this date for one night, under the assumed demand uplift. Negative = the extra commission on bookings you'd get anyway outweighs the extra bookings."
                >
                  Boost value
                </th>
                <th className="px-3 py-2 text-center text-xs font-medium text-gray-500 uppercase">Verdict</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((d) => {
                const verdict = VERDICT_META[d.verdict];
                const demand = d.cityDemand ? DEMAND_BADGE[d.cityDemand] : null;
                const units = [...d.units].sort(
                  (a, b) => (unitRank.get(a.unitId) ?? 99) - (unitRank.get(b.unitId) ?? 99),
                );
                return (
                  <tr key={d.date} className={d.verdict === 'boost' ? 'bg-emerald-50/50' : ''}>
                    <td className="px-3 py-2 whitespace-nowrap text-gray-800">{fmtDateShort(d.date)}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-gray-500">{d.daysOut}</td>
                    <td className="px-3 py-2 text-center">
                      {demand ? (
                        <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold ${demand.badge}`}>
                          {demand.label}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1.5">
                        {units.map((u) => (
                          <span
                            key={u.unitId}
                            title={unitTooltip(u)}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] tabular-nums ${VERDICT_META[u.verdict].chip}`}
                          >
                            <span className="font-semibold">{u.label}</span>
                            <span>
                              {u.openRooms}/{u.capacity}
                            </span>
                            <span className="opacity-75">
                              · {u.sellChance === null ? '—' : pct(u.sellChance)}
                            </span>
                          </span>
                        ))}
                      </div>
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${d.expectedGain > 0 ? 'text-emerald-700 font-medium' : 'text-gray-500'}`}
                    >
                      {/* No live price or history on any open unit → the value is unknown, not zero. */}
                      {units.some((u) => u.expectedGain !== null) ? signedCzk(d.expectedGain) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span
                        title={verdict.explain}
                        className={`inline-block whitespace-nowrap px-2 py-0.5 rounded text-[11px] font-semibold ${verdict.chip}`}
                      >
                        {verdict.label}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1 text-xs text-gray-500">
        {(Object.keys(VERDICT_META) as BoosterVerdict[]).map((v) => (
          <div key={v} className="flex gap-2">
            <dt>
              <span className={`inline-block px-1.5 rounded text-[10px] font-semibold ${VERDICT_META[v].chip}`}>
                {VERDICT_META[v].label}
              </span>
            </dt>
            <dd>{VERDICT_META[v].explain}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
