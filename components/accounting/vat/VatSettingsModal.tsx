'use client';
import { useState } from 'react';
import type { VatConfig } from '@/types/vat';

interface Props {
  config: VatConfig;
  canEdit: boolean;
  onClose: () => void;
  onSave: (config: VatConfig) => Promise<void>;
}

const FIELDS: Array<{ key: keyof VatConfig; label: string; hint?: string; group: string; type?: string }> = [
  { key: 'payerFrom', label: 'VAT payer from', hint: 'Registration effective date. Months before it are simulations.', group: 'Registration', type: 'date' },
  { key: 'dic', label: 'DIČ (digits, no CZ)', group: 'Registration' },
  { key: 'cUfo', label: 'Tax office code (c_ufo)', hint: '461 = FÚ pro Jihomoravský kraj', group: 'Registration' },
  { key: 'cPracufo', label: 'Workplace code (c_pracufo)', hint: '3003 = ÚzP Brno III', group: 'Registration' },
  { key: 'okec', label: 'Main activity CZ-NACE', hint: '552000 = short-stay accommodation', group: 'Registration' },
  { key: 'companyName', label: 'Company name', group: 'Company' },
  { key: 'street', label: 'Street', group: 'Company' },
  { key: 'houseNumber', label: 'House no. (č. p.)', group: 'Company' },
  { key: 'orientationNumber', label: 'Orientation no.', group: 'Company' },
  { key: 'city', label: 'City', group: 'Company' },
  { key: 'zip', label: 'Postcode', group: 'Company' },
  { key: 'signerFirstName', label: 'Signer — first name', group: 'People' },
  { key: 'signerLastName', label: 'Signer — last name', group: 'People' },
  { key: 'signerPosition', label: 'Signer — position', hint: 'e.g. jednatel', group: 'People' },
  { key: 'compilerFirstName', label: 'Prepared by — first name', group: 'People' },
  { key: 'compilerLastName', label: 'Prepared by — last name', group: 'People' },
  { key: 'compilerPhone', label: 'Prepared by — phone', group: 'People' },
  { key: 'email', label: 'Contact e-mail', group: 'People' },
];

export default function VatSettingsModal({ config, canEdit, onClose, onSave }: Props) {
  const [draft, setDraft] = useState<VatConfig>(config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = (key: keyof VatConfig, value: string) =>
    setDraft((d) => ({ ...d, [key]: key === 'payerFrom' ? (value || null) : value }));

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const groups = [...new Set(FIELDS.map((f) => f.group))];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <h3 className="text-base font-semibold text-gray-900">VAT settings</h3>
            <p className="text-xs text-gray-500">Used in the XML headers and to decide which months are live.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="px-5 py-4 space-y-5">
          {groups.map((g) => (
            <div key={g}>
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-400 mb-2">{g}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {FIELDS.filter((f) => f.group === g).map((f) => (
                  <label key={f.key} className="block">
                    <span className="text-xs font-medium text-gray-600">{f.label}</span>
                    <input
                      type={f.type ?? 'text'}
                      value={(draft[f.key] as string | null) ?? ''}
                      onChange={(e) => set(f.key, e.target.value)}
                      disabled={!canEdit}
                      className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-1.5 text-sm focus:border-indigo-400 focus:outline-none disabled:bg-gray-50"
                    />
                    {f.hint && <span className="text-[11px] text-gray-400">{f.hint}</span>}
                  </label>
                ))}
              </div>
            </div>
          ))}
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-gray-100">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-800">Close</button>
          {canEdit && (
            <button onClick={save} disabled={saving} className="px-4 py-1.5 text-sm font-medium rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
