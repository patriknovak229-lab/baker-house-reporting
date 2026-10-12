'use client';
import { useEffect, useState } from 'react';
import type { BankTransaction } from '@/types/bankTransaction';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { StripeSettlementPlan } from '@/utils/stripeSettlement';
import { formatAmount, formatDate } from '@/utils/formatters';

interface Props {
  transaction: BankTransaction;
  onBooked: (tx: BankTransaction, group: SettlementGroup) => void;
}

/**
 * Reconcile-drawer tab for a Stripe payout credit: asks Stripe what the payout
 * contains (dry run), shows how it would be booked, and books it on request.
 * Same records Auto-match creates — see utils/stripeSettlement.
 */
export default function StripePayoutPanel({ transaction: tx, onBooked }: Props) {
  const [plan, setPlan] = useState<StripeSettlementPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [booking, setBooking] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/stripe/payout-settlement', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionId: tx.id, dryRun: true }),
        });
        const data = await res.json() as { plan?: StripeSettlementPlan; error?: string };
        if (cancelled) return;
        if (!res.ok || !data.plan) setError(data.error ?? 'Could not read the payout from Stripe');
        else setPlan(data.plan);
      } catch {
        if (!cancelled) setError('Could not reach the server');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tx.id]);

  async function book() {
    setBooking(true);
    setError(null);
    try {
      const res = await fetch('/api/stripe/payout-settlement', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transactionId: tx.id }),
      });
      const data = await res.json() as { transaction?: BankTransaction; group?: SettlementGroup; error?: string };
      if (!res.ok || !data.transaction || !data.group) { setError(data.error ?? 'Booking failed'); return; }
      onBooked(data.transaction, data.group);
    } finally {
      setBooking(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500 py-6 justify-center">
        <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        Asking Stripe what this payout contains…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500">
        Web bookings paid by card are settled like Booking / Airbnb: revenue for the bookings in this payout,
        Stripe&apos;s fees as a cost, all dated {formatDate(tx.date)}. Bookings that already have a revenue record
        (payment link, invoice issued on request) are linked, not counted again.
      </p>

      {error && <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700">{error}</div>}

      {plan && (
        <>
          <div className="space-y-1.5 max-h-72 overflow-y-auto">
            {plan.lines.map(({ line, source, reservationNumbers, guest, stay, covered }) => (
              <div key={line.id} className="border border-gray-200 rounded-lg px-3 py-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm text-gray-800 truncate">
                      {source === 'fee' ? 'Stripe fee' : source === 'refund' ? 'Refund' : (guest || 'Web booking')}
                      {reservationNumbers.length > 0 && <span className="text-gray-400"> · {reservationNumbers.join(', ')}</span>}
                    </p>
                    <p className="text-xs text-gray-500">
                      paid {formatDate(line.date)}{stay ? ` · stay ${stay}` : ''}{source === 'payment_link' ? ' · payment link' : ''}
                    </p>
                    <p className={`text-[11px] ${covered.length ? 'text-teal-700' : 'text-indigo-600'}`}>
                      {covered.length
                        ? `already in revenue: ${covered.map((c) => c.invoiceNumber).join(', ')} → linked`
                        : source === 'web' || source === 'payment_link' ? 'new web revenue' : ''}
                    </p>
                  </div>
                  <div className="text-right whitespace-nowrap">
                    <p className={`text-sm font-medium ${line.amount < 0 ? 'text-rose-600' : 'text-gray-800'}`}>{formatAmount(line.amount)}</p>
                    {line.fee > 0 && <p className="text-[11px] text-gray-400">fee {formatAmount(line.fee)}</p>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-gray-50 rounded-lg px-3 py-2 text-xs space-y-0.5">
            <div className="flex justify-between"><span className="text-gray-500">Guests paid</span><span>{formatAmount(plan.gross)}</span></div>
            <div className="flex justify-between"><span className="text-gray-500">Stripe fees → cost</span><span>−{formatAmount(plan.fees)}</span></div>
            <div className="flex justify-between font-medium">
              <span>Payout</span>
              <span className={plan.ties ? 'text-teal-700' : 'text-rose-600'}>{formatAmount(plan.net)} {plan.ties ? '= bank ✓' : '≠ bank'}</span>
            </div>
            <div className="flex justify-between pt-1 border-t border-gray-200 mt-1">
              <span className="text-gray-500">New revenue record “Web bookings (Stripe)”</span><span>{formatAmount(plan.newRevenue)}</span>
            </div>
          </div>

          {plan.issues.length > 0 && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 space-y-1">
              <p className="font-semibold">Check before booking</p>
              {plan.issues.map((i) => <p key={i}>• {i}</p>)}
            </div>
          )}

          <button
            onClick={() => { void book(); }}
            disabled={!plan.ties || booking}
            className="w-full px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 disabled:opacity-50"
          >
            {booking ? 'Booking…' : 'Book Stripe settlement'}
          </button>
        </>
      )}
    </div>
  );
}
