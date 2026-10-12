'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';
import { QRCodeSVG } from 'qrcode.react';
import type { Role } from '@/utils/roles';
import type {
  OtaTaxDocument, VatA2Row, VatConfig, VatDecision, VatFlag, VatMonthResult, VatOverview, VatSettings,
} from '@/types/vat';
import { formatHal } from '@/utils/vat/money';
import { nextMonth, prevMonth, toCzechDate } from '@/utils/vat/czechCalendar';
import { TAX_OFFICE } from '@/utils/vat/config';
import VatSettingsModal from './VatSettingsModal';
import VatOtaDocsEditor from './VatOtaDocsEditor';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const kc = (h: number) => `${formatHal(h)} Kč`;
const kcWhole = (n: number | null) => (n === null ? '' : formatHal(n * 100, { decimals: 0 }));

function lastClosedMonth(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth(); // 0-based → the previous month in 1-based terms
  return m === 0 ? `${y - 1}-12` : `${y}-${String(m).padStart(2, '0')}`;
}

const SEVERITY_STYLE = {
  error: { box: 'bg-red-50 border-red-200', dot: 'bg-red-500', text: 'text-red-800', label: 'Error' },
  warning: { box: 'bg-amber-50 border-amber-200', dot: 'bg-amber-500', text: 'text-amber-800', label: 'Warning' },
  info: { box: 'bg-slate-50 border-slate-200', dot: 'bg-slate-400', text: 'text-slate-700', label: 'Info' },
} as const;

const DECISION_LABEL: Record<VatDecision, string> = {
  merge: 'Count once', separate: 'Count both', include: 'Include', exclude: 'Exclude',
};

// ─── Small building blocks ───────────────────────────────────────────────────

function Card({ title, value, note, tone = 'default' }: { title: string; value: string; note?: string; tone?: 'default' | 'strong' | 'muted' }) {
  return (
    <div className={`rounded-xl border p-4 ${tone === 'strong' ? 'bg-indigo-50 border-indigo-200' : 'bg-white border-gray-200'}`}>
      <p className="text-xs font-medium text-gray-500">{title}</p>
      <p className={`mt-1 text-xl font-semibold ${tone === 'strong' ? 'text-indigo-800' : tone === 'muted' ? 'text-gray-500' : 'text-gray-900'}`}>{value}</p>
      {note && <p className="mt-1 text-[11px] text-gray-500">{note}</p>}
    </div>
  );
}

function Section({ title, subtitle, children, right }: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200">
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-gray-100">
        <div>
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {right}
      </div>
      <div className="p-4 overflow-x-auto">{children}</div>
    </div>
  );
}

const th = 'px-2 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-400 whitespace-nowrap';
const td = 'px-2 py-1.5 text-sm text-gray-700 align-top';
const tdNum = 'px-2 py-1.5 text-sm text-gray-900 text-right tabular-nums whitespace-nowrap align-top';

