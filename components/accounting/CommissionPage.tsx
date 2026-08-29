'use client';
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Reservation } from '@/types/reservation';
import type { BankTransaction } from '@/types/bankTransaction';
import type { CommissionSettlement } from '@/types/commissionSettlement';
import type {
  VariableCostsResponse,
  VariableCostsLookup,
} from '@/utils/variableCostsShared';
import { COMMISSION_UNITS, COMMISSION_RATE, getCommissionUnit } from '@/utils/commissionConfig';
import { computeSettlement, cleaningEventsForUnit, negativePayableWarning, type VariableCostBundle, type ComputedSettlement } from '@/utils/commissionCalc';
import { formatCurrency } from '@/utils/formatters';
import AnnualCommissionTable from '@/components/accounting/AnnualCommissionTable';

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
  const [logUnitId, setLogUnitId] = useState<string | null>(null);
  const [ownerEmails, setOwnerEmails] = useState<Record<string, string>>({});
  const [emailModal, setEmailModal] = useState<CommissionSettlement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [bRes, cRes, sRes, tRes, eRes] = await Promise.all([
        fetch('/api/bookings'),
        fetch('/api/variable-costs'),
        fetch('/api/commission'),
        fetch('/api/bank-transactions'),
        fetch('/api/commission/email'),
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
      if (eRes.ok) setOwnerEmails(await eRes.json());
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

  async function handleIssue(
    c: ComputedSettlement,
    opts: { force?: boolean; acknowledgeNegative?: boolean } = {},
  ) {
    setBusyUnit(c.unitId);
    try {
      const res = await fetch('/api/commission', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...c, ...opts }),
      });
      if (res.status === 409) {
        const j = await res.json();
        // Two distinct blocks land here — confirm with the right question for each,
        // and carry the previous acknowledgements forward so a settlement that hits
        // both doesn't loop.
        if (j.code === 'negative-payable') {
          if (confirm(`${j.error}\n\nIssue this negative settlement anyway?`)) {
            return handleIssue(c, { ...opts, acknowledgeNegative: true });
          }
          return;
        }
        if (confirm(`${j.error}\n\nRe-issue anyway (this will unlink the bank payout)?`)) {
          return handleIssue(c, { ...opts, force: true });
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

              {/* Reconciliation status — click to inspect the cleaning events */}
              <button
                onClick={() => setLogUnitId(c.unitId)}
                title="View cleaning events for this month"
                className={`mt-1 mb-3 w-full flex items-center justify-between gap-2 text-[11px] font-medium px-2 py-1 rounded-md transition-colors ${c.reconciles ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : 'bg-amber-50 text-amber-700 hover:bg-amber-100'}`}
              >
                <span>{c.reconciles ? '✓ Reconciled with cleaning app' : `⚠ ${c.reconcileNote}`}</span>
                <span className="opacity-60 underline underline-offset-2 whitespace-nowrap">view log</span>
              </button>

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
                    {(c.subscriptionBreakdown ?? []).map((line) => (
                      <Row
                        key={line.id}
                        small
                        label={`· ${line.label}`}
                        value={`−${formatCurrency(line.amount)}`}
                        className="text-gray-400 pl-3"
                      />
                    ))}
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

              {/* A negative payable means costs exceeded net sales. Most often that's
                  a bookings sync that returned no reservations, not a real month —
                  and issuing freezes the figure for good, so flag it in place rather
                  than only in the confirm dialog. */}
              <div
                className={`mt-3 rounded-lg px-3 py-2.5 flex items-center justify-between ${
                  c.payableToOwner < 0 ? 'bg-rose-50' : 'bg-emerald-50'
                }`}
              >
                <span
                  className={`text-xs font-semibold uppercase tracking-wide ${
                    c.payableToOwner < 0 ? 'text-rose-700' : 'text-emerald-700'
                  }`}
                >
                  {c.payableToOwner < 0 ? 'Owner would owe' : 'Payable to owner'}
                </span>
                <span className={`text-lg font-bold ${c.payableToOwner < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
                  {formatCurrency(c.payableToOwner)}
                </span>
              </div>
              {negativePayableWarning(c) && (
                <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-[11px] leading-snug text-rose-700">
                  ⚠ {negativePayableWarning(c)!.message}
                </p>
              )}

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

      {/* Whole-year view — every apartment, month by month */}
      <AnnualCommissionTable reservations={reservations} costs={costs} settlements={settlements} />

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
                    <th className="px-4 py-2.5">Status</th>
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
                        <td className="px-4 py-2.5"><StatusBadges settlement={s} /></td>
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
                          <button onClick={() => setEmailModal(s)} className="text-xs text-emerald-600 hover:underline mr-3">Email owner</button>
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

      {/* Cleaning-events drill-down */}
      {logUnitId && costs && (() => {
        const unit = getCommissionUnit(logUnitId);
        if (!unit) return null;
        const events = cleaningEventsForUnit(unit, month, costs);
        const withLaundry = events.filter((e) => e.hasLaundry).length;
        const noLaundry = events.length - withLaundry;
        const scope = unit.mode === 'urban-pool' ? 'Urban pool (K.102 + K.103 + K.106)' : unit.id;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setLogUnitId(null)}>
            <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-start justify-between px-5 py-4 border-b border-gray-100">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">Cleaning events — {monthLabel(month)}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">{scope}</p>
                </div>
                <button onClick={() => setLogUnitId(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
              </div>

              <div className="flex gap-2 px-5 py-3 border-b border-gray-100 text-xs">
                <span className="px-2 py-1 rounded-md bg-gray-100 text-gray-700 font-medium">{events.length} cleanings</span>
                <span className="px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 font-medium">{withLaundry} with laundry</span>
                <span className={`px-2 py-1 rounded-md font-medium ${noLaundry > 0 ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-400'}`}>{noLaundry} no laundry</span>
              </div>

              <div className="overflow-y-auto">
                {events.length === 0 ? (
                  <p className="px-5 py-8 text-sm text-gray-400 text-center">No cleaning events this month.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="text-left text-xs text-gray-500 uppercase tracking-wide border-b border-gray-100">
                        <th className="px-5 py-2">Date</th>
                        <th className="px-3 py-2">Room</th>
                        <th className="px-3 py-2 text-right">Cleaning</th>
                        <th className="px-3 py-2 text-right">Laundry</th>
                        <th className="px-5 py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {events.map((e) => (
                        <tr key={`${e.date}|${e.roomId}`} className={e.hasLaundry ? '' : 'bg-amber-50/50'}>
                          <td className="px-5 py-2 whitespace-nowrap tabular-nums">{e.date}</td>
                          <td className="px-3 py-2 font-medium text-gray-800">{e.room}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">{formatCurrency(e.cleaning)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-gray-600">
                            {e.hasLaundry ? `${formatCurrency(e.laundry)} · ${e.sets} set${e.sets !== 1 ? 's' : ''}` : '—'}
                          </td>
                          <td className="px-5 py-2">
                            {e.hasLaundry ? (
                              <span className="text-xs text-emerald-600">✓ laundry</span>
                            ) : (
                              <span className="text-xs font-medium text-amber-700">⚠ no laundry provider</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="px-5 py-3 border-t border-gray-100 text-[11px] text-gray-500">
                A cleaning with <span className="text-amber-700 font-medium">no laundry provider</span> either had no linen change or is missing an assignment in the cleaning app. Amounts here are the raw cleaning-app costs before the ÷{unit.mode === 'urban-pool' ? '3 pool split' : '1'}.
              </div>
            </div>
          </div>
        );
      })()}

      {/* Email settlement to owner */}
      {emailModal && (
        <EmailOwnerModal
          settlement={emailModal}
          defaultEmail={ownerEmails[emailModal.ownerName] ?? ''}
          onClose={() => setEmailModal(null)}
          onSaved={(ownerName, email) => setOwnerEmails((prev) => ({ ...prev, [ownerName]: email }))}
          onSent={(updated) => setSettlements((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))}
        />
      )}
    </div>
  );
}

function EmailOwnerModal({
  settlement,
  defaultEmail,
  onClose,
  onSaved,
  onSent,
}: {
  settlement: CommissionSettlement;
  defaultEmail: string;
  onClose: () => void;
  onSaved: (ownerName: string, email: string) => void;
  onSent: (updated: CommissionSettlement) => void;
}) {
  const [email, setEmail] = useState(defaultEmail);
  const [saveEmail, setSaveEmail] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  async function send() {
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/commission/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settlement, email: email.trim(), saveEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Send failed');
      if (saveEmail) onSaved(settlement.ownerName, email.trim());
      if (data.settlement) onSent(data.settlement as CommissionSettlement);
      setSent(true);
      setTimeout(onClose, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Send failed');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">Email settlement to owner</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            {settlement.unitId} · {settlement.ownerName} · payable {formatCurrency(settlement.payableToOwner)}
          </p>
        </div>
        <div className="px-5 py-4 space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-gray-600">Owner email</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="owner@example.com"
              autoFocus
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={saveEmail} onChange={(e) => setSaveEmail(e.target.checked)} className="rounded border-gray-300" />
            Save this email for {settlement.ownerName}&apos;s future settlements
          </label>
          <p className="text-[11px] text-gray-400">
            Sends the PDF statement as an attachment. The owner&apos;s address is stored for pre-fill only.
          </p>
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </div>
        <div className="px-5 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-3 py-2 rounded-md text-sm text-gray-600 hover:bg-gray-50">Cancel</button>
          <button
            onClick={send}
            disabled={!valid || sending || sent}
            className="px-4 py-2 rounded-md bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
          >
            {sent ? '✓ Sent' : sending ? 'Sending…' : 'Send PDF'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Composable status badges for a settlement. "Issued" shows only until it has
 *  been sent or paid; "Sent" and "Paid out" co-exist. */
function StatusBadges({ settlement }: { settlement: CommissionSettlement }) {
  const sent = !!settlement.emailedAt;
  const paidOut = !!settlement.bankTransactionId;
  const pill = (label: string, cls: string, title?: string) => (
    <span title={title} className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>{label}</span>
  );
  return (
    <div className="flex flex-wrap items-center gap-1">
      {!sent && !paidOut && pill('Issued', 'bg-slate-100 text-slate-600')}
      {sent && pill('Sent', 'bg-sky-100 text-sky-700', settlement.emailedAt ? `Emailed ${settlement.emailedTo ?? ''} on ${new Date(settlement.emailedAt).toLocaleDateString('en-GB')}` : undefined)}
      {paidOut && pill('Paid out', 'bg-emerald-100 text-emerald-700', settlement.reconciledAt ? `Linked ${new Date(settlement.reconciledAt).toLocaleDateString('en-GB')}` : undefined)}
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
