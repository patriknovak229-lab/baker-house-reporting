'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Reservation } from '@/types/reservation';
import type { BankTransaction } from '@/types/bankTransaction';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type {
  VariableCostsResponse,
  VariableCostsLookup,
} from '@/app/api/variable-costs/route';
import { COMMISSION_UNITS, COMMISSION_RATE } from '@/utils/commissionConfig';
import { computeSettlement, type VariableCostBundle, type ComputedSettlement } from '@/utils/commissionCalc';
import { formatCurrency } from '@/utils/formatters';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function defaultMonth(): string {
  // Last calendar month, in local time.
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function settlementId(unitId: string, month: string): string {
  return `settle-${unitId}-${month}`;
}

/** Turn a computed share into the snapshot shape the PDF/persist endpoints want. */
function toSnapshot(c: ComputedSettlement): CommissionSettlement {
  return {
    ...c,
    id: settlementId(c.unitId, c.month),
    status: 'issued',
    createdAt: '',
    createdBy: '',
  };
}

export default function CommissionPage() {
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [costs, setCosts] = useState<VariableCostBundle | null>(null);
  const [settlements, setSettlements] = useState<CommissionSettlement[]>([]);
  const [bankTx, setBankTx] = useState<BankTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState<string>(defaultMonth());
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bRes, cRes, sRes, tRes] = await Promise.all([
        fetch('/api/bookings'),
        fetch('/api/variable-costs'),
        fetch('/api/commission'),
        fetch('/api/bank-transactions'),
      ]);
      if (!bRes.ok) {
        const j = await bRes.json().catch(() => ({}));
        throw new Error(j.error ?? `Bookings HTTP ${bRes.status}`);
      }
      setReservations(await bRes.json());
      if (cRes.ok) {
        const body = (await cRes.json()) as VariableCostsResponse | VariableCostsLookup;
        if (body && typeof body === 'object' && 'byDateRoom' in body) {
          const r = body as VariableCostsResponse;
          setCosts({
            byDateRoom: r.byDateRoom,
            byReservation: r.byReservation ?? {},
            subscriptionItems: r.subscriptionItems ?? [],
            manualCleaningKeys: r.manualCleaningKeys ?? [],
            noLaundryKeys: r.noLaundryKeys ?? [],
            dismissedCleaningKeys: r.dismissedCleaningKeys ?? [],
          });
        } else {
          setCosts({
            byDateRoom: body as VariableCostsLookup,
            byReservation: {},
            subscriptionItems: [],
            manualCleaningKeys: [],
            noLaundryKeys: [],
            dismissedCleaningKeys: [],
          });
        }
      }
      if (sRes.ok) setSettlements(await sRes.json());
      if (tRes.ok) setBankTx(await tRes.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Compute the current-month settlement for every unit.
  const computed = useMemo(() => {
    if (!costs) return [];
    return COMMISSION_UNITS.map((u) => computeSettlement(u, month, reservations, costs));
  }, [costs, reservations, month]);

  const persistedFor = useCallback(
    (unitId: string) => settlements.find((s) => s.id === settlementId(unitId, month)),
    [settlements, month],
  );

  const totals = useMemo(() => {
    const gp = computed.reduce((s, c) => s + c.grossProfit, 0);
    const comm = computed.reduce((s, c) => s + c.commissionAmount, 0);
    const pay = computed.reduce((s, c) => s + c.payableToOwner, 0);
    return { gp, comm, pay };
  }, [computed]);

  async function handleIssue(c: ComputedSettlement, force = false) {
    setBusyUnit(c.unitId);
    try {
      const res = await fetch('/api/commission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...c, force }),
      });
      if (res.status === 409) {
        const j = await res.json();
        if (confirm(`${j.error}\n\nRe-issue anyway (this will unlink the bank payout)?`)) {
          return handleIssue(c, true);
        }
        return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Issue failed');
      const saved = (await res.json()) as CommissionSettlement;
      setSettlements((prev) => {
        const rest = prev.filter((s) => s.id !== saved.id);
        return [...rest, saved];
      });
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Issue failed');
    } finally {
      setBusyUnit(null);
    }
  }

  async function handleExport(snapshot: CommissionSettlement) {
    setBusyUnit(snapshot.unitId);
    try {
      const res = await fetch('/api/commission/pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snapshot),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? 'Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `Settlement_${snapshot.unitId.replace(/\./g, '')}_${snapshot.month}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusyUnit(null);
    }
  }

  async function handleLink(settlement: CommissionSettlement, bankTransactionId: string) {
    const res = await fetch(`/api/commission/${settlement.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'link_bank', bankTransactionId }),
    });
    if (res.ok) {
      const { settlement: updated, transaction } = await res.json();
      setSettlements((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      if (transaction) setBankTx((prev) => prev.map((t) => (t.id === transaction.id ? transaction : t)));
    }
  }

  async function handleUnlink(settlement: CommissionSettlement) {
    const res = await fetch(`/api/commission/${settlement.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unlink' }),
    });
    if (res.ok) {
      const { settlement: updated } = await res.json();
      setSettlements((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      setBankTx((prev) => prev.map((t) => (t.commissionSettlementId === settlement.id ? { ...t, commissionSettlementId: undefined } : t)));
    }
  }

  async function handleDelete(settlement: CommissionSettlement) {
    if (!confirm(`Delete the ${monthLabel(settlement.month)} settlement for ${settlement.unitId}?`)) return;
    const res = await fetch(`/api/commission/${settlement.id}`, { method: 'DELETE' });
    if (res.ok) {
      setSettlements((prev) => prev.filter((s) => s.id !== settlement.id));
      setBankTx((prev) => prev.map((t) => (t.commissionSettlementId === settlement.id ? { ...t, commissionSettlementId: undefined } : t)));
    }
  }

  // Candidate payouts: debit transactions not already linked to another settlement.
  const availablePayouts = useMemo(
    () => bankTx.filter((t) => t.direction === 'debit'),
    [bankTx],
  );

  const historyRows = useMemo(
    () => [...settlements].sort((a, b) => (b.month === a.month ? a.unitId.localeCompare(b.unitId) : b.month.localeCompare(a.month))),
    [settlements],
  );

  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map((i) => <div key={i} className="h-40 rounded-xl bg-gray-100 animate-pulse" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-gray-900">Commission</h2>
          <p className="text-sm text-gray-500">Owner settlements — 25% management commission on gross profit</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setMonth((m) => shiftMonth(m, -1))} className="px-2.5 py-2 text-gray-500 hover:text-gray-800">‹</button>
            <span className="px-3 text-sm font-medium text-gray-800 min-w-[92px] text-center">{monthLabel(month)}</span>
            <button onClick={() => setMonth((m) => shiftMonth(m, 1))} className="px-2.5 py-2 text-gray-500 hover:text-gray-800">›</button>
          </div>
          <button onClick={load} className="px-3 py-2 rounded-md border border-gray-200 bg-white text-sm font-medium text-gray-600 hover:bg-gray-50">Sync</button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error} <button onClick={load} className="underline ml-2">Retry</button>
        </div>
      )}

      {/* Summary tiles */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-indigo-50 rounded-xl p-4">
          <p className="text-xs font-medium text-indigo-500 uppercase tracking-wide mb-1">Total Gross Profit</p>
          <p className="text-xl font-bold text-indigo-700">{formatCurrency(totals.gp)}</p>
        </div>
        <div className="bg-amber-50 rounded-xl p-4">
          <p className="text-xs font-medium text-amber-600 uppercase tracking-wide mb-1">BHA Commission (25%)</p>
          <p className="text-xl font-bold text-amber-700">{formatCurrency(totals.comm)}</p>
        </div>
        <div className="bg-emerald-50 rounded-xl p-4">
          <p className="text-xs font-medium text-emerald-600 uppercase tracking-wide mb-1">Payable to Owners</p>
          <p className="text-xl font-bold text-emerald-700">{formatCurrency(totals.pay)}</p>
        </div>
      </div>

      {/* Unit cards */}
      <div className="grid gap-4 lg:grid-cols-3">
        {computed.map((c) => {
          const persisted = persistedFor(c.unitId);
          const expanded = expandedCard === c.unitId;
          const snapshot = persisted ?? toSnapshot(c);
          return (
            <div key={c.unitId} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col">
              <div className="flex items-start justify-between mb-1">
                <div>
                  <p className="text-lg font-bold text-gray-900">{c.unitId}</p>
                  <p className="text-xs text-gray-500">{c.ownerName}</p>
                </div>
                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${c.mode === 'urban-pool' ? 'bg-teal-100 text-teal-700' : 'bg-slate-100 text-slate-600'}`}>
                  {c.mode === 'urban-pool' ? `Pool ÷${c.poolDivisor}` : 'Standalone'}
                </span>
              </div>

              {/* Reconciliation status */}
              <div className={`mt-1 mb-3 text-[11px] font-medium px-2 py-1 rounded-md ${c.reconciles ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>
                {c.reconciles ? '✓ Reconciled with cleaning app' : `⚠ ${c.reconcileNote}`}
              </div>

              {/* Compact waterfall */}
              <dl className="text-sm space-y-1.5">
                <Row label="Net Sales" value={formatCurrency(c.netSales)} />
                <button onClick={() => setExpandedCard(expanded ? null : c.unitId)} className="w-full flex justify-between text-rose-600 hover:underline">
                  <dt>− Operational costs {expanded ? '▾' : '▸'}</dt>
                  <dd className="tabular-nums">−{formatCurrency(c.operationalCosts)}</dd>
                </button>
                {expanded && (
                  <div className="pl-3 border-l-2 border-rose-100 space-y-1 text-xs text-gray-500">
                    <Row small label="Cleaning" value={`−${formatCurrency(c.cleaning)}`} />
                    <Row small label="Laundry" value={`−${formatCurrency(c.laundry)}`} />
                    <Row small label="Consumables" value={`−${formatCurrency(c.consumables)}`} />
                    <Row small label="Subscriptions" value={`−${formatCurrency(c.subscriptions)}`} />
                    <Row small label="Wear & Tear" value={`−${formatCurrency(c.wearTear)}`} />
                    <Row small label="Misc" value={`−${formatCurrency(c.misc)}`} />
                  </div>
                )}
                <div className="flex justify-between pt-1.5 border-t border-gray-100 font-semibold text-gray-800">
                  <dt>Gross Profit</dt>
                  <dd className="tabular-nums">{formatCurrency(c.grossProfit)}</dd>
                </div>
                <Row label={`− Commission (${Math.round(COMMISSION_RATE * 100)}%)`} value={`−${formatCurrency(c.commissionAmount)}`} className="text-amber-700" />
              </dl>

              <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2.5 flex items-center justify-between">
                <span className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Payable to owner</span>
                <span className="text-lg font-bold text-emerald-700">{formatCurrency(c.payableToOwner)}</span>
              </div>

              {/* Actions */}
              <div className="mt-4 flex items-center gap-2">
                <button
                  onClick={() => handleExport(snapshot)}
                  disabled={busyUnit === c.unitId}
                  className="flex-1 px-3 py-2 rounded-md border border-indigo-200 bg-indigo-50 text-sm font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                >
                  {busyUnit === c.unitId ? '…' : 'Export PDF'}
                </button>
                <button
                  onClick={() => handleIssue(c)}
                  disabled={busyUnit === c.unitId}
                  className={`flex-1 px-3 py-2 rounded-md text-sm font-medium disabled:opacity-50 ${persisted ? 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50' : 'bg-indigo-600 text-white hover:bg-indigo-700'}`}
                >
                  {persisted ? (persisted.status === 'reconciled' ? 'Issued ✓ (reconciled)' : 'Re-issue') : 'Issue'}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* History */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <button onClick={() => setHistoryOpen((o) => !o)} className="w-full flex items-center justify-between px-5 py-3.5">
          <span className="text-sm font-semibold text-gray-800">
            Settlement history <span className="text-gray-400 font-normal">({settlements.length})</span>
          </span>
          <span className="text-gray-400">{historyOpen ? '▾' : '▸'}</span>
        </button>
        {historyOpen && (
          <div className="border-t border-gray-100 overflow-x-auto">
            {historyRows.length === 0 ? (
              <p className="px-5 py-6 text-sm text-gray-400">No settlements issued yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
                    <th className="px-4 py-2.5">Month</th>
                    <th className="px-4 py-2.5">Apartment</th>
                    <th className="px-4 py-2.5">Owner</th>
                    <th className="px-4 py-2.5 text-right">Payable</th>
                    <th className="px-4 py-2.5">Bank payout</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {historyRows.map((s) => {
                    const linkedTx = s.bankTransactionId ? bankTx.find((t) => t.id === s.bankTransactionId) : undefined;
                    return (
                      <tr key={s.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 whitespace-nowrap">{monthLabel(s.month)}</td>
                        <td className="px-4 py-2.5 font-medium text-gray-800">{s.unitId}</td>
                        <td className="px-4 py-2.5 text-gray-600">{s.ownerName}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-medium text-emerald-700">{formatCurrency(s.payableToOwner)}</td>
                        <td className="px-4 py-2.5">
                          {s.status === 'reconciled' && linkedTx ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Reconciled</span>
                              <span className="text-xs text-gray-500">{linkedTx.date} · {formatCurrency(linkedTx.amount)}</span>
                              <button onClick={() => handleUnlink(s)} className="text-xs text-gray-400 hover:text-rose-600 underline">unlink</button>
                            </span>
                          ) : (
                            <select
                              defaultValue=""
                              onChange={(e) => e.target.value && handleLink(s, e.target.value)}
                              className="text-xs border border-gray-200 rounded-md px-2 py-1 bg-white text-gray-600 max-w-[240px]"
                            >
                              <option value="">Link payout…</option>
                              {availablePayouts
                                .filter((t) => !t.commissionSettlementId || t.id === s.bankTransactionId)
                                .map((t) => (
                                  <option key={t.id} value={t.id}>
                                    {t.date} · {formatCurrency(t.amount)} · {t.counterpartyName ?? t.description ?? '—'}
                                  </option>
                                ))}
                            </select>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <button onClick={() => handleExport(s)} className="text-xs text-indigo-600 hover:underline mr-3">PDF</button>
                          <button onClick={() => handleDelete(s)} className="text-xs text-gray-400 hover:text-rose-600 hover:underline">Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, small, className }: { label: string; value: string; small?: boolean; className?: string }) {
  return (
    <div className={`flex justify-between ${small ? '' : ''} ${className ?? 'text-gray-700'}`}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
