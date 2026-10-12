'use client';
import { useState } from 'react';
import type { OtaTaxDocument } from '@/types/vat';
import { formatHal, toHal } from '@/utils/vat/money';

interface Props {
  title: string;
  /** Amount from the settlement report (net of any VAT the OTA charged), for comparison. */
  expectedHal: number;
  defaultDate: string;
  docs: OtaTaxDocument[];
  onSave: (docs: OtaTaxDocument[]) => Promise<void>;
  onClose: () => void;
}

interface Row {
  number: string;
  date: string;
  amount: string;
}

/**
 * Enter the OTA's own tax documents for one settlement (Booking.com commission
 * invoice / Airbnb VAT invoices). The KH A.2 rows then use their numbers and
 * amounts instead of the settlement report.
 */
export default function VatOtaDocsEditor({ title, expectedHal, defaultDate, docs, onSave, onClose }: Props) {
  const [rows, setRows] = useState<Row[]>(
    docs.length > 0
      ? docs.map((d) => ({ number: d.number, date: d.date, amount: (d.amountHal / 100).toFixed(2) }))
      : [{ number: '', date: defaultDate, amount: (expectedHal / 100).toFixed(2) }],
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  let parsed: OtaTaxDocument[] = [];
  let parseError: string | null = null;
  try {
    parsed = rows
      .filter((r) => r.number.trim() !== '')
      .map((r) => ({ number: r.number.trim(), date: r.date, amountHal: toHal(r.amount) }));
  } catch {
    parseError = 'Amounts must be numbers (e.g. 63312,29).';
  }
  const total = parsed.reduce((s, d) => s + d.amountHal, 0);

  async function save(next: OtaTaxDocument[]) {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-xl" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-gray-100">
          <h3 className="text-base font-semibold text-gray-900">{title} — tax documents</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Booking.com: the monthly commission invoice (FAKTURA). Airbnb: its VAT invoices. Amount <b>without VAT</b>; date = date of supply
            (usually the last day of the month).
          </p>
        </div>
        <div className="px-5 py-4 space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_8.5rem_8rem_auto] gap-2 items-center">
              <input placeholder="Document no." value={r.number} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              <input type="date" value={r.date} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm" />
              <input inputMode="decimal" placeholder="Kč" value={r.amount} onChange={(e) => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                className="rounded-lg border border-gray-200 px-2 py-1.5 text-sm text-right" />
              <button onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="text-gray-400 hover:text-red-600 text-lg leading-none px-1" title="Remove">×</button>
            </div>
          ))}
          <button onClick={() => setRows((rs) => [...rs, { number: '', date: defaultDate, amount: '' }])} className="text-xs text-indigo-600 hover:text-indigo-800">
            + Add document
          </button>
          <div className="text-xs text-gray-500 pt-2">
            Documents total <b>{formatHal(total)} Kč</b> · settlement report {formatHal(expectedHal)} Kč
            {total !== expectedHal && parsed.length > 0 && <span className="text-amber-700"> · difference {formatHal(total - expectedHal)} Kč</span>}
          </div>
          {(parseError || error) && <p className="text-sm text-red-600">{parseError ?? error}</p>}
        </div>
        <div className="flex justify-between gap-2 px-5 py-3 border-t border-gray-100">
          <button onClick={() => save([])} disabled={saving || docs.length === 0} className="px-3 py-1.5 text-sm text-gray-500 hover:text-red-600 disabled:opacity-30">
            Clear (use report)
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Cancel</button>
            <button onClick={() => save(parsed)} disabled={saving || !!parseError || parsed.length === 0}
              className="px-4 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
