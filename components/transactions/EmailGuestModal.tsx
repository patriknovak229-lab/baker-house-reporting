'use client';
import { useState } from 'react';
import type { Reservation } from '@/types/reservation';

interface Props {
  reservation: Reservation;
  /** Defaults to additionalEmail → invoiceData.billingEmail → email — caller
   *  passes the resolved best email so this component doesn't duplicate logic. */
  defaultEmail: string;
  onClose: () => void;
  /** Called after a successful send so the parent can refresh / show a toast. */
  onSent?: () => void;
}

/** Template descriptor — keeps the selector data-driven so adding more
 *  templates later (Booking confirmation, Late check-out request, etc.)
 *  is just an entry in this array. */
interface TemplateOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** Disabled templates show in the list but can't be picked yet. */
  disabled?: boolean;
}

const TEMPLATES: TemplateOption[] = [
  {
    id: 'thank-you',
    label: 'Thank You',
    description: 'Thanks the guest for their stay and includes a voucher code',
    icon: '🙏',
  },
  // Future templates can be added here — kept as a placeholder list so the
  // UI shape is established before more arrive.
];

export default function EmailGuestModal({
  reservation,
  defaultEmail,
  onClose,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onSent,
}: Props) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <h2 className="text-base font-semibold text-gray-900">Email Guest</h2>
            <p className="text-[11px] text-gray-500 mt-0.5">
              To: <span className="font-mono">{defaultEmail}</span>
              <span className="text-gray-400"> · from reservations@bakerhouseapartments.cz</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — template picker */}
        <div className="px-6 py-5 space-y-3">
          <p className="text-xs font-medium text-gray-600">Pick a template</p>
          <div className="space-y-2">
            {TEMPLATES.map((tpl) => (
              <button
                key={tpl.id}
                disabled={tpl.disabled}
                onClick={() => setSelectedTemplateId(tpl.id)}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-colors ${
                  selectedTemplateId === tpl.id
                    ? 'border-indigo-400 bg-indigo-50'
                    : 'border-gray-200 hover:bg-gray-50'
                } ${tpl.disabled ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <span className="text-xl leading-none">{tpl.icon}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900">{tpl.label}</p>
                    <p className="text-[11px] text-gray-500 mt-0.5">{tpl.description}</p>
                  </div>
                </div>
              </button>
            ))}
          </div>

          {selectedTemplateId && (
            <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg text-[11px] text-amber-800">
              Template flow not implemented yet — the next phase wires up voucher generation,
              preview, manual edits, and send for guest {reservation.firstName}.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            disabled
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md opacity-40 cursor-not-allowed"
            title="Coming in the next phase"
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
