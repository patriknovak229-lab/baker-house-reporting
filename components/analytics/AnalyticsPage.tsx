'use client';
/**
 * The analytics section shell: filters, section tabs, lazy per-section loading.
 *
 * WHY THIS IS A STANDALONE PAGE, NOT AN AppShell TAB
 * -------------------------------------------------
 * `AppShell` conditionally renders each tab, so switching tabs unmounts and
 * remounts the whole page and re-fires its mount effects — the exact behaviour
 * that made `/api/bookings` hammer Beds24 until the 90s sync guard was added.
 * Analytics is heavier than any existing tab and answers a different kind of
 * question, so it lives at its own route (like `/auto-reply-log`): its code is
 * never in the operational bundle, its data never touches the bookings sync, and
 * a section can be linked to directly.
 *
 * Sections fetch ONLY when first opened and then cache in memory for the current
 * filter set. Changing a filter invalidates the cache — but nothing refetches
 * until the section is actually on screen, so exploring filters on Overview never
 * pays for the Redis-backed cost query.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type {
  AnalyticsMeta,
  BookingWindowResponse,
  CostsResponse,
  MarketResponse,
  OccupancyResponse,
  OverviewResponse,
  RatesResponse,
} from '@/utils/analyticsTypes';
import { ALL_ROOMS_BY_CATEGORY, groupRoomsByCategory } from '@/utils/roomCategory';
import { Callout } from './kit';
import FilterBar, { type AnalyticsFilters, defaultFilters, filtersToQuery } from './FilterBar';
import OverviewSection from './OverviewSection';
import OccupancySection from './OccupancySection';
import BookingWindowSection from './BookingWindowSection';
import RatesSection from './RatesSection';
import CostsSection from './CostsSection';

/**
 * The five questions the section exists to answer, in the order a revenue decision
 * gets made: how much did we make, how full were we, when did it sell, what rate did
 * it sell at, what did it cost to deliver.
 */