function FlagList({ flags, canEdit, onDecide }: { flags: VatFlag[]; canEdit: boolean; onDecide: (key: string, d: VatDecision | null) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (flags.length === 0) {
    return <div className="rounded-xl border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">No flags — the month looks clean.</div>;
  }
  return (
    <div className="space-y-2">
      {flags.map((f) => {
        const s = SEVERITY_STYLE[f.severity];
        const key = `${f.code}|${f.severity}`;
        const items = f.items ?? [];
        const expanded = open[key] ?? (f.severity === 'error' || items.some((i) => i.options));
        return (
          <div key={key} className={`rounded-xl border px-4 py-3 ${s.box}`}>
            <button className="w-full flex items-start gap-2.5 text-left" onClick={() => setOpen((o) => ({ ...o, [key]: !expanded }))}>
              <span className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${s.dot}`} />
              <div className="flex-1 min-w-0">
                <p className={`text-sm font-medium ${s.text}`}>
                  {f.title}{items.length > 0 && <span className="font-normal opacity-70"> · {items.length}</span>}
                </p>
                {f.detail && <p className="text-xs text-gray-600 mt-0.5">{f.detail}</p>}
              </div>
              {items.length > 0 && <span className="text-xs text-gray-400">{expanded ? '▾' : '▸'}</span>}
            </button>
            {expanded && items.length > 0 && (
              <ul className="mt-2 ml-4.5 space-y-1">
                {items.map((it, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-700">
                    <span className="font-medium">{it.label}</span>
                    {it.detail && <span className="text-gray-500">{it.detail}</span>}
                    {it.date && <span className="text-gray-400">{toCzechDate(it.date)}</span>}
                    {it.amountHal !== undefined && <span className="tabular-nums">{kc(it.amountHal)}</span>}
                    {it.options && it.decisionKey && (
                      <span className="flex items-center gap-1">
                        {it.options.map((opt) => (
                          <button key={opt} disabled={!canEdit}
                            onClick={() => onDecide(it.decisionKey!, opt)}
                            className={`px-2 py-0.5 rounded-md border text-[11px] ${it.decision === opt ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-300 text-gray-600 hover:border-indigo-400'} disabled:opacity-60`}>
                            {DECISION_LABEL[opt]}
                          </button>
                        ))}
                        {it.decided && canEdit && (
                          <button onClick={() => onDecide(it.decisionKey!, null)} className="text-[11px] text-gray-400 hover:text-gray-600 underline">reset</button>
                        )}
                        {!it.decided && <span className="text-[11px] text-gray-400">(default)</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function VatPage() {
  const { data: session } = useSession();
  const role = (session?.user as { role?: Role } | undefined)?.role;
  const canEdit = role !== 'accountant'; // the API enforces admin-only writes regardless

  const [month, setMonth] = useState(lastClosedMonth);
  const [result, setResult] = useState<VatMonthResult | null>(null);
  const [settings, setSettings] = useState<VatSettings | null>(null);
  const [overview, setOverview] = useState<VatOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [otaEditor, setOtaEditor] = useState<VatA2Row | null>(null);
  const [showB3Docs, setShowB3Docs] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [showRevenue, setShowRevenue] = useState(true);
  const year = Number(month.slice(0, 4));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mRes, oRes] = await Promise.all([
        fetch(`/api/vat/month?month=${month}`, { cache: 'no-store' }),
        fetch(`/api/vat/overview?year=${month.slice(0, 4)}`, { cache: 'no-store' }),
      ]);
      const mJson = await mRes.json();
      if (!mRes.ok) throw new Error(mJson.error ?? `HTTP ${mRes.status}`);
      setResult(mJson.result as VatMonthResult);
      setSettings(mJson.settings as VatSettings);
      const oJson = await oRes.json();
      if (oRes.ok) setOverview(oJson as VatOverview);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load VAT data');
    } finally {
      setLoading(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const patch = useCallback(async (body: { config?: Partial<VatConfig>; otaDocuments?: Record<string, OtaTaxDocument[] | null>; decisions?: Record<string, VatDecision | null> }) => {
    const res = await fetch('/api/vat/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
    await load();
  }, [load]);

  const onDecide = useCallback((key: string, decision: VatDecision | null) => {
    patch({ decisions: { [key]: decision } }).catch((e) => setError(e instanceof Error ? e.message : 'Save failed'));
  }, [patch]);

  const counts = useMemo(() => ({
    error: result?.flags.filter((f) => f.severity === 'error').length ?? 0,
    warning: result?.flags.filter((f) => f.severity === 'warning').length ?? 0,
  }), [result]);

  const r = result;
  const live = r?.mode === 'live';
  const payable = r ? r.dap.payableCzk : 0;
  const refund = r ? r.dap.refundCzk : 0;
  const spayd = r && live && payable > 0 && settings
    ? `SPD*1.0*ACC:${TAX_OFFICE.vatIban}*AM:${payable}.00*CC:CZK*X-VS:${settings.config.dic}*MSG:DPH ${month.slice(5)}/${month.slice(0, 4)}`
    : null;
  const exportHref = (format: string) => `/api/vat/export?month=${month}&format=${format}`;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <h2 className="text-lg font-semibold text-gray-900">VAT <span className="text-gray-400 font-normal">· DPH</span></h2>
          <div className="flex items-center rounded-lg border border-gray-200 bg-white">
            <button onClick={() => setMonth(prevMonth(month))} className="px-2.5 py-1.5 text-gray-500 hover:text-gray-800">‹</button>
            <span className="px-2 text-sm font-medium text-gray-800 min-w-[9.5rem] text-center">{monthLabel(month)}</span>
            <button onClick={() => setMonth(nextMonth(month))} className="px-2.5 py-1.5 text-gray-500 hover:text-gray-800">›</button>
          </div>
          {r && (
            <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${live ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800'}`}>
              {live ? (r.periodStart !== `${month}-01` ? `Live from ${toCzechDate(r.periodStart)}` : 'Live — VAT payer') : 'Simulation — not filed'}
            </span>
          )}
          {r && live && (
            <span className={`text-xs ${r.daysToDeadline < 0 ? 'text-red-600 font-semibold' : r.daysToDeadline <= 5 ? 'text-amber-700 font-medium' : 'text-gray-500'}`}>
              Due {toCzechDate(r.deadline)} ({r.daysToDeadline >= 0 ? `in ${r.daysToDeadline} days` : `${-r.daysToDeadline} days ago`})
            </span>
          )}
          {loading && <span className="text-xs text-gray-400">Loading…</span>}
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <a href={`/api/vat/pdf?month=${month}`} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-indigo-300">PDF</a>
          <a href={exportHref('xlsx')} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-indigo-300">Excel</a>
          <a href={exportHref('csv')} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-indigo-300">CSV</a>
          <a href={exportHref('kh-xml')} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-400" title="Kontrolní hlášení — EPO XML">KH XML</a>
          <a href={exportHref('dp-xml')} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-indigo-200 bg-indigo-50 text-indigo-700 hover:border-indigo-400" title="Přiznání k DPH — EPO XML">DPH XML</a>
          <button onClick={() => setShowSettings(true)} className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-200 bg-white text-gray-700 hover:border-indigo-300">Settings</button>
        </div>
      </div>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {r && (
        <>
          {/* Summary */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card tone="strong" title={refund > 0 ? 'Excess deduction (refund)' : live ? 'VAT payable' : 'VAT payable (if registered)'}
              value={`${kcWhole(refund > 0 ? refund : payable)} Kč`}
              note={`${(r.totals.grossRevenueHal ? (r.totals.payableHal / r.totals.grossRevenueHal) * 100 : 0).toFixed(1)} % of gross revenue ${kc(r.totals.grossRevenueHal)}`} />
            <Card title="Output VAT" value={kc(r.totals.outputVatHal)}
              note={`Sales ${kc(r.totals.revenueVatHal)} + reverse charge ${kc(r.totals.reverseChargeVatHal)}`} />
            <Card title="Deductible VAT" value={kc(r.totals.deductionHal)}
              note={`Czech invoices ${kc(r.totals.domesticDeductionHal)} + reverse charge ${kc(r.totals.reverseChargeDeductionHal)}`} />
            <Card tone={r.totals.foreignVatChargedHal ? 'default' : 'muted'} title="VAT charged by foreign suppliers (lost)"
              value={kc(r.totals.foreignVatChargedHal)} note="Disappears once they have our VAT number" />
          </div>

          {/* Flags */}
          <Section title={`Checks · ${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warning} warning${counts.warning === 1 ? '' : 's'}`}
            subtitle="Errors must be fixed before filing. Items with buttons need a decision (admin).">
            <FlagList flags={r.flags} canEdit={canEdit} onDecide={onDecide} />
          </Section>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            {/* VAT return */}
            <Section title="VAT return · přiznání k DPH" subtitle="Whole crowns, as filed (DPHDP3).">
              <table className="w-full">
                <thead><tr><th className={th}>Row</th><th className={th}>Meaning</th><th className={`${th} text-right`}>Base</th><th className={`${th} text-right`}>Tax</th></tr></thead>
                <tbody>
                  {r.dap.rows.map((row) => (
                    <tr key={row.row} className={['46', '62', '63', '64', '65'].includes(row.row) ? 'border-t border-gray-100 font-medium' : ''}>
                      <td className={td}>{row.row}</td>
                      <td className={td}>{row.label}</td>
                      <td className={tdNum}>{kcWhole(row.baseCzk)}</td>
                      <td className={tdNum}>{kcWhole(row.taxCzk)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Section>

            {/* Section C + payment */}
            <div className="space-y-5">
              <Section title="Control statement · section C" subtitle="Must agree with the VAT return (the tax office tolerates ±1 000 Kč).">
                <table className="w-full">
                  <tbody>
                    {([
                      ['obrat23', 'Sales base 21 % (A.4 + A.5)', r.khC.obrat23, '1'],
                      ['obrat5', 'Sales base 12 % (A.4 + A.5)', r.khC.obrat5, '2'],
                      ['pln23', 'Purchases base 21 % (B.2 + B.3)', r.khC.pln23, '40'],
                      ['pln5', 'Purchases base 12 % (B.2 + B.3)', r.khC.pln5, '41'],
                      ['celk_zd_a2', 'Reverse-charge base (A.2)', r.khC.celkZdA2, '3 + 5 + 12'],
                    ] as const).map(([k, label, v, row]) => (
                      <tr key={k}><td className={`${td} font-mono text-xs`}>{k}</td><td className={td}>{label}</td><td className={tdNum}>{kc(v)}</td><td className={`${td} text-xs text-gray-400`}>row {row}</td></tr>
                    ))}
                  </tbody>
                </table>
              </Section>
              {spayd ? (
                <div className="flex items-center gap-4 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
                  <QRCodeSVG value={spayd} size={96} />
                  <div className="text-sm text-indigo-900">
                    <p className="font-semibold">Pay {kcWhole(payable)} Kč by {toCzechDate(r.deadline)}</p>
                    <p>Account {TAX_OFFICE.vatAccount} · VS {settings?.config.dic}</p>
                    <p className="text-xs text-indigo-700 mt-1">The payment counts when it is credited to the tax office — send it ~2 working days early.</p>
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-gray-200 bg-white p-4 text-xs text-gray-500">
                  {live ? 'Nothing to pay this month.' : 'Simulation month — nothing is filed or paid. Set the VAT registration date in Settings once known.'}
                  <br />Filings go to the data box of {TAX_OFFICE.name} ({TAX_OFFICE.dataBoxId}); VAT is paid to {TAX_OFFICE.vatAccount}, VS = DIČ.
                </div>
              )}
            </div>
          </div>

          {/* A.2 */}
          <Section title={`A.2 · Foreign suppliers — reverse charge (${r.a2.length})`}
            subtitle="Every document is listed, whatever the amount. We self-assess 21 % and deduct the same amount — it nets to zero.">
            <table className="w-full">
              <thead><tr>
                <th className={th}>Supplier</th><th className={th}>VAT ID</th><th className={th}>Document</th><th className={th}>DPPD</th>
                <th className={`${th} text-right`}>Original × ČNB</th><th className={`${th} text-right`}>Base</th><th className={`${th} text-right`}>VAT 21 %</th><th className={th}>Row</th>
              </tr></thead>
              <tbody>
                {r.a2.map((a) => (
                  <tr key={a.id} className="border-t border-gray-50">
                    <td className={td}>
                      {a.supplier}
                      {a.foreignVatChargedHal !== 0 && <span className="block text-[11px] text-amber-700">charged us {kc(a.foreignVatChargedHal)} VAT (lost)</span>}
                      {a.note && <span className="block text-[11px] text-gray-400">{a.note}</span>}
                    </td>
                    <td className={`${td} font-mono text-xs`}>{a.countryCode && a.vatId ? `${a.countryCode}${a.vatId}` : <span className="text-gray-400">non-EU</span>}</td>
                    <td className={td}>
                      {a.documentNumber ?? <span className="text-amber-700 text-xs font-medium">missing</span>}
                      {a.settlementGroupId && canEdit && (
                        <button onClick={() => setOtaEditor(a)} className="ml-2 text-[11px] text-indigo-600 hover:text-indigo-800 underline">
                          {a.source === 'ota_document' ? 'edit' : 'enter invoice'}
                        </button>
                      )}
                    </td>
                    <td className={td}>{toCzechDate(a.dppd)}</td>
                    <td className={`${tdNum} text-xs text-gray-500`}>{a.currency !== 'CZK' && a.fxRate ? `${(a.originalMinor / 100).toFixed(2)} ${a.currency} × ${a.fxRate.toFixed(3)}` : ''}</td>
                    <td className={tdNum}>{kc(a.baseHal)}</td>
                    <td className={tdNum}>{kc(a.vatHal)}</td>
                    <td className={`${td} text-xs text-gray-400`}>{a.dapRow}</td>
                  </tr>
                ))}
                {r.a2.length === 0 && <tr><td className={td} colSpan={8}>—</td></tr>}
              </tbody>
            </table>
          </Section>

          {/* A.5 / revenue */}
          <Section title={`A.5 · Sales (one total) — ${kc(r.a5.base12Hal + r.a5.base21Hal)} base, ${kc(r.a5.vat12Hal + r.a5.vat21Hal)} VAT`}
            subtitle="Guests without a Czech DIČ are reported as one total. Each sale is taxed on its tax point (rule shown)."
            right={<button onClick={() => setShowRevenue((v) => !v)} className="text-xs text-indigo-600">{showRevenue ? 'Hide' : `Show ${r.revenue.lines.length}`}</button>}>
            {showRevenue && (
              <table className="w-full">
                <thead><tr>
                  <th className={th}>Tax point</th><th className={th}>Sale</th><th className={th}>Rule</th><th className={`${th} text-right`}>Rate</th>
                  <th className={`${th} text-right`}>Gross</th><th className={`${th} text-right`}>Base</th><th className={`${th} text-right`}>VAT</th>
                </tr></thead>
                <tbody>
                  {r.revenue.lines.map((l) => (
                    <tr key={l.id} className="border-t border-gray-50">
                      <td className={td}>{toCzechDate(l.taxPoint)}</td>
                      <td className={td}>{l.label}{l.note && <span className="block text-[11px] text-gray-400">{l.note}</span>}</td>
                      <td className={`${td} text-xs text-gray-500`}>{l.taxPointRule}</td>
                      <td className={tdNum}>{l.ratePct} %</td>
                      <td className={tdNum}>{kc(l.grossHal)}</td>
                      <td className={tdNum}>{kc(l.baseHal)}</td>
                      <td className={tdNum}>{kc(l.vatHal)}</td>
                    </tr>
                  ))}
                  {r.revenue.lines.length === 0 && <tr><td className={td} colSpan={7}>No sales in this period.</td></tr>}
                </tbody>
              </table>
            )}
          </Section>

          {/* B.2 / B.3 */}
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <Section title={`B.2 · Czech invoices over 10 000 Kč (${r.b2.length})`} subtitle="Itemised with the supplier's DIČ and their exact document number — paired with the supplier's own control statement.">
              <table className="w-full">
                <thead><tr><th className={th}>Supplier</th><th className={th}>Document</th><th className={th}>Date</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>VAT</th></tr></thead>
                <tbody>
                  {r.b2.map((d) => (
                    <tr key={d.id} className="border-t border-gray-50">
                      <td className={td}>{d.supplier}<span className="block text-[11px] text-gray-400">IČO {d.ico ?? '—'}</span></td>
                      <td className={td}>{d.documentNumber}</td>
                      <td className={td}>{toCzechDate(d.date)}</td>
                      <td className={tdNum}>{kc(d.totalHal)}</td>
                      <td className={tdNum}>{kc(d.vat21Hal + d.vat12Hal)}</td>
                    </tr>
                  ))}
                  {r.b2.length === 0 && <tr><td className={td} colSpan={5}>None this month.</td></tr>}
                </tbody>
              </table>
            </Section>
            <Section title={`B.3 · Czech invoices up to 10 000 Kč (${r.b3.docs.length}, one total)`}
              subtitle="Reported as one total per rate for all suppliers together."
              right={<button onClick={() => setShowB3Docs((v) => !v)} className="text-xs text-indigo-600">{showB3Docs ? 'Hide documents' : 'Show documents'}</button>}>
              <table className="w-full mb-2">
                <thead><tr><th className={th} /><th className={`${th} text-right`}>Base</th><th className={`${th} text-right`}>VAT</th></tr></thead>
                <tbody>
                  <tr><td className={td}>21 %</td><td className={tdNum}>{kc(r.b3.totals.base21Hal)}</td><td className={tdNum}>{kc(r.b3.totals.vat21Hal)}</td></tr>
                  <tr><td className={td}>12 %</td><td className={tdNum}>{kc(r.b3.totals.base12Hal)}</td><td className={tdNum}>{kc(r.b3.totals.vat12Hal)}</td></tr>
                </tbody>
              </table>
              {showB3Docs && (
                <table className="w-full">
                  <thead><tr><th className={th}>Date</th><th className={th}>Supplier</th><th className={th}>Document</th><th className={`${th} text-right`}>Total</th><th className={`${th} text-right`}>VAT 21/12</th></tr></thead>
                  <tbody>
                    {r.b3.docs.map((d) => (
                      <tr key={d.id} className="border-t border-gray-50">
                        <td className={td}>{toCzechDate(d.date)}</td>
                        <td className={td}>{d.supplier}{d.creditNote && <span className="ml-1 text-[11px] text-indigo-600">credit note</span>}</td>
                        <td className={`${td} text-xs`}>{d.documentNumber}</td>
                        <td className={tdNum}>{kc(d.totalHal)}</td>
                        <td className={`${tdNum} text-xs`}>{formatHal(d.vat21Hal)} / {formatHal(d.vat12Hal)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          {/* Excluded */}
          <Section title={`Not in the VAT return (${r.excluded.length})`} subtitle="Documents of this month that carry no deductible Czech VAT — and why."
            right={<button onClick={() => setShowExcluded((v) => !v)} className="text-xs text-indigo-600">{showExcluded ? 'Hide' : 'Show'}</button>}>
            {showExcluded ? (
              <table className="w-full">
                <thead><tr><th className={th}>Date</th><th className={th}>Supplier</th><th className={th}>Document</th><th className={`${th} text-right`}>Total</th><th className={th}>Reason</th></tr></thead>
                <tbody>
                  {r.excluded.map((x) => (
                    <tr key={x.id} className="border-t border-gray-50">
                      <td className={td}>{toCzechDate(x.date)}</td><td className={td}>{x.supplier}</td><td className={`${td} text-xs`}>{x.documentNumber}</td>
                      <td className={tdNum}>{formatHal(x.totalHal)} {x.currency}</td><td className={`${td} text-xs text-gray-500`}>{x.reasonLabel}</td>
                    </tr>
                  ))}
                  {r.excluded.length === 0 && <tr><td className={td} colSpan={5}>—</td></tr>}
                </tbody>
              </table>
            ) : <p className="text-xs text-gray-400">{r.excluded.length} document(s) hidden.</p>}
          </Section>
        </>
      )}

      {/* Year overview + registration threshold */}
      {overview && (
        <Section title={`${year} overview`} subtitle="Click a month to open it. Simulation months show what the VAT would have been.">
          {(() => {
            const t = overview.threshold;
            const last = [...t.points].reverse().find((p) => p.grossHal !== 0) ?? t.points[0];
            const pct = Math.min(100, (last.cumulativeHal / t.immediateLimitHal) * 100);
            return (
              <div className="mb-4">
                <div className="flex justify-between text-xs text-gray-600 mb-1">
                  <span>Turnover {year}: <b>{kc(last.cumulativeHal)}</b></span>
                  <span>2 000 000 Kč {t.crossedStandard ? `passed in ${monthLabel(t.crossedStandard)}` : 'not reached'} · 2 536 500 Kč {t.crossedImmediate ? `passed in ${monthLabel(t.crossedImmediate)}` : 'not reached'}</span>
                </div>
                <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                  <div className={`h-2 ${t.crossedImmediate ? 'bg-red-400' : t.crossedStandard ? 'bg-amber-400' : 'bg-indigo-400'}`} style={{ width: `${pct}%` }} />
                  <div className="absolute top-0 h-2 w-px bg-gray-500" style={{ left: `${(t.standardLimitHal / t.immediateLimitHal) * 100}%` }} />
                </div>
              </div>
            );
          })()}
          <table className="w-full">
            <thead><tr>
              <th className={th}>Month</th><th className={th}>Mode</th><th className={`${th} text-right`}>Gross sales</th><th className={`${th} text-right`}>Output VAT</th>
              <th className={`${th} text-right`}>Deductions</th><th className={`${th} text-right`} title="Negative = excess deduction (refund)">Payable</th><th className={th}>Checks</th><th className={th}>Due</th>
            </tr></thead>
            <tbody>
              {overview.months.map((m) => (
                <tr key={m.month} onClick={() => setMonth(m.month)} className={`border-t border-gray-50 cursor-pointer hover:bg-indigo-50/40 ${m.month === month ? 'bg-indigo-50' : ''}`}>
                  <td className={td}>{monthLabel(m.month)}</td>
                  <td className={`${td} text-xs`}>{m.mode === 'live' ? <span className="text-green-700">live</span> : <span className="text-amber-700">simulation</span>}</td>
                  <td className={tdNum}>{formatHal(m.grossRevenueHal, { decimals: 0 })}</td>
                  <td className={tdNum}>{formatHal(m.outputVatHal, { decimals: 0 })}</td>
                  <td className={tdNum}>{formatHal(m.deductionHal, { decimals: 0 })}</td>
                  <td className={`${tdNum} font-medium`}>{formatHal(m.payableHal, { decimals: 0 })}</td>
                  <td className={`${td} text-xs`}>
                    {m.errors > 0 && <span className="text-red-600 mr-2">{m.errors} err</span>}
                    {m.warnings > 0 && <span className="text-amber-700">{m.warnings} warn</span>}
                  </td>
                  <td className={`${td} text-xs text-gray-500`}>{toCzechDate(m.deadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* How it works */}
      <details className="rounded-xl border border-gray-200 bg-white px-4 py-3 text-xs text-gray-600">
        <summary className="cursor-pointer text-sm font-medium text-gray-800">How these numbers are calculated</summary>
        <ul className="mt-2 space-y-1 list-disc ml-4">
          <li>Accommodation is 12 % VAT <i>included</i> in the price (base = gross ÷ 1.12). Other services default to 21 %.</li>
          <li>Booking.com / Airbnb: taxed in the settlement&apos;s month (Booking by departure, Airbnb by payout). Their commission is a service from an EU supplier: reverse charge, A.2.</li>
          <li>Direct sales: taxed on the earlier of payment and check-out (a prepayment is taxable when received). Stripe web bookings count at the payment date even before the payout reaches the bank.</li>
          <li>Czech purchases use the saved VAT split per rate. Over 10 000 Kč including VAT → B.2 (itemised); otherwise the B.3 total.</li>
          <li>Foreign invoices are converted at the ČNB rate valid on the tax date. VAT a foreign supplier charges us is not deductible.</li>
          <li>The XML files follow the official EPO structures (DPHKH1 03.01.15 / DPHDP3 03.01.04) and are checked against them before download.</li>
        </ul>
      </details>

      {showSettings && settings && (
        <VatSettingsModal config={settings.config} canEdit={canEdit} onClose={() => setShowSettings(false)}
          onSave={(config) => patch({ config })} />
      )}
      {otaEditor && otaEditor.settlementGroupId && (
        <VatOtaDocsEditor
          title={otaEditor.supplier}
          expectedHal={otaEditor.settlementExpectedHal ?? otaEditor.baseHal}
          defaultDate={otaEditor.dppd}
          docs={settings?.otaDocuments[otaEditor.settlementGroupId] ?? []}
          onClose={() => setOtaEditor(null)}
          onSave={(docs) => patch({ otaDocuments: { [otaEditor.settlementGroupId!]: docs.length ? docs : null } })}
        />
      )}
    </div>
  );
}
