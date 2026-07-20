'use client';

import { useState, useEffect, useCallback } from 'react';
import type { InvoiceRequest } from '@/types/invoiceRequest';

interface AutoReplyLogEntry {
  id: string;
  beds24MessageId: number;
  beds24SentMessageId: number | null;
  bookingId: number;
  reservationNumber: string;
  category: string;
  confidence: number;
  language: string;
  action: string;
  sentText: string | null;
  detail?: string;
  decidedAt: string;
}

type CategoryVerdict = 'ready' | 'almost' | 'review' | 'insufficient' | 'automated';

interface CategoryStat {
  category: string;
  surfaced: number;
  decided: number;
  approved: number;
  edited: number;
  dismissed: number;
  sent: number;
  cleanRate: number | null;
  dismissRate: number | null;
  avgEditSize: number | null;
  verdict: CategoryVerdict;
}

interface LogResponse {
  lastPollAt: string | null;
  logTotal: number;
  log: AutoReplyLogEntry[];
  categoryStats: CategoryStat[];
  statsWindow: number;
  activeInvoiceRequests: InvoiceRequest[];
  allInvoiceRequests: InvoiceRequest[];
}

/**
 * /auto-reply-log
 *
 * Diagnostic page for the messaging auto-reply pipeline. Shows the recent
 * audit trail + active invoice requests + last-poll timestamp so the
 * operator can verify webhook delivery and see what the LLM categoriser
 * decided for each message.
 *
 * Protected by NextAuth via proxy.ts (and the API route requires
 * admin/super). Linked from the dashboard footer / kebab menu — not part
 * of AppShell since it's a debug surface, not a primary tab.
 */
