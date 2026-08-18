'use client';
/**
 * Presentation kit for the analytics section.
 *
 * Deliberately built on the vocabulary the app already uses — white
 * `rounded-xl` cards with a `border-gray-200` hairline and `shadow-sm`, tinted
 * KPI tiles, `text-base font-semibold` card titles, uppercase tracked column
 * headers, `cs-CZ` money — so the section reads as part of the dashboard rather
 * than a bolted-on BI tool. See `components/performance/GBVAdrView.tsx` for the
 * pattern being extended.
 *
 * What it adds over Performance: a consistent delta treatment (every KPI can
 * carry a period-on-period change), a `Metric` abstraction so heatmaps and
 * tables can switch what they show without duplicating formatting, and an
 * explicit "provisional" visual for periods that have not finished.
 */
import type { ReactNode } from 'react';

// ── Formatting ───────────────────────────────────────────────────────────────

export const czk = (value: number): string => `${Math.round(value).toLocaleString('cs-CZ')} Kč`;

/** Compact money for axis ticks: 1 234 567 → "1,2 M". */
export const czkAxis = (value: number): string => {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toLocaleString('cs-CZ', { maximumFractionDigits: 1 })} M`;
  if (abs >= 1_000) return `${Math.round(value / 1_000)} k`;
  return String(Math.round(value));
};

export const pct = (value: number, digits = 0): string =>
  `${(value * 100).toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits })} %`;

export const num = (value: number, digits = 0): string =>
  value.toLocaleString('cs-CZ', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const days = (value: number): string => `${num(value, value < 10 ? 1 : 0)} d`;

/** "2026-06" → "Jun 2026". */
export const monthLabel = (month: string): string => {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

/** "2026-06" → "Jun" — for dense axes where the year is in the title. */
export const monthShort = (month: string): string => monthLabel(month).split(' ')[0];

// ── Cards ────────────────────────────────────────────────────────────────────

export function Card({
  title,
  subtitle,
  actions,
  children,
  className = '',
}: {
  title?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`bg-white rounded-xl border border-gray-200 shadow-sm p-6 ${className}`}>
      {(title || actions) && (
        <div className="flex items-start justify-between gap-4 mb-5">
          <div>
            {title && <h2 className="text-base font-semibold text-gray-800">{title}</h2>}
            {subtitle && <p className="text-xs text-gray-500 mt-1 max-w-2xl leading-relaxed">{subtitle}</p>}
          </div>
          {actions && <div className="shrink-0 print:hidden">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Empty({ message = 'No data in this period.' }: { message?: string }) {
  return <p className="text-sm text-gray-400">{message}</p>;
}

// ── KPI tile ─────────────────────────────────────────────────────────────────

export type TileTone = 'indigo' | 'emerald' | 'amber' | 'rose' | 'violet' | 'slate' | 'sky';

const TILE_TONES: Record<TileTone, { bg: string; label: string; value: string; hint: string }> = {
  indigo: { bg: 'bg-indigo-50', label: 'text-indigo-500', value: 'text-indigo-700', hint: 'text-indigo-400' },
  emerald: { bg: 'bg-emerald-50', label: 'text-emerald-600', value: 'text-emerald-700', hint: 'text-emerald-500' },
  amber: { bg: 'bg-amber-50', label: 'text-amber-600', value: 'text-amber-700', hint: 'text-amber-500' },
  rose: { bg: 'bg-rose-50', label: 'text-rose-600', value: 'text-rose-700', hint: 'text-rose-500' },
  violet: { bg: 'bg-violet-50', label: 'text-violet-600', value: 'text-violet-700', hint: 'text-violet-500' },
  sky: { bg: 'bg-sky-50', label: 'text-sky-600', value: 'text-sky-700', hint: 'text-sky-500' },
  slate: { bg: 'bg-slate-50', label: 'text-slate-500', value: 'text-slate-700', hint: 'text-slate-400' },
};

/**
 * A delta is only rendered when a comparison base exists AND is non-zero.
 *
 * `higherIsBetter=false` flips the colour for metrics where down is good
 * (cancellations, commission rate, cost per night) — a red "−12%" on a falling
 * cost line is actively misleading.
 */
export function Delta({
  current,
  previous,
  higherIsBetter = true,
  format = 'pct-change',
}: {
  current: number;
  previous: number | null | undefined;
  higherIsBetter?: boolean;
  /** 'pct-change' = relative move; 'points' = absolute difference in pp. */
  format?: 'pct-change' | 'points';
}) {
  if (previous == null || !Number.isFinite(previous)) return null;
  if (format === 'pct-change' && previous === 0) return null;

  const change = format === 'points' ? current - previous : current / previous - 1;
  if (!Number.isFinite(change)) return null;

  const good = higherIsBetter ? change >= 0 : change <= 0;
  const tone = Math.abs(change) < 0.005 ? 'text-gray-400' : good ? 'text-emerald-600' : 'text-rose-600';
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const magnitude =
    format === 'points'
      ? `${num(Math.abs(change) * 100, 1)} pp`
      : `${num(Math.abs(change) * 100, Math.abs(change) < 0.1 ? 1 : 0)} %`;

  return (
    <span className={`text-xs font-medium ${tone}`}>
      {sign}
      {magnitude}
    </span>
  );
}

export function Tile({
  label,
  value,
  hint,
  tone = 'slate',
  delta,
}: {
  label: string;
  value: string;
  hint?: ReactNode;
  tone?: TileTone;
  delta?: ReactNode;
}) {
  const t = TILE_TONES[tone];
  return (
    <div className={`${t.bg} rounded-xl p-4`}>
      <p className={`text-[11px] font-medium uppercase tracking-wide ${t.label} mb-1`}>{label}</p>
      <div className="flex items-baseline gap-2 flex-wrap">
        <p className={`text-2xl font-bold ${t.value} leading-tight`}>{value}</p>
        {delta}
      </div>
      {hint && <p className={`text-[11px] mt-1 ${t.hint}`}>{hint}</p>}
    </div>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

export function Table({
  columns,
  children,
  footer,
}: {
  /** `null` renders an empty header cell; alignment defaults to right except col 0. */
  columns: (string | null)[];
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overflow-x-auto -mx-2 px-2">
      <table className="w-full text-sm min-w-[560px]">
        <thead>
          <tr className="border-b border-gray-100">
            {columns.map((label, i) => (
              <th
                key={`${label ?? 'col'}-${i}`}
                className={`py-2 text-[11px] font-medium text-gray-500 uppercase tracking-wide whitespace-nowrap ${
                  i === 0 ? 'text-left' : 'text-right'
                }`}
              >
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">{children}</tbody>
        {footer && <tfoot className="border-t border-gray-200">{footer}</tfoot>}
      </table>
    </div>
  );
}

export function Td({
  children,
  align = 'right',
  bold = false,
  muted = false,
  className = '',
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  bold?: boolean;
  muted?: boolean;
  className?: string;
}) {
  return (
    <td
      className={`py-2.5 ${align === 'left' ? 'text-left' : 'text-right'} ${
        bold ? 'font-semibold text-gray-900' : muted ? 'text-gray-400' : 'text-gray-700'
      } ${className}`}
    >
      {children}
    </td>
  );
}

// ── Heatmap ──────────────────────────────────────────────────────────────────

/**
 * Sequential single-hue ramp.
 *
 * One hue with increasing lightness, not a rainbow: the quantity being encoded
 * is ordered, so the colour has to be ordered too, and a red-to-green scale would
 * imply good/bad where none is meant. Text flips to white above the midpoint to
 * keep contrast usable at both ends.
 */
export function heatStyle(intensity: number, hue: 'indigo' | 'emerald' = 'indigo') {
  const t = Math.max(0, Math.min(1, Number.isFinite(intensity) ? intensity : 0));
  const ramp =
    hue === 'indigo'
      ? ['#EEF2FF', '#E0E7FF', '#C7D2FE', '#A5B4FC', '#818CF8', '#6366F1', '#4F46E5', '#4338CA']
      : ['#ECFDF5', '#D1FAE5', '#A7F3D0', '#6EE7B7', '#34D399', '#10B981', '#059669', '#047857'];
  const index = Math.min(ramp.length - 1, Math.round(t * (ramp.length - 1)));
  return {
    backgroundColor: ramp[index],
    color: index >= 5 ? '#FFFFFF' : '#1F2937',
  };
}

/** Legend strip for a heatmap, so the ramp is never unlabelled. */
export function HeatLegend({
  min,
  max,
  format,
  hue = 'indigo',
}: {
  min: number;
  max: number;
  format: (value: number) => string;
  hue?: 'indigo' | 'emerald';
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] text-gray-500">
      <span>{format(min)}</span>
      <div className="flex rounded overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <span key={i} className="w-5 h-3" style={{ backgroundColor: heatStyle(i / 7, hue).backgroundColor }} />
        ))}
      </div>
      <span>{format(max)}</span>
    </div>
  );
}

// ── Callouts ─────────────────────────────────────────────────────────────────

export function Callout({
  tone = 'amber',
  title,
  children,
}: {
  tone?: 'amber' | 'rose' | 'sky' | 'slate';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    amber: 'border-amber-200 bg-amber-50 text-amber-900',
    rose: 'border-rose-200 bg-rose-50 text-rose-900',
    sky: 'border-sky-200 bg-sky-50 text-sky-900',
    slate: 'border-gray-200 bg-gray-50 text-gray-700',
  } as const;
  return (
    <div className={`rounded-lg border px-4 py-3 text-xs leading-relaxed ${tones[tone]}`}>
      {title && <p className="font-semibold mb-1">{title}</p>}
      {children}
    </div>
  );
}

/**
 * Marks a data point as not-yet-final.
 *
 * Any month that has not ended is still selling, so its bar will keep growing.
 * Showing it identically to a closed month invites the reader to conclude the
 * business fell off a cliff this month; this label is the cheapest fix.
 */
export function Provisional() {
  return (
    <span className="ml-1.5 align-middle text-[10px] font-medium text-amber-600 bg-amber-50 rounded px-1 py-0.5">
      partial
    </span>
  );
}

// ── Recharts shared bits ─────────────────────────────────────────────────────

export const AXIS_TICK = { fontSize: 11, fill: '#9CA3AF' } as const;
export const AXIS_TICK_DARK = { fontSize: 12, fill: '#6B7280' } as const;
export const GRID_STROKE = '#F3F4F6';

export const TOOLTIP_STYLE = {
  fontSize: 12,
  borderRadius: 8,
  border: '1px solid #E5E7EB',
  boxShadow: '0 4px 12px rgba(0,0,0,0.06)',
} as const;

/** Chart series colours. Room hues echo `utils/roomVisuals.ts` (warm Deluxe /
 *  cool Urban) so a room keeps its identity across the whole app. */
export const ROOM_COLORS: Record<string, string> = {
  'K.102': '#14B8A6',
  'K.103': '#06B6D4',
  'K.106': '#0EA5E9',
  'K.201': '#F59E0B',
  'K.202': '#EAB308',
  'K.203': '#F97316',
  'O.308': '#F43F5E',
};

/** Sellable-unit hues — the group inherits the family colour of its rooms. */
export const UNIT_COLORS: Record<string, string> = {
  'urban-1kk': '#0EA5E9',
  'deluxe-1kk': '#EAB308',
  k201: '#F59E0B',
  o308: '#F43F5E',
};

export const COST_COLORS: Record<string, string> = {
  cleaning: '#6366F1',
  laundry: '#8B5CF6',
  consumables: '#10B981',
  wearTear: '#F59E0B',
  misc: '#94A3B8',
  subscriptions: '#0EA5E9',
};

export const SERIES_COLORS = ['#6366F1', '#10B981', '#F59E0B', '#F43F5E', '#8B5CF6', '#0EA5E9', '#94A3B8'];
