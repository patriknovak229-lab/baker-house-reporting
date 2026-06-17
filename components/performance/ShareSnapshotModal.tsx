'use client';

import { useState, useEffect, useCallback } from 'react';
import { ALL_ROOMS } from '@/data/performanceMockData';
import { formatDate } from '@/utils/formatters';
import { computeSnapshotData } from '@/utils/occupancySnapshot';
import type { DateRange } from '@/utils/periodUtils';
import type { Reservation, Room } from '@/types/reservation';
import type { OccupancySnapshot } from '@/types/occupancySnapshot';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Full unfiltered reservations (same array the page loaded). */
  reservations: Reservation[];
  initialRooms: Room[];
  initialRange: DateRange;
}

type StoredLink = OccupancySnapshot & { url: string };

/** Clean human label: "June 2026" for a full calendar month, else a range. */
function periodLabelFor(range: DateRange): string {
  const { start, end } = range;
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (sameMonth && start.endsWith('-01')) {
    const lastDay = new Date(Date.UTC(+start.slice(0, 4), +start.slice(5, 7), 0)).getUTCDate();
    if (+end.slice(8, 10) === lastDay) {
      return new Date(start + 'T00:00:00Z').toLocaleString('en-GB', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      });
    }
  }
  return `${formatDate(start)} – ${formatDate(end)}`;
}