const SECTIONS = [
  { id: 'overview', label: 'Overview', blurb: 'Volume, ADR and net' },
  { id: 'occupancy', label: 'Occupancy', blurb: 'How full, and where we ran out' },
  { id: 'booking-window', label: 'Booking window', blurb: 'How far ahead, and what sticks' },
  { id: 'rates', label: 'Rates', blurb: 'What the ADR is made of' },
  { id: 'costs', label: 'Costs & commissions', blurb: 'What a night costs to sell and service' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

interface SectionState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

const idle = <T,>(): SectionState<T> => ({ data: null, loading: false, error: null });

export default function AnalyticsPage({
  canRefreshMarket = false,
}: {
  /** Admin/super only — the refresh spends PriceLabs credit. */
  canRefreshMarket?: boolean;
}) {
  const [filters, setFilters] = useState<AnalyticsFilters>(defaultFilters);
  const [section, setSection] = useState<SectionId>('overview');

  const [meta, setMeta] = useState<AnalyticsMeta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);

  const [overview, setOverview] = useState<SectionState<OverviewResponse>>(idle);
  const [occupancy, setOccupancy] = useState<SectionState<OccupancyResponse>>(idle);
  const [bookingWindow, setBookingWindow] = useState<SectionState<BookingWindowResponse>>(idle);
  const [rates, setRates] = useState<SectionState<RatesResponse>>(idle);
  const [costs, setCosts] = useState<SectionState<CostsResponse>>(idle);

  /**
   * The market benchmark is loaded once at page level rather than per section,
   * because three sections overlay it and it is a cheap local Postgres read — the
   * PriceLabs call happens on a daily cron, never here. A failure is swallowed on
   * purpose: every section renders our own data with the market lines simply absent.
   */
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const query = useMemo(() => filtersToQuery(filters), [filters]);

  // The filter signature every cached section was fetched under. When it changes
  // every section is dropped, but only the visible one refetches.
  const loadedFor = useRef<Record<SectionId, string | null>>({
    overview: null,
    occupancy: null,
    'booking-window': null,
    rates: null,
    costs: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch('/api/analytics/meta')
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        return body as AnalyticsMeta;
      })
      .then((body) => {
        if (!cancelled) setMeta(body);
      })
      .catch((err) => {
        if (!cancelled) setMetaError(err instanceof Error ? err.message : 'Failed to load coverage');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Market snapshot: refetched whenever the scope changes, since MPI and the market
  // series are both scope-dependent. Errors are deliberately not surfaced — an
  // absent benchmark is a normal state, not a page failure.
  useEffect(() => {
    let cancelled = false;
    setMarket(null);
    fetch(`/api/analytics/market?${query}`)
      .then(async (res) => (res.ok ? ((await res.json()) as MarketResponse) : null))
      .then((body) => {
        if (!cancelled) setMarket(body);
      })
      .catch(() => {
        if (!cancelled) setMarket(null);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const load = useCallback(
    async <T,>(
      id: SectionId,
      path: string,
      setState: (next: SectionState<T>) => void,
    ): Promise<void> => {
      if (loadedFor.current[id] === query) return;
      loadedFor.current[id] = query;
      setState({ data: null, loading: true, error: null });
      try {
        const res = await fetch(`/api/analytics/${path}?${query}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        setState({ data: body as T, loading: false, error: null });
      } catch (err) {
        // Clear the signature so switching back retries rather than showing a
        // permanently stuck error.
        loadedFor.current[id] = null;
        setState({
          data: null,
          loading: false,
          error: err instanceof Error ? err.message : 'Failed to load',
        });
      }
    },
    [query],
  );

  // Lazy: only the visible section fetches, and only once per filter signature.
  useEffect(() => {
    if (section === 'overview') void load<OverviewResponse>('overview', 'overview', setOverview);
    if (section === 'occupancy') void load<OccupancyResponse>('occupancy', 'occupancy', setOccupancy);
    if (section === 'booking-window')
      void load<BookingWindowResponse>('booking-window', 'booking-window', setBookingWindow);
    if (section === 'rates') void load<RatesResponse>('rates', 'rates', setRates);
    if (section === 'costs') void load<CostsResponse>('costs', 'costs', setCosts);
  }, [section, load]);

  const resetCaches = useCallback(() => {
    loadedFor.current = {
      overview: null,
      occupancy: null,
      'booking-window': null,
      rates: null,
      costs: null,
    };
    setOverview(idle);
    setOccupancy(idle);
    setBookingWindow(idle);
    setRates(idle);
    setCosts(idle);
  }, []);

  const onFiltersChange = useCallback(
    (next: AnalyticsFilters) => {
      resetCaches();
      setFilters(next);
    },
    [resetCaches],
  );

  const roomGroups = useMemo(() => groupRoomsByCategory(), []);

  /**
   * Pull a fresh PriceLabs snapshot, then re-read the market endpoint.
   *
   * Two calls rather than one because the refresh writes to Postgres and the read
   * is scope-aware — having the writer also return the shaped response would tie
   * the cron's payload to whatever filters happened to be on screen.
   */
  const refreshMarket = useCallback(async () => {
    setRefreshing(true);
    setRefreshNote(null);
    try {
      const res = await fetch('/api/analytics/market/refresh', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      const failed = (body?.listings ?? []).filter((l: { error: string | null }) => l.error);
      setRefreshNote(
        failed.length > 0
          ? `Refreshed with ${failed.length} listing${failed.length === 1 ? '' : 's'} failing — older rows kept for those.`
          : 'Market snapshot refreshed.',
      );
      const next = await fetch(`/api/analytics/market?${query}`);
      setMarket(next.ok ? ((await next.json()) as MarketResponse) : null);
    } catch (err) {
      setRefreshNote(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }, [query]);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-screen-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <header className="flex flex-wrap items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold text-gray-900">Analytics</h1>
              <Link
                href="/"
                className="text-xs text-gray-400 hover:text-gray-600 transition-colors print:hidden"
              >
                ← Dashboard
              </Link>
            </div>
            <p className="text-sm text-gray-500 mt-0.5">
              Baker House Apartments · read from the Postgres bookings archive, not a live Beds24 sync
            </p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            {canRefreshMarket && (
              <div className="flex items-center gap-2">
                {refreshNote && (
                  <span className="text-[11px] text-gray-500 max-w-[16rem] text-right leading-snug">
                    {refreshNote}
                  </span>
                )}
                <button
                  onClick={() => void refreshMarket()}
                  disabled={refreshing}
                  title="Pull a fresh PriceLabs market snapshot. Runs daily on a cron anyway."
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                    />
                  </svg>
                  {refreshing ? 'Refreshing market…' : 'Refresh market'}
                </button>
              </div>
            )}
          <button
            onClick={() => window.print()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-700 hover:bg-indigo-100 transition-colors shadow-sm print:hidden"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
              />
            </svg>
            Export PDF
          </button>
          </div>
        </header>

        {metaError && (
          <div className="mb-5">
            <Callout tone="rose" title="Could not read data coverage">
              {metaError}
            </Callout>
          </div>
        )}

        {meta && (meta.mirrorStale || meta.caveats.length > 0) && (
          <details className="mb-5 group" open={meta.mirrorStale}>
            <summary className="cursor-pointer list-none">
              <div
                className={`rounded-lg border px-4 py-3 text-xs flex items-center gap-2 ${
                  meta.mirrorStale
                    ? 'border-rose-200 bg-rose-50 text-rose-900'
                    : 'border-gray-200 bg-white text-gray-600'
                }`}
              >
                <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="font-medium">
                  {meta.mirrorStale
                    ? 'The bookings archive is stale — figures are not live'
                    : `Data coverage: ${meta.rows.bookings.toLocaleString('cs-CZ')} bookings, ${meta.coverage.firstCheckIn ?? '—'} onward`}
                </span>
                <span className="ml-auto text-[11px] opacity-70 group-open:hidden">
                  {meta.caveats.length} note{meta.caveats.length === 1 ? '' : 's'} — show
                </span>
                <span className="ml-auto text-[11px] opacity-70 hidden group-open:inline">hide</span>
              </div>
            </summary>
            <ul className="mt-2 space-y-1.5 pl-1">
              {meta.caveats.map((c, i) => (
                <li key={i} className="text-xs text-gray-600 flex gap-2 leading-relaxed">
                  <span className="text-gray-300 mt-0.5">•</span>
                  <span>{c}</span>
                </li>
              ))}
              <li className="text-xs text-gray-400 flex gap-2 pt-1">
                <span className="text-gray-300 mt-0.5">•</span>
                <span>
                  Archive last written{' '}
                  {meta.mirrorLastSyncedAt
                    ? new Date(meta.mirrorLastSyncedAt).toLocaleString('cs-CZ')
                    : 'never'}
                  .
                </span>
              </li>
            </ul>
          </details>
        )}

        <FilterBar
          filters={filters}
          onChange={onFiltersChange}
          roomGroups={roomGroups}
          allRooms={[...ALL_ROOMS_BY_CATEGORY]}
          channels={meta?.channels ?? []}
        />

        <nav className="flex gap-1 mt-6 mb-6 overflow-x-auto -mx-1 px-1 print:hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSection(s.id)}
              className={`px-4 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 text-left ${
                section === s.id
                  ? 'bg-white border border-gray-200 shadow-sm text-indigo-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-white/60 border border-transparent'
              }`}
            >
              <span className="block">{s.label}</span>
              <span
                className={`block text-[11px] font-normal ${
                  section === s.id ? 'text-gray-400' : 'text-gray-400'
                }`}
              >
                {s.blurb}
              </span>
            </button>
          ))}
        </nav>

        {section === 'overview' && (
          <SectionFrame state={overview} onRetry={() => { loadedFor.current.overview = null; void load<OverviewResponse>('overview', 'overview', setOverview); }}>
            {(data) => <OverviewSection data={data} market={market} />}
          </SectionFrame>
        )}
        {section === 'occupancy' && (
          <SectionFrame state={occupancy} onRetry={() => { loadedFor.current.occupancy = null; void load<OccupancyResponse>('occupancy', 'occupancy', setOccupancy); }}>
            {(data) => <OccupancySection data={data} market={market} />}
          </SectionFrame>
        )}
        {section === 'booking-window' && (
          <SectionFrame state={bookingWindow} onRetry={() => { loadedFor.current['booking-window'] = null; void load<BookingWindowResponse>('booking-window', 'booking-window', setBookingWindow); }}>
            {(data) => <BookingWindowSection data={data} market={market} />}
          </SectionFrame>
        )}
        {section === 'rates' && (
          <SectionFrame state={rates} onRetry={() => { loadedFor.current.rates = null; void load<RatesResponse>('rates', 'rates', setRates); }}>
            {(data) => <RatesSection data={data} market={market} />}
          </SectionFrame>
        )}
        {section === 'costs' && (
          <SectionFrame state={costs} onRetry={() => { loadedFor.current.costs = null; void load<CostsResponse>('costs', 'costs', setCosts); }}>
            {(data) => <CostsSection data={data} />}
          </SectionFrame>
        )}
      </div>
    </div>
  );
}

function SectionFrame<T>({
  state,
  onRetry,
  children,
}: {
  state: SectionState<T>;
  onRetry: () => void;
  children: (data: T) => React.ReactNode;
}) {
  if (state.loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-24 rounded-xl bg-gray-100 animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-64 rounded-xl bg-gray-100 animate-pulse" />
        ))}
      </div>
    );
  }
  if (state.error) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
          />
        </svg>
        <span>{state.error}</span>
        <button onClick={onRetry} className="ml-auto font-medium underline underline-offset-2 hover:text-red-900">
          Retry
        </button>
      </div>
    );
  }
  if (!state.data) return null;
  return <div className="space-y-6">{children(state.data)}</div>;
}
