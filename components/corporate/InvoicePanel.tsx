'use client';
/**
 * Invoices for one agreement — opened from the "Invoice" pill in the
 * agreement header (shown once the billing details are complete).
 *
 * Top: every invoice of the agreement with its state and actions (preview,
 * PDF, send / resend, mark paid, void; reschedule or cancel while scheduled).
 * Below, two ways to make new ones:
 *
 *   Monthly schedule — one invoice per calendar month of the stays. Issue
 *     timing + due rule fill in each month's dates, every date stays editable,
 *     and the daily cron (09:00 UTC = 10:00 Prague) issues + emails each on its issue date.
 *   Ad hoc — one invoice over any range of nights: send now, issue only, or
 *     schedule for a date.
 *
 * Amounts in the forms are previews from the server (live Beds24 bookings
 * when readable). A scheduled invoice's amount is only fixed when it's issued.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DUE_RULE_PRESETS,
  ISSUE_TIMING_PRESETS,
  daysPastDue,
  describeDueRule,
  dueDateFor,
  firstDayOfMonth,
  issueDateFor,
  lastDayOfMonth,
  monthLabel,
  monthsWithNights,
  needsPaymentCheck,
  overlappingInvoice,
  type CorporateInvoice,
  type DueRule,
  type InvoicePreview,
} from '@/utils/corporateInvoice';
import { addDays } from '@/utils/corporateSchedule';
import { countsTowardsAgreement, formatStayDate, type AgreementDetail } from '@/utils/corporateShared';
import { pragueToday } from '@/utils/periodUtils';
import { InvoiceStatusBadge, smallInputCls, inputCls, Field } from './ui';
import {
  czkExact,
  downloadInvoicePdf,
  invoiceAction,
  invoiceDate,
  listInvoices,
  openInvoiceHtml,
  type InvoiceAction,
} from './invoiceApi';

interface Props {
  agreement: AgreementDetail;
  canEdit: boolean;
  onClose: () => void;
}

type Form = 'none' | 'monthly' | 'adhoc';

export default function InvoicePanel({ agreement, canEdit, onClose }: Props) {
  const [invoices, setInvoices] = useState<CorporateInvoice[] | null>(null);
  const [form, setForm] = useState<Form>('none');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const today = pragueToday();

  const reload = useCallback(async () => {
    try {
      setInvoices(await listInvoices(agreement.id));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [agreement.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function act(inv: CorporateInvoice, action: InvoiceAction, extra: Record<string, unknown> = {}, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    await run(`${action}:${inv.id}`, async () => {
      const r = await invoiceAction(inv.id, action, extra);
      const bits: string[] = [];
      if (r.invoice?.invoiceNumber && (action === 'issue' || action === 'send')) bits.push(`${r.invoice.invoiceNumber} ${action === 'send' ? 'sent' : 'issued'}.`);
      if (r.outcome === 'deferred') bits.push('The mail server deferred the acknowledgement — it is most likely delivered; check the Sent folder.');
      if (r.notes?.length) bits.push(...r.notes);
      if (r.revenueError) bits.push(`Revenue record failed (${r.revenueError}) — add it in Accounting → Revenue.`);
      if (bits.length) setNotice(bits.join(' '));
      await reload();
    });
  }

  const sorted = invoices ?? [];

  return (
    <div className="mx-4 sm:mx-6 mb-4 rounded-lg border border-emerald-200 bg-emerald-50/30">
      <div className="px-4 py-3 border-b border-emerald-100 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-900">Invoices</h3>
        <span className="text-xs text-gray-500">
          to {agreement.billingEmail} · payment by bank transfer
        </span>
        <span className="flex-1" />
        {canEdit && (
          <>
            <button
              onClick={() => setForm(form === 'monthly' ? 'none' : 'monthly')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                form === 'monthly' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              Monthly schedule
            </button>
            <button
              onClick={() => setForm(form === 'adhoc' ? 'none' : 'adhoc')}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${
                form === 'adhoc' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:bg-emerald-50'
              }`}
            >
              Ad hoc invoice
            </button>
          </>
        )}
        <button onClick={onClose} className="px-2 text-gray-400 hover:text-gray-600 text-sm" title="Close invoices">
          ✕
        </button>
      </div>

      {(error || notice) && (
        <div className="px-4 pt-3 space-y-2">
          {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
        </div>
      )}

      {/* ── Existing invoices ── */}
      <div className="px-4 py-3">
        {invoices === null ? (
          error ? null : <p className="text-sm text-gray-400">Loading invoices…</p>
        ) : sorted.length === 0 ? (
          <p className="text-sm text-gray-500">No invoices yet. Schedule monthly invoices, or make a single one for any range of nights.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-[11px] uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="text-left py-1.5 pr-3 font-medium">Invoice</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Period</th>
                  <th className="text-right py-1.5 pr-3 font-medium">Amount</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Issue</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Due</th>
                  <th className="text-left py-1.5 pr-3 font-medium">Status</th>
                  <th className="text-right py-1.5 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-emerald-100">
                {sorted.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} today={today} canEdit={canEdit} busy={busy} onAct={act} onRun={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {canEdit && form === 'monthly' && invoices && (
        <MonthlyForm
          agreement={agreement}
          existing={invoices}
          today={today}
          onDone={async (msg) => {
            setForm('none');
            setNotice(msg);
            await reload();
          }}
        />
      )}
      {canEdit && form === 'adhoc' && invoices && (
        <AdhocForm
          agreement={agreement}
          existing={invoices}
          today={today}
          onDone={async (msg) => {
            setForm('none');
            setNotice(msg);
            await reload();
          }}
        />
      )}
    </div>
  );
}

// ─── One invoice ─────────────────────────────────────────────────────────────

function periodText(inv: Pick<CorporateInvoice, 'billedMonth' | 'periodFrom' | 'periodTo'>): string {
  return inv.billedMonth ? monthLabel(inv.billedMonth) : `${formatStayDate(inv.periodFrom)} → ${formatStayDate(addDays(inv.periodTo, 1))}`;
}

function InvoiceRow({
  inv,
  today,
  canEdit,
  busy,
  onAct,
  onRun,
}: {
  inv: CorporateInvoice;
  today: string;
  canEdit: boolean;
  busy: string | null;
  onAct: (inv: CorporateInvoice, action: InvoiceAction, extra?: Record<string, unknown>, confirmText?: string) => Promise<void>;
  onRun: (key: string, fn: () => Promise<void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [issueDate, setIssueDate] = useState(inv.issueDate);
  const [dueDate, setDueDate] = useState(inv.dueDate);
  const overdue = needsPaymentCheck(inv, today);
  const nights = inv.lines?.reduce((n, l) => n + l.nights, 0) ?? null;
  const btn = 'px-2 py-1 rounded border text-[11px] disabled:opacity-40';
  const disabled = busy !== null;
  const email = inv.billTo?.billingEmail ?? 'the invoice email';

  return (
    <tr className={inv.status === 'void' ? 'text-gray-400' : ''}>
      <td className="py-2 pr-3 whitespace-nowrap">
        {inv.invoiceNumber ? <span className="font-mono text-xs">{inv.invoiceNumber}</span> : <span className="text-xs text-gray-400 italic">not issued yet</span>}
        <div className="text-[10px] text-gray-400">{inv.kind === 'monthly' ? 'monthly' : 'ad hoc'}</div>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {periodText(inv)}
        {nights !== null && <div className="text-[10px] text-gray-400">{nights} nights · {inv.lines?.length} stays</div>}
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap tabular-nums">
        {inv.amountCzk !== null ? czkExact(inv.amountCzk) : <span className="text-[11px] text-gray-400">at issue</span>}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap text-xs">
        {editing ? (
          <input type="date" className={smallInputCls} value={issueDate} min={today} onChange={(e) => setIssueDate(e.target.value)} />
        ) : (
          invoiceDate(inv.issueDate)
        )}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap text-xs">
        {editing ? (
          <input type="date" className={smallInputCls} value={dueDate} min={issueDate} onChange={(e) => setDueDate(e.target.value)} />
        ) : (
          <>
            {invoiceDate(inv.dueDate)}
            {inv.dueRule && <div className="text-[10px] text-gray-400">{describeDueRule(inv.dueRule)}</div>}
          </>
        )}
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-col gap-0.5 items-start">
          <InvoiceStatusBadge status={inv.status} />
          {overdue && <span className="text-[10px] font-semibold text-red-600">{daysPastDue(inv.dueDate, today)} d overdue</span>}
          {inv.sentAt && inv.status !== 'scheduled' && (
            <span className="text-[10px] text-gray-400">
              sent {invoiceDate(inv.sentAt)}
              {inv.sendCount > 1 ? ` (${inv.sendCount}×)` : ''}
            </span>
          )}
          {inv.status === 'paid' && inv.paidAt && (
            <span className="text-[10px] text-green-700">
              paid {invoiceDate(inv.paidAt)} · {inv.paidSource === 'bank' ? 'bank match' : 'by hand'}
            </span>
          )}
          {inv.error && <span className="text-[10px] text-amber-700 max-w-[240px] whitespace-normal">{inv.error}</span>}
        </div>
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        <div className="inline-flex flex-wrap justify-end gap-1">
          <button onClick={() => openInvoiceHtml(inv.id)} className={`${btn} border-gray-200 text-gray-600 hover:bg-gray-50`}>
            {inv.invoiceNumber ? 'View' : 'Preview'}
          </button>
          {inv.invoiceNumber && (
            <button
              onClick={() => void onRun(`pdf:${inv.id}`, () => downloadInvoicePdf(inv.id))}
              disabled={disabled}
              className={`${btn} border-gray-200 text-gray-600 hover:bg-gray-50`}
            >
              {busy === `pdf:${inv.id}` ? '…' : 'PDF'}
            </button>
          )}
          {canEdit && inv.status === 'scheduled' && !editing && (
            <>
              <button
                onClick={() =>
                  void onAct(inv, 'send', {}, `Issue this invoice now (${periodText(inv)}) and email it to ${email}? The amount is fixed from the bookings as they stand.`)
                }
                disabled={disabled}
                className={`${btn} border-emerald-300 text-emerald-700 hover:bg-emerald-50 font-medium`}
              >
                {busy === `send:${inv.id}` ? 'Sending…' : 'Send now'}
              </button>
              <button onClick={() => setEditing(true)} disabled={disabled} className={`${btn} border-gray-200 text-gray-600 hover:bg-gray-50`}>
                Dates
              </button>
              <button
                onClick={() => void onAct(inv, 'cancel', {}, `Cancel the scheduled invoice for ${periodText(inv)}? It was never issued.`)}
                disabled={disabled}
                className={`${btn} border-rose-200 text-rose-700 hover:bg-rose-50`}
              >
                Cancel
              </button>
            </>
          )}
          {canEdit && editing && (
            <>
              <button
                onClick={() => void onAct(inv, 'reschedule', { issueDate, dueDate }).then(() => setEditing(false))}
                disabled={disabled || dueDate < issueDate}
                className={`${btn} border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-medium`}
              >
                Save
              </button>
              <button onClick={() => setEditing(false)} className={`${btn} border-gray-200 text-gray-500`}>
                ✕
              </button>
            </>
          )}
          {canEdit && (inv.status === 'issued' || inv.status === 'sent' || inv.status === 'paid') && (
            <button
              onClick={() =>
                void onAct(
                  inv,
                  'send',
                  {},
                  inv.status === 'issued' ? `Email ${inv.invoiceNumber} to ${email}?` : `Send ${inv.invoiceNumber} again to ${email}?`,
                )
              }
              disabled={disabled}
              className={`${btn} border-emerald-300 text-emerald-700 hover:bg-emerald-50`}
            >
              {busy === `send:${inv.id}` ? 'Sending…' : inv.status === 'issued' ? 'Send' : 'Resend'}
            </button>
          )}
          {canEdit && (inv.status === 'issued' || inv.status === 'sent') && (
            <>
              <button
                onClick={() => {
                  const d = window.prompt(`Mark ${inv.invoiceNumber} as paid. Payment date (YYYY-MM-DD):`, today);
                  if (d !== null) void onAct(inv, 'markPaid', { paidAt: d.trim() || today });
                }}
                disabled={disabled}
                className={`${btn} border-green-300 text-green-700 hover:bg-green-50`}
              >
                Mark paid
              </button>
              <button
                onClick={() =>
                  void onAct(
                    inv,
                    'void',
                    {},
                    `Void ${inv.invoiceNumber}? Its number stays used, and its revenue record is marked a mistake. Tell the company if it was already sent.`,
                  )
                }
                disabled={disabled}
                className={`${btn} border-rose-200 text-rose-700 hover:bg-rose-50`}
              >
                Void
              </button>
            </>
          )}
          {canEdit && inv.status === 'paid' && (
            <button
              onClick={() => void onAct(inv, 'unmarkPaid', {}, `Undo "paid" on ${inv.invoiceNumber}?`)}
              disabled={disabled}
              className={`${btn} border-gray-200 text-gray-500 hover:bg-gray-50`}
            >
              Undo paid
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

// ─── Shared preview bits ─────────────────────────────────────────────────────

async function fetchPreviews(agreementId: string, ranges: { from: string; to: string }[]): Promise<{ previews: InvoicePreview[]; verified: boolean }> {
  const res = await fetch('/api/corporate/invoices/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agreementId, ranges }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
  return json;
}

function presetKeyFor(rule: DueRule): string {
  return DUE_RULE_PRESETS.find((p) => JSON.stringify(p.rule) === JSON.stringify(rule))?.key ?? 'custom';
}

/** Due-rule picker: the common presets plus a custom rule. */
function DueRulePicker({ rule, onChange }: { rule: DueRule; onChange: (r: DueRule) => void }) {
  const key = presetKeyFor(rule);
  const [custom, setCustom] = useState(key === 'custom');
  return (
    <div className="space-y-2">
      <select
        className={inputCls}
        value={custom ? 'custom' : key}
        onChange={(e) => {
          if (e.target.value === 'custom') {
            setCustom(true);
            return;
          }
          setCustom(false);
          const p = DUE_RULE_PRESETS.find((x) => x.key === e.target.value);
          if (p) onChange(p.rule);
        }}
      >
        {DUE_RULE_PRESETS.map((p) => (
          <option key={p.key} value={p.key}>
            {p.label}
          </option>
        ))}
        <option value="custom">Custom…</option>
      </select>
      {custom && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
          <select
            className={`${smallInputCls} w-auto`}
            value={rule.kind}
            onChange={(e) =>
              onChange(e.target.value === 'days_after_issue' ? { kind: 'days_after_issue', days: 14 } : { kind: 'day_of_month', day: 15, monthOffset: 0 })
            }
          >
            <option value="days_after_issue">Days after issue</option>
            <option value="day_of_month">Fixed day of a month</option>
          </select>
          {rule.kind === 'days_after_issue' ? (
            <>
              <input
                type="number"
                min={0}
                max={120}
                className={`${smallInputCls} w-16`}
                value={rule.days}
                onChange={(e) => onChange({ kind: 'days_after_issue', days: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })}
              />
              <span>days after the issue date</span>
            </>
          ) : (
            <>
              <span>day</span>
              <input
                type="number"
                min={1}
                max={31}
                className={`${smallInputCls} w-16`}
                value={rule.day}
                onChange={(e) => onChange({ ...rule, day: Math.max(1, Math.min(31, Number(e.target.value) || 1)) })}
              />
              <span>of the</span>
              <select
                className={`${smallInputCls} w-auto`}
                value={rule.monthOffset}
                onChange={(e) => onChange({ ...rule, monthOffset: Number(e.target.value) as -1 | 0 | 1 })}
              >
                <option value={-1}>previous month</option>
                <option value={0}>billed month</option>
                <option value={1}>following month</option>
              </select>
              <span className="text-gray-400">(31 = last day)</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewNotes({ preview }: { preview: InvoicePreview }) {
  if (preview.notes.length === 0 && preview.pending.length === 0) return null;
  return (
    <div className="space-y-0.5">
      {preview.pending.length > 0 && (
        <div className="text-[11px] text-amber-700">
          {preview.pending.length} stay(s) in this period not booked yet (stay {preview.pending.map((p) => p.seq).join(', ')}) — not billed; a scheduled invoice waits until
          they are created or skipped.
        </div>
      )}
      {preview.notes.map((n) => (
        <div key={n} className="text-[11px] text-gray-500">
          {n}
        </div>
      ))}
    </div>
  );
}

// ─── Monthly schedule ────────────────────────────────────────────────────────

interface MonthRow {
  month: string;
  include: boolean;
  issueDate: string;
  dueDate: string;
  /** User typed a date → stop recomputing it from the rules. */
  touched: boolean;
  clash: string | null;
}

function MonthlyForm({
  agreement,
  existing,
  today,
  onDone,
}: {
  agreement: AgreementDetail;
  existing: CorporateInvoice[];
  today: string;
  onDone: (msg: string) => Promise<void>;
}) {
  const [timingKey, setTimingKey] = useState(ISSUE_TIMING_PRESETS[0].key);
  const [rule, setRule] = useState<DueRule>(DUE_RULE_PRESETS.find((p) => p.key === 'prev-end')!.rule);
  const [includePayment, setIncludePayment] = useState(true);
  const [previews, setPreviews] = useState<Record<string, InvoicePreview>>({});
  const [verified, setVerified] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timing = ISSUE_TIMING_PRESETS.find((p) => p.key === timingKey)!.timing;
  const months = useMemo(() => monthsWithNights(agreement.stays.filter((s) => countsTowardsAgreement(s.status))), [agreement.stays]);

  const computeRow = useCallback(
    (month: string, prev?: MonthRow): MonthRow => {
      const clashInv = overlappingInvoice(existing, firstDayOfMonth(month), lastDayOfMonth(month));
      const clash = clashInv ? (clashInv.invoiceNumber ?? `scheduled ${periodText(clashInv)}`) : null;
      if (prev?.touched) return { ...prev, clash };
      const issueDate = issueDateFor(timing, month, today);
      return { month, include: prev?.include ?? !clash, issueDate, dueDate: dueDateFor(rule, month, issueDate), touched: false, clash };
    },
    [existing, timing, rule, today],
  );

  const [rows, setRows] = useState<MonthRow[]>(() => months.map((m) => computeRow(m)));
  // Rules changed → recompute every row the operator hasn't hand-edited.
  useEffect(() => {
    setRows((prev) => months.map((m) => computeRow(m, prev.find((r) => r.month === m))));
  }, [months, computeRow]);

  useEffect(() => {
    if (months.length === 0) return;
    let cancelled = false;
    fetchPreviews(
      agreement.id,
      months.map((m) => ({ from: firstDayOfMonth(m), to: lastDayOfMonth(m) })),
    )
      .then((r) => {
        if (cancelled) return;
        setPreviews(Object.fromEntries(months.map((m, i) => [m, r.previews[i]])));
        setVerified(r.verified);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [agreement.id, months]);

  const chosen = rows.filter((r) => r.include && !r.clash);
  const invalid = chosen.filter((r) => r.dueDate < r.issueDate || r.issueDate < today);
  const total = chosen.reduce((s, r) => s + (previews[r.month]?.totalCzk ?? 0), 0);

  async function submit() {
    if (!window.confirm(`Schedule ${chosen.length} monthly invoice(s) for ${agreement.companyName}? Each is issued and emailed to ${agreement.billingEmail} in the morning run (10:00 Prague, 11:00 in summer) on its issue date.`))
      return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/corporate/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agreementId: agreement.id,
          mode: 'monthly',
          includePaymentDetails: includePayment,
          dueRule: chosen.every((r) => !r.touched) ? rule : null,
          months: chosen.map((r) => ({ month: r.month, issueDate: r.issueDate, dueDate: r.dueDate })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      await onDone(`${json.created} monthly invoice(s) scheduled.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const setRow = (month: string, patch: Partial<MonthRow>) => setRows((rs) => rs.map((r) => (r.month === month ? { ...r, ...patch } : r)));

  return (
    <div className="mx-4 mb-4 rounded-lg border border-emerald-200 bg-white p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Field label="Issue each invoice" hint="Never earlier than today.">
          <select className={inputCls} value={timingKey} onChange={(e) => setTimingKey(e.target.value)}>
            {ISSUE_TIMING_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Payment due">
          <DueRulePicker rule={rule} onChange={setRule} />
        </Field>
        <Field label="On the invoice">
          <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
            <input type="checkbox" checked={includePayment} onChange={(e) => setIncludePayment(e.target.checked)} />
            Bank details + payment QR
          </label>
        </Field>
      </div>

      {months.length === 0 ? (
        <p className="text-sm text-gray-500">This agreement has no stays to invoice.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="py-1.5 pr-2" />
                <th className="text-left py-1.5 pr-3 font-medium">Month</th>
                <th className="text-right py-1.5 pr-3 font-medium">Nights</th>
                <th className="text-right py-1.5 pr-3 font-medium">Amount (now)</th>
                <th className="text-left py-1.5 pr-3 font-medium">Issue</th>
                <th className="text-left py-1.5 pr-3 font-medium">Due</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {rows.map((r) => {
                const p = previews[r.month];
                const badDue = r.dueDate < r.issueDate;
                return (
                  <tr key={r.month} className={r.clash ? 'text-gray-400' : ''}>
                    <td className="py-2 pr-2 align-top">
                      <input type="checkbox" checked={r.include && !r.clash} disabled={!!r.clash} onChange={(e) => setRow(r.month, { include: e.target.checked })} />
                    </td>
                    <td className="py-2 pr-3 align-top whitespace-nowrap">
                      {monthLabel(r.month)}
                      {r.clash && <div className="text-[11px]">already invoiced ({r.clash})</div>}
                      {p && !r.clash && <PreviewNotes preview={p} />}
                    </td>
                    <td className="py-2 pr-3 align-top text-right tabular-nums">{p ? p.nights : '…'}</td>
                    <td className="py-2 pr-3 align-top text-right tabular-nums whitespace-nowrap">{p ? czkExact(p.totalCzk) : '…'}</td>
                    <td className="py-2 pr-3 align-top">
                      <input
                        type="date"
                        className={smallInputCls}
                        value={r.issueDate}
                        min={today}
                        disabled={!!r.clash}
                        onChange={(e) => setRow(r.month, { issueDate: e.target.value, touched: true })}
                      />
                    </td>
                    <td className="py-2 pr-3 align-top">
                      <input
                        type="date"
                        className={`${smallInputCls} ${badDue && !r.clash ? 'border-red-300 bg-red-50' : ''}`}
                        value={r.dueDate}
                        disabled={!!r.clash}
                        onChange={(e) => setRow(r.month, { dueDate: e.target.value, touched: true })}
                      />
                      {badDue && !r.clash && <div className="text-[10px] text-red-600">before the issue date</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {verified === false && (
        <p className="text-[11px] text-amber-700">Beds24 couldn&apos;t be read here — amounts come from the agreement. The cron re-checks against Beds24 before issuing.</p>
      )}
      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={busy || chosen.length === 0 || invalid.length > 0}
          className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Scheduling…' : `Schedule ${chosen.length} invoice${chosen.length === 1 ? '' : 's'}`}
        </button>
        <span className="text-xs text-gray-500">
          ≈ {czkExact(total)} in total today. Each goes out in the morning run (10:00 Prague, 11:00 in summer) on its issue date to {agreement.billingEmail}; its
          amount is fixed then, from the bookings as they stand.
        </span>
      </div>
      {chosen.some((r) => r.issueDate === today) && (
        <p className="text-[11px] text-amber-700">
          {chosen.filter((r) => r.issueDate === today).map((r) => monthLabel(r.month)).join(', ')} is dated today. Scheduling doesn&apos;t send it; if
          today&apos;s run has passed it goes out tomorrow (dated tomorrow). To send it today, press <span className="font-semibold">Send now</span> on its row
          after scheduling.
        </p>
      )}
    </div>
  );
}

// ─── Ad hoc ──────────────────────────────────────────────────────────────────

type Delivery = 'send' | 'issue' | 'schedule';

function AdhocForm({
  agreement,
  existing,
  today,
  onDone,
}: {
  agreement: AgreementDetail;
  existing: CorporateInvoice[];
  today: string;
  onDone: (msg: string) => Promise<void>;
}) {
  const s = agreement.summary;
  const [periodFrom, setPeriodFrom] = useState(s.firstArrival ?? agreement.startDate);
  const [periodTo, setPeriodTo] = useState(s.lastDeparture ? addDays(s.lastDeparture, -1) : agreement.endDate);
  const [delivery, setDelivery] = useState<Delivery>('send');
  const [scheduleDate, setScheduleDate] = useState(addDays(today, 1));
  const [dueDate, setDueDate] = useState(addDays(today, 14));
  const [includePayment, setIncludePayment] = useState(true);
  const [preview, setPreview] = useState<InvoicePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const issueDate = delivery === 'schedule' ? scheduleDate : today;
  const rangeOk = periodFrom && periodTo && periodFrom <= periodTo;
  const clash = rangeOk ? overlappingInvoice(existing, periodFrom, periodTo) : null;

  useEffect(() => {
    if (!rangeOk) return;
    let cancelled = false;
    const t = setTimeout(() => {
      fetchPreviews(agreement.id, [{ from: periodFrom, to: periodTo }])
        .then((r) => !cancelled && setPreview(r.previews[0]))
        .catch((e) => !cancelled && setError((e as Error).message));
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [agreement.id, periodFrom, periodTo, rangeOk]);

  const quickDue = [
    { label: '+7 d', date: addDays(issueDate, 7) },
    { label: '+14 d', date: addDays(issueDate, 14) },
    { label: '+30 d', date: addDays(issueDate, 30) },
    { label: 'end of month', date: lastDayOfMonth(issueDate.slice(0, 7)) },
  ];

  const problem = !rangeOk
    ? 'Pick the first and last night'
    : clash
      ? `Overlaps ${clash.invoiceNumber ?? 'a scheduled invoice'} (${periodText(clash)})`
      : !preview
        ? 'Loading preview…'
        : preview.totalCzk <= 0
          ? 'Nothing booked and priced in this range'
          : dueDate < issueDate
            ? 'The due date is before the issue date'
            : delivery === 'schedule' && scheduleDate <= today
              ? 'A scheduled invoice must be dated after today'
              : null;

  async function submit() {
    if (!preview) return;
    const what = `${czkExact(preview.totalCzk)} for ${formatStayDate(periodFrom)} → ${formatStayDate(addDays(periodTo, 1))}`;
    const confirmText =
      delivery === 'send'
        ? `Issue the invoice (${what}) and email it to ${agreement.billingEmail} now?`
        : delivery === 'issue'
          ? `Issue the invoice (${what}) without emailing it? It gets its number now.`
          : `Schedule the invoice for ${formatStayDate(scheduleDate)} (amount fixed then; today ${what})?`;
    if (!window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/corporate/invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agreementId: agreement.id,
          mode: 'adhoc',
          periodFrom,
          periodTo,
          delivery,
          issueDate: delivery === 'schedule' ? scheduleDate : undefined,
          dueDate,
          includePaymentDetails: includePayment,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      const parts: string[] = [];
      if (delivery === 'schedule') parts.push(`Invoice scheduled for ${formatStayDate(scheduleDate)}.`);
      else parts.push(`${json.issued} issued${delivery === 'send' && !json.sendError ? ` and sent to ${agreement.billingEmail}` : ''}.`);
      if (json.outcome === 'deferred') parts.push('The mail server deferred the acknowledgement — most likely delivered.');
      if (json.sendError) parts.push(`Sending failed: ${json.sendError} — use Send on the invoice row.`);
      if (json.revenueError) parts.push(`Revenue record failed (${json.revenueError}).`);
      await onDone(parts.join(' '));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-4 mb-4 rounded-lg border border-emerald-200 bg-white p-4 space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <Field label="First night">
          <input type="date" className={inputCls} value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
        </Field>
        <Field label="Last night" hint={rangeOk ? `checkout ${formatStayDate(addDays(periodTo, 1))}` : undefined}>
          <input type="date" className={inputCls} value={periodTo} min={periodFrom} onChange={(e) => setPeriodTo(e.target.value)} />
        </Field>
        <Field label="Due date">
          <input type="date" className={inputCls} value={dueDate} min={issueDate} onChange={(e) => setDueDate(e.target.value)} />
          <div className="flex flex-wrap gap-1 mt-1">
            {quickDue.map((q) => (
              <button key={q.label} type="button" onClick={() => setDueDate(q.date)} className="px-1.5 py-0.5 rounded border border-gray-200 text-[10px] text-gray-600 hover:bg-gray-50">
                {q.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="On the invoice">
          <label className="flex items-center gap-2 text-sm text-gray-700 mt-2">
            <input type="checkbox" checked={includePayment} onChange={(e) => setIncludePayment(e.target.checked)} />
            Bank details + payment QR
          </label>
        </Field>
      </div>

      {preview && (
        <div className="rounded-md border border-gray-100">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
              <tr>
                <th className="text-left px-3 py-1.5 font-medium">Stay</th>
                <th className="text-left px-3 py-1.5 font-medium">Nights billed</th>
                <th className="text-left px-3 py-1.5 font-medium">Guest</th>
                <th className="text-right px-3 py-1.5 font-medium">Nights</th>
                <th className="text-right px-3 py-1.5 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {preview.lines.map((l) => (
                <tr key={l.stayId}>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    #{l.seq} <span className="text-gray-400 text-xs">{l.reservationNumber}</span>
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap">
                    {formatStayDate(l.from)} → {formatStayDate(l.until)}
                    {l.nights !== l.stayNights && <span className="text-[10px] text-gray-400"> (of {l.stayNights})</span>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-600">{l.guestName || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{l.nights}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{czkExact(l.amountCzk)}</td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="px-3 py-1.5" colSpan={3}>
                  Total
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{preview.nights}</td>
                <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap">{czkExact(preview.totalCzk)}</td>
              </tr>
            </tbody>
          </table>
          <div className="px-3 py-2">
            <PreviewNotes preview={preview} />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-4 text-sm text-gray-700">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={delivery === 'send'} onChange={() => setDelivery('send')} />
          Send now to {agreement.billingEmail}
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={delivery === 'issue'} onChange={() => setDelivery('issue')} />
          Issue only (send later)
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={delivery === 'schedule'} onChange={() => setDelivery('schedule')} />
          Schedule for
          <input
            type="date"
            className={`${smallInputCls} w-36`}
            value={scheduleDate}
            min={addDays(today, 1)}
            onChange={(e) => {
              setScheduleDate(e.target.value);
              setDelivery('schedule');
            }}
          />
        </label>
      </div>

      {error && <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={() => void submit()}
          disabled={busy || problem !== null}
          className="px-3 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium disabled:opacity-50"
        >
          {busy ? 'Working…' : delivery === 'send' ? 'Issue & send invoice' : delivery === 'issue' ? 'Issue invoice' : 'Schedule invoice'}
        </button>
        {problem && <span className="text-xs text-amber-700">{problem}</span>}
      </div>
    </div>
  );
}