export default function ShareSnapshotModal({
  open,
  onClose,
  reservations,
  initialRooms,
  initialRange,
}: Props) {
  const [rooms, setRooms] = useState<Room[]>(initialRooms);
  const [range, setRange] = useState<DateRange>(initialRange);
  const [includeGrossSales, setIncludeGrossSales] = useState(true);

  const [creating, setCreating] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [links, setLinks] = useState<StoredLink[]>([]);
  const [loadingLinks, setLoadingLinks] = useState(false);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // Re-seed from the page's current filters each time the modal opens.
  useEffect(() => {
    if (open) {
      setRooms(initialRooms);
      setRange(initialRange);
      setIncludeGrossSales(true);
      setCreatedUrl(null);
      setError(null);
    }
  }, [open, initialRooms, initialRange]);

  const loadLinks = useCallback(async () => {
    setLoadingLinks(true);
    try {
      const res = await fetch('/api/occupancy-snapshots');
      if (res.ok) {
        const body = await res.json();
        setLinks(Array.isArray(body?.snapshots) ? body.snapshots : []);
      }
    } catch {
      /* non-fatal */
    } finally {
      setLoadingLinks(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadLinks();
  }, [open, loadLinks]);

  const copy = useCallback((url: string) => {
    navigator.clipboard.writeText(url).then(
      () => {
        setCopied(url);
        setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
      },
      () => setError('Could not copy to clipboard'),
    );
  }, []);

  const handleCreate = useCallback(async () => {
    if (rooms.length === 0) {
      setError('Select at least one apartment.');
      return;
    }
    if (!range.start || !range.end || range.start > range.end) {
      setError('Pick a valid date range.');
      return;
    }
    setCreating(true);
    setError(null);
    setCreatedUrl(null);
    try {
      const data = computeSnapshotData(reservations, rooms, range, {
        includeGrossSales,
        label: periodLabelFor(range),
      });
      const res = await fetch('/api/occupancy-snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setCreatedUrl(body.url);
      copy(body.url);
      await loadLinks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create link');
    } finally {
      setCreating(false);
    }
  }, [rooms, range, includeGrossSales, reservations, copy, loadLinks]);

  const handleRegenerate = useCallback(
    async (link: StoredLink) => {
      setBusyToken(link.token);
      setError(null);
      try {
        const data = computeSnapshotData(
          reservations,
          link.data.rooms,
          { start: link.data.period.start, end: link.data.period.end },
          { includeGrossSales: link.data.includeGrossSales, label: link.data.period.label },
        );
        const res = await fetch('/api/occupancy-snapshots', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data, token: link.token }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
        await loadLinks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to refresh');
      } finally {
        setBusyToken(null);
      }
    },
    [reservations, loadLinks],
  );

  const handleRevoke = useCallback(
    async (token: string) => {
      setBusyToken(token);
      setError(null);
      try {
        const res = await fetch(`/api/occupancy-snapshots?token=${encodeURIComponent(token)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        await loadLinks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to revoke');
      } finally {
        setBusyToken(null);
      }
    },
    [loadLinks],
  );

  if (!open) return null;

  const toggleRoom = (room: Room) =>
    setRooms((prev) => (prev.includes(room) ? prev.filter((r) => r !== room) : [...prev, room]));

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-4">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Share occupancy snapshot</h2>
            <p className="text-xs text-gray-500 mt-0.5">
              A public, read-only link. Numbers are frozen at creation — no guest data is shared.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          {/* Apartments */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Apartments</p>
            <div className="flex flex-wrap gap-1.5">
              {ALL_ROOMS.map((room) => {
                const on = rooms.includes(room);
                return (
                  <button
                    key={room}
                    onClick={() => toggleRoom(room)}
                    className={`px-2.5 py-1 text-xs font-medium rounded border transition-colors ${
                      on
                        ? 'bg-indigo-100 text-indigo-700 border-indigo-200'
                        : 'bg-gray-100 text-gray-600 border-transparent hover:bg-gray-200'
                    }`}
                  >
                    {room}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Period */}
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">Period</p>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={range.start}
                onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <span className="text-gray-400 text-sm">→</span>
              <input
                type="date"
                value={range.end}
                onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                className="border border-gray-200 rounded-md px-2 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-300"
              />
              <span className="text-xs text-gray-400 ml-1">{periodLabelFor(range)}</span>
            </div>
          </div>

          {/* Gross sales toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeGrossSales}
              onChange={(e) => setIncludeGrossSales(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-indigo-600 focus:ring-indigo-400"
            />
            <span className="text-sm text-gray-700">
              Include <span className="font-medium">Gross Sales</span> on the link
            </span>
          </label>

          {error && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </div>
          )}

          {/* Create */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleCreate}
              disabled={creating}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
            >
              {creating ? 'Creating…' : 'Create share link'}
            </button>
            {createdUrl && (
              <span className="text-xs text-emerald-600 font-medium">
                {copied === createdUrl ? 'Copied to clipboard!' : 'Link created'}
              </span>
            )}
          </div>

          {createdUrl && (
            <div className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2">
              <input
                readOnly
                value={createdUrl}
                className="flex-1 bg-transparent text-sm text-gray-700 focus:outline-none"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                onClick={() => copy(createdUrl)}
                className="text-xs px-2.5 py-1 rounded bg-white border border-gray-300 text-gray-700 font-medium hover:bg-gray-100"
              >
                Copy
              </button>
              <a
                href={createdUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded bg-white border border-gray-300 text-gray-700 font-medium hover:bg-gray-100"
              >
                Open
              </a>
            </div>
          )}

          {/* Existing links */}
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
              Active links {loadingLinks ? '· loading…' : `· ${links.length}`}
            </p>
            {links.length === 0 ? (
              <p className="text-sm text-gray-400">No active share links.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {links.map((link) => (
                  <div
                    key={link.token}
                    className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {link.data.period.label}
                        {!link.data.includeGrossSales && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-gray-400">
                            no sales
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500 truncate">
                        {link.data.rooms.join(', ')} · taken {formatDate(link.createdAt.slice(0, 10))}
                        {link.expiresAt ? ` · expires ${formatDate(link.expiresAt.slice(0, 10))}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => copy(link.url)}
                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
                      >
                        {copied === link.url ? 'Copied' : 'Copy'}
                      </button>
                      <a
                        href={link.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-700 hover:bg-gray-100"
                      >
                        Open
                      </a>
                      <button
                        onClick={() => handleRegenerate(link)}
                        disabled={busyToken === link.token}
                        title="Refresh numbers to current data"
                        className="text-xs px-2 py-1 rounded border border-indigo-200 text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                      >
                        {busyToken === link.token ? '…' : 'Refresh'}
                      </button>
                      <button
                        onClick={() => handleRevoke(link.token)}
                        disabled={busyToken === link.token}
                        title="Revoke link"
                        className="text-xs px-2 py-1 rounded border border-rose-200 text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