export default function AutoReplyLogPage() {
  const [data, setData] = useState<LogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/auto-reply-log');
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh every 30 s so operators can watch real-time activity
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [autoRefresh, load]);

  return (
    <div className="min-h-screen bg-gray-50 p-4 sm:p-8">
      <div className="max-w-6xl mx-auto">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-gray-900">Auto-reply log</h1>
            <p className="text-sm text-gray-500 mt-1">
              Last 100 actions from the guest-message webhook pipeline.{' '}
              {data?.lastPollAt && (
                <>Last webhook poll: <span className="font-mono text-gray-700">{formatTs(data.lastPollAt)}</span>.</>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-600 flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              Auto-refresh (30 s)
            </label>
            <button
              onClick={load}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md disabled:opacity-50"
            >
              {loading ? 'Refreshing…' : 'Refresh now'}
            </button>
          </div>
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Category readiness for auto-send — data-driven graduation view */}
        {data && data.categoryStats.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-1">
              Category readiness for auto-send
            </h2>
            <p className="text-xs text-gray-500 mb-3 max-w-3xl">
              How the operator has been treating each category&rsquo;s AI drafts across the last{' '}
              <span className="font-mono text-gray-700">{data.statsWindow}</span> log rows.{' '}
              <b>Clean</b> = draft sent untouched · <b>Edited</b> = changed before sending ·{' '}
              <b>Dismissed</b> = thrown away. A category is{' '}
              <span className="font-semibold text-emerald-700">Ready</span> when it has ≥10
              decisions, ≥85% clean and ≤10% dismissed.
            </p>
            <div className="rounded-lg border border-gray-200 bg-white overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-700">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Category</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Drafts surfaced for review">Surfaced</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Operator decisions: approved + edited + dismissed">Decided</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Sent untouched">Clean</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Edited before sending">Edited</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Discarded, never sent">Dismissed</th>
                    <th className="px-3 py-2 text-right text-xs font-medium uppercase tracking-wide" title="Avg fraction of words changed on the drafts that were edited">Avg edit</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Verdict</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.categoryStats.map((s) => (
                    <tr key={s.category} className="hover:bg-gray-50">
                      <td className="px-3 py-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${categoryClass(s.category)}`}>
                          {s.category}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-500">{s.surfaced}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-700">{s.decided}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-700 whitespace-nowrap">
                        {s.approved}
                        <span className="text-gray-400"> ({pct(s.cleanRate)})</span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-700">{s.edited}</td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-700 whitespace-nowrap">
                        {s.dismissed}
                        <span className="text-gray-400"> ({pct(s.dismissRate)})</span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs font-mono text-gray-500">
                        {s.avgEditSize == null ? '—' : pct(s.avgEditSize)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${verdictClass(s.verdict)}`}>
                          {verdictLabel(s.verdict)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Active invoice requests — most actionable surface */}
        {data && data.activeInvoiceRequests.length > 0 && (
          <section className="mb-8">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Active invoice requests ({data.activeInvoiceRequests.length})
            </h2>
            <div className="rounded-lg border border-amber-200 bg-amber-50 overflow-hidden">
              <table className="min-w-full text-sm">
                <thead className="bg-amber-100/60 text-amber-900">
                  <tr>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Status</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Reservation</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Company</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">ICO</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Email</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Asks</th>
                    <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Last asked</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-amber-200">
                  {data.activeInvoiceRequests.map((r) => (
                    <tr key={r.id}>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
                          r.status === 'awaiting-info' ? 'bg-amber-200 text-amber-900' : 'bg-gray-200 text-gray-800'
                        }`}>
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">{r.reservationNumber}</td>
                      <td className="px-3 py-2">{r.companyName ?? <span className="text-gray-400 italic">missing</span>}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.ico ?? <span className="text-gray-400 italic">missing</span>}</td>
                      <td className="px-3 py-2 font-mono text-xs">{r.email ?? <span className="text-gray-400 italic">missing</span>}</td>
                      <td className="px-3 py-2 text-xs">{r.asksCount ?? 0}</td>
                      <td className="px-3 py-2 text-xs text-gray-600">
                        {r.lastAskedAt ? formatTs(r.lastAskedAt) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* Audit log */}
        <section>
          <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wide mb-2">
            Recent actions ({data?.log.length ?? 0} of {data?.logTotal ?? 0} total)
          </h2>
          <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-gray-700">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">When</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Reservation</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Category</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Conf</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Lang</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Action</th>
                  <th className="px-3 py-2 text-left text-xs font-medium uppercase tracking-wide">Reply / Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {!data || data.log.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-gray-400 text-sm italic">
                      {loading ? 'Loading…' : 'No entries yet — webhook hasn’t fired or hasn’t processed anything.'}
                    </td>
                  </tr>
                ) : (
                  data.log.map((e) => (
                    <tr key={e.id} className="hover:bg-gray-50">
                      <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">{formatTs(e.decidedAt)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{e.reservationNumber}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${categoryClass(e.category)}`}>
                          {e.category}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {e.confidence != null ? e.confidence.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">{e.language || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${actionClass(e.action)}`}>
                          {e.action}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-gray-700 max-w-md">
                        {e.sentText ? (
                          <details>
                            <summary className="cursor-pointer truncate hover:text-indigo-700">
                              {e.sentText.split('\n')[0].slice(0, 100)}
                            </summary>
                            <pre className="mt-1 whitespace-pre-wrap font-sans text-xs text-gray-600 bg-gray-50 p-2 rounded">
                              {e.sentText}
                            </pre>
                          </details>
                        ) : (
                          <span className="text-gray-400 italic">{e.detail ?? '—'}</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

function formatTs(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function categoryClass(category: string): string {
  switch (category) {
    case 'parking': return 'bg-blue-100 text-blue-800 ring-1 ring-blue-200';
    case 'wifi': return 'bg-cyan-100 text-cyan-800 ring-1 ring-cyan-200';
    case 'minibar': return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200';
    case 'early-checkin': return 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200';
    case 'late-checkout': return 'bg-pink-100 text-pink-800 ring-1 ring-pink-200';
    case 'invoice-request': return 'bg-violet-100 text-violet-800 ring-1 ring-violet-200';
    default: return 'bg-gray-100 text-gray-700 ring-1 ring-gray-200';
  }
}

function actionClass(action: string): string {
  switch (action) {
    case 'sent':
    case 'sent-with-task':
      return 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200';
    case 'skipped-other':
    case 'skipped-no-template':
    case 'skipped-rate-limit':
      return 'bg-gray-100 text-gray-600 ring-1 ring-gray-200';
    case 'errored':
      return 'bg-red-100 text-red-800 ring-1 ring-red-200';
    default:
      return 'bg-gray-100 text-gray-700 ring-1 ring-gray-200';
  }
}

/** Format a 0–1 rate as a whole-number percentage, or “—” when unknown. */
function pct(rate: number | null): string {
  if (rate == null) return '—';
  return `${Math.round(rate * 100)}%`;
}

function verdictClass(verdict: CategoryVerdict): string {
  switch (verdict) {
    case 'ready':
      return 'bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200';
    case 'almost':
      return 'bg-amber-100 text-amber-800 ring-1 ring-amber-200';
    case 'review':
      return 'bg-indigo-100 text-indigo-800 ring-1 ring-indigo-200';
    case 'automated':
      return 'bg-violet-100 text-violet-800 ring-1 ring-violet-200';
    case 'insufficient':
    default:
      return 'bg-gray-100 text-gray-600 ring-1 ring-gray-200';
  }
}

function verdictLabel(verdict: CategoryVerdict): string {
  switch (verdict) {
    case 'ready':
      return '✅ Ready';
    case 'almost':
      return '🟡 Almost';
    case 'review':
      return 'Keep reviewing';
    case 'automated':
      return 'Automated flow';
    case 'insufficient':
    default:
      return 'Need more data';
  }
}
