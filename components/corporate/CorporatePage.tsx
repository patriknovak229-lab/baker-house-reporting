'use client';
/**
 * Corporate tab — standing agreements with companies for repeated stays.
 *
 * An agreement ("Acme: 1KK Urban or Deluxe, Mon + Tue nights, 12 Oct → 17
 * Dec, 1 850 Kč/night") generates one stay per occurrence; each stay becomes
 * an ordinary direct Beds24 booking, tagged so Transactions shows a Corporate
 * badge. This page lists the agreements, opens one for stay-by-stay management
 * (guest names, skips, retries, cancellations) and hosts the creation wizard.
 *
 * Reads its own data from /api/corporate/*; the Beds24 reservations needed
 * for the availability preview are fetched by the wizard only when opened.
 */
import { useCallback, useEffect, useState } from 'react';
import type { Role } from '@/utils/roles';
import { canMutate } from '@/utils/roles';
import { describeNights } from '@/utils/corporateSchedule';
import {
  formatCzk,
  formatStayDate,
  type AgreementDetail as AgreementDetailDto,
  type AgreementListItem,
} from '@/utils/corporateShared';
import { AgreementStatusBadge, roomShortLabel } from './ui';
import NewAgreementModal from './NewAgreementModal';
import AgreementDetail from './AgreementDetail';

export default function CorporatePage({ role }: { role?: Role }) {
  const allowed = !!role && canMutate(role, 'corporate');

  const [agreements, setAgreements] = useState<AgreementListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AgreementDetailDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/corporate/agreements');
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setAgreements(json.agreements ?? []);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/corporate/agreements/${encodeURIComponent(id)}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setDetail(json.agreement);
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
    else setDetail(null);
  }, [selectedId, loadDetail]);

  const list = agreements ?? [];
  const stats = {
    active: list.filter((a) => a.status === 'active').length,
    created: list.reduce((n, a) => n + a.summary.created, 0),
    pending: list.reduce((n, a) => n + a.summary.planned + a.summary.failed, 0),
    value: list
      .filter((a) => a.status !== 'cancelled')
      .reduce((n, a) => n + a.summary.priceCzk, 0),
  };

  return (
    <div className="max-w-screen-2xl mx-auto px-3 sm:px-6 py-6 sm:py-8 space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Corporate</h1>
          <p className="text-sm text-gray-500 mt-1">
            Standing agreements with companies: repeated stays created in Beds24 as direct bookings and invoiced to the company.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void loadList()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-white border border-gray-200 text-gray-600 text-sm font-medium hover:bg-gray-50 disabled:opacity-50 shadow-sm"
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {allowed && (
            <button
              onClick={() => setShowNew(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium transition-colors shadow-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New agreement
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Active agreements', value: String(stats.active) },
          { label: 'Bookings created', value: String(stats.created) },
          { label: 'Stays still to create', value: String(stats.pending) },
          { label: 'Agreed value', value: formatCzk(stats.value) },
        ].map((t) => (
          <div key={t.label} className="rounded-lg border border-gray-200 bg-white px-4 py-3">
            <div className="text-[11px] uppercase tracking-wide text-gray-400">{t.label}</div>
            <div className="text-lg font-semibold text-gray-900 mt-0.5">{t.value}</div>
          </div>
        ))}
      </div>

      {/* Agreement list */}
      <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
        {agreements === null ? (
          <div className="p-8 text-center text-sm text-gray-400">Loading agreements…</div>
        ) : list.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-gray-600">No corporate agreements yet</p>
            <p className="text-xs text-gray-400 mt-1">
              When a company asks for a repeating stay, create an agreement and the bookings are generated from it.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Company</th>
                  <th className="text-left px-3 py-2 font-medium">Pattern</th>
                  <th className="text-left px-3 py-2 font-medium">Rooms</th>
                  <th className="text-left px-3 py-2 font-medium">Stays</th>
                  <th className="text-right px-3 py-2 font-medium">Nights</th>
                  <th className="text-right px-3 py-2 font-medium">Value</th>
                  <th className="text-left px-3 py-2 font-medium">Pricing</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {list.map((a) => {
                  const s = a.summary;
                  const selected = a.id === selectedId;
                  return (
                    <tr
                      key={a.id}
                      onClick={() => setSelectedId(selected ? null : a.id)}
                      className={`cursor-pointer transition-colors ${selected ? 'bg-indigo-50/60' : 'hover:bg-gray-50'}`}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-gray-900">{a.companyName}</div>
                        <div className="text-[11px] text-gray-400">
                          {a.repName ?? '—'}
                          {a.repPhone ? ` · ${a.repPhone}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-gray-700 whitespace-nowrap">
                        <div>{describeNights(a.nightWeekdays)}</div>
                        <div className="text-[11px] text-gray-400">
                          {formatStayDate(a.startDate)} → {formatStayDate(a.endDate)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-gray-700">
                        <div className="flex flex-wrap gap-1">
                          {a.roomIds.map((id) => (
                            <span
                              key={id}
                              className={`rounded px-1.5 py-0.5 text-[11px] ${
                                id === (a.preferredRoomId ?? a.roomIds[0])
                                  ? 'bg-indigo-100 text-indigo-800'
                                  : 'bg-gray-100 text-gray-600'
                              }`}
                            >
                              {roomShortLabel(id)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 whitespace-nowrap text-xs">
                        <span className="text-green-700 font-medium">{s.created} created</span>
                        {s.planned > 0 && <span className="text-gray-500"> · {s.planned} planned</span>}
                        {s.failed > 0 && <span className="text-red-600"> · {s.failed} failed</span>}
                        {s.skipped > 0 && <span className="text-amber-600"> · {s.skipped} skipped</span>}
                        {s.cancelled > 0 && <span className="text-rose-600"> · {s.cancelled} cancelled</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-gray-700 tabular-nums">{s.nights}</td>
                      <td className="px-3 py-3 text-right text-gray-900 font-medium tabular-nums whitespace-nowrap">
                        {formatCzk(s.priceCzk)}
                        {s.unpriced > 0 && (
                          <div className="text-[11px] font-normal text-amber-600">{s.unpriced} unpriced</div>
                        )}
                      </td>
                      <td className="px-3 py-3 text-xs text-gray-600 whitespace-nowrap">
                        {a.pricingMode === 'flat'
                          ? `Flat ${formatCzk(a.flatNightPriceCzk ?? 0)}/night`
                          : a.discountPercent > 0
                            ? `Web price −${a.discountPercent}%`
                            : 'Web price'}
                      </td>
                      <td className="px-3 py-3">
                        <AgreementStatusBadge status={a.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Detail panel */}
      {selectedId && (
        <div className="rounded-lg border border-indigo-200 bg-white shadow-sm">
          {detailLoading && !detail ? (
            <div className="p-8 text-center text-sm text-gray-400">Loading agreement…</div>
          ) : detail ? (
            <AgreementDetail
              agreement={detail}
              canEdit={allowed}
              onChanged={(a) => {
                setDetail(a);
                void loadList();
              }}
              onDeleted={() => {
                setSelectedId(null);
                void loadList();
              }}
              onClose={() => setSelectedId(null)}
            />
          ) : null}
        </div>
      )}

      {showNew && (
        <NewAgreementModal
          onClose={() => setShowNew(false)}
          onCreated={(a) => {
            setShowNew(false);
            setDetail(a);
            setSelectedId(a.id);
            void loadList();
          }}
        />
      )}
    </div>
  );
}
