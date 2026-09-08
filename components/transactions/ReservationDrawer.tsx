'use client';
import { useState, useEffect, useMemo, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import QRCodeLib from "qrcode";
import PaymentLinkModal from "./PaymentLinkModal";
import type { Reservation, CustomerFlag, InvoiceData, RatingStatus, GuestRating, Issue, IssueCategory, InvoiceModification, InvoiceSplit, RateType, StayShortening } from "@/types/reservation";
import { ratingSmiley, isTopRating, formatRating } from "@/utils/rating";
import type { AdditionalPayment } from "@/types/additionalPayment";
import type { Voucher } from "@/types/voucher";
import type { SplitPayment } from "@/types/splitPayment";
import MessageThread from "./MessageThread";
import CreateVoucherModal from "./CreateVoucherModal";
import EmailGuestModal from "./EmailGuestModal";
import Badge from "@/components/shared/Badge";
import { formatDate, formatCurrency } from "@/utils/formatters";
import { pragueToday } from "@/utils/periodUtils";
import { platformRefundShare } from "@/utils/reservationRevenue";
import { planShortening, describeShortening, nightsLabel } from "@/utils/stayShorten";
import {
  freeCancelDaysLeft,
  cancellationTone,
  cancellationChipClasses,
  cancellationShortLabel,
  cancellationSummary,
  bookingGraceStatus,
} from "@/utils/cancellationPolicy";
import { computeAutoFlags, toggleFlagOverride, getEffectiveFlags } from "@/utils/flagUtils";
import { computeParking, getFreeSpaces, PARKING_SPACES } from "@/utils/parkingUtils";
import { PHYSICAL_ROOMS } from "@/utils/roomAllocation";
import { occupiersByRoom, unallocatedOverlapping } from "@/utils/moveTargets";
import { countryCodeToFlag, countryCodeToName } from "@/utils/nationalityUtils";
import {
  rateChipClasses,
  RATE_TYPES,
  RATE_TYPE_LABELS,
  RATE_TYPE_SHORT,
  effectiveRateType,
  isRateTypeInScope,
} from "@/utils/rateType";
import { getChannelColor } from "@/utils/channelColors";
import {
  printInvoice,
  buildInvoiceHTML,
  generateInvoiceNumber,
  splitInvoiceNumber,
  splitShareNote,
  splitTotals,
  revenueInvoiceId,
  PAYMENT_IBAN,
  PAYMENT_SWIFT,
  PAYMENT_ACCOUNT_DISPLAY,
} from "@/utils/invoiceUtils";
import type { PaymentQRInfo } from "@/utils/invoiceUtils";
import { formatPhoneDisplay } from "@/utils/stringUtils";
import { useSession } from "next-auth/react";
import { canMutate } from "@/utils/roles";
import type { Role } from "@/utils/roles";
import {
  autoRatePerks,
  effectiveRatePerks,
  EARLY_CHECKIN_TIME,
  LATE_CHECKOUT_TIME,
} from "@/utils/ratePerks";
import type { PerkOverrides } from "@/utils/ratePerks";

/**
 * Best guest address to bill to. Mirrors `sanitizeInvoiceEmail` in
 * utils/invoiceFieldExtractor (can't be imported here — that module top-level
 * imports the Anthropic SDK): channel-conduit aliases forward to the guest but
 * are not real addresses, so they never belong on an invoice.
 * Returns "" when there's nothing usable, leaving the field blank as before.
 */
function guestBillingEmail(res: Reservation): string {
  const usable = (v: string | undefined | null): string => {
    const e = (v ?? "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return "";
    if (/@(?:guest\.booking\.com|guest\.airbnb\.com|stayforlong\.com)$/i.test(e)) return "";
    return e;
  };
  return usable(res.additionalEmail) || usable(res.email);
}

/** `invoiceNumber` overrides the booking's own number — a split pays under its
 *  own variable symbol, which is what the server puts on the sent PDF. */
function buildPaymentQRInfo(
  reservationNumber: string,
  priceCZK: number,
  invoiceNumber?: string,
): PaymentQRInfo {
  const invoiceNum = invoiceNumber ?? generateInvoiceNumber(reservationNumber);
  const vs = invoiceNum.replace(/\D/g, "");
  const amountCZK = priceCZK;
  const spdString = `SPD*1.0*ACC:${PAYMENT_IBAN}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
  return { spdString, vs, amountCZK };
}

// ── Blackout drawer view ─────────────────────────────────────────────────────
// Stripped-down drawer for Beds24 status="black" entries: just the dates, the
// room, the reason, who created it, and a "Delete blackout" button. No
// payment / invoice / guest / messaging / cleaning sections — none of those
// concepts apply.
function BlackoutDrawerView({
  reservation,
  isMounted,
  onClose,
  onDeleted,
}: {
  reservation: Reservation;
  isMounted: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch(
        `/api/bookings/blackout?id=${encodeURIComponent(reservation.reservationNumber)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      onDeleted();
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete blackout');
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div
        className={`fixed top-0 right-0 h-full w-full sm:w-[420px] bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ${
          isMounted ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-100 text-rose-700 text-[10px] font-semibold uppercase tracking-wide">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 105.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
                Blackout
              </span>
              <span className="text-xs font-mono text-gray-400">{reservation.reservationNumber}</span>
            </div>
            <p className="text-[10px] text-gray-400 mt-1">
              Beds24 room block — no payment, no guest, no invoice
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {/* Room + dates */}
          <div className="space-y-2">
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Room</p>
              <p className="text-base font-medium text-gray-800">{reservation.room}</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">From</p>
                <p className="text-sm text-gray-700">{formatDate(reservation.checkInDate)}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">To</p>
                <p className="text-sm text-gray-700">{formatDate(reservation.checkOutDate)}</p>
              </div>
            </div>
            <div>
              <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Nights</p>
              <p className="text-sm text-gray-700">{reservation.numberOfNights}</p>
            </div>
          </div>

          <hr className="border-gray-100" />

          {/* Reason */}
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Reason</p>
            {reservation.blackoutReason ? (
              <p className="text-sm text-gray-700 whitespace-pre-wrap">{reservation.blackoutReason}</p>
            ) : (
              <p className="text-sm text-gray-400 italic">No reason recorded</p>
            )}
          </div>

          {/* Creator */}
          <div>
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Created by</p>
            <p className="text-sm text-gray-700">
              {reservation.blackoutCreatedBy ?? <span className="text-gray-400 italic">Unknown</span>}
            </p>
          </div>

          {/* Delete */}
          <div className="pt-4 border-t border-gray-100">
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="w-full py-2.5 border border-rose-300 text-rose-700 text-sm font-medium rounded-lg hover:bg-rose-50 transition-colors"
              >
                Delete blackout
              </button>
            ) : (
              <div className="space-y-2">
                <p className="text-[11px] text-gray-600">
                  This will cancel the blackout in Beds24 and re-open the room for sale.
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setConfirmDelete(false)}
                    disabled={deleting}
                    className="flex-1 py-2 border border-gray-200 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 disabled:opacity-40"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDelete}
                    disabled={deleting}
                    className="flex-1 py-2 bg-rose-600 text-white text-sm font-medium rounded-lg hover:bg-rose-700 disabled:opacity-40"
                  >
                    {deleting ? 'Deleting…' : 'Confirm delete'}
                  </button>
                </div>
              </div>
            )}
            {deleteError && (
              <p className="text-xs text-red-600 mt-2 px-2 py-1 bg-red-50 border border-red-200 rounded">
                {deleteError}
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

// ── Additional payment row with status override + delete ─────────────────────
// Stripe Checkout sessions expire 24h after creation — show a clear "expired" cue
// after 23h so the operator knows the customer needs a regenerated link.
const PAYMENT_LINK_TTL_MS = 23 * 60 * 60 * 1000;

function AdditionalPaymentRow({
  ap,
  guestPhone,
  guestName,
  onRefresh,
}: {
  ap: AdditionalPayment;
  guestPhone?: string;
  guestName?: string;
  onRefresh?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regeneratedUrl, setRegeneratedUrl] = useState<string | null>(null);
  const [regenError, setRegenError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Refund modal state
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundAmount, setRefundAmount] = useState<string>('');
  const [refundReason, setRefundReason] = useState<string>('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundError, setRefundError] = useState<string | null>(null);

  const isUnpaid = ap.status === 'unpaid';
  const isFullyRefunded = ap.status === 'refunded';
  const isPartiallyRefunded = ap.status === 'partially-refunded';
  const isRefundable = ap.status === 'paid' || isPartiallyRefunded;
  const ageMs = Date.now() - new Date(ap.createdAt).getTime();
  const linkExpired = isUnpaid && ageMs > PAYMENT_LINK_TTL_MS;

  // Sum refunds (succeeded + pending) to compute remaining refundable
  const refundsList = ap.refunds ?? [];
  const totalRefunded = refundsList
    .filter((r) => r.status === 'succeeded' || r.status === 'pending')
    .reduce((sum, r) => sum + r.amountCzk, 0);
  const remainingRefundable = Math.max(0, ap.amountCzk - totalRefunded);

  function openRefundModal() {
    setRefundAmount(String(remainingRefundable));
    setRefundReason('');
    setRefundError(null);
    setShowRefundModal(true);
  }

  async function handleSubmitRefund() {
    const amount = Number(refundAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setRefundError('Enter a positive amount');
      return;
    }
    if (amount > remainingRefundable) {
      setRefundError(`Max refundable is ${remainingRefundable.toLocaleString('cs-CZ')} Kč`);
      return;
    }
    setRefundSubmitting(true);
    setRefundError(null);
    try {
      const res = await fetch('/api/stripe/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: ap.id,
          amountCzk: amount,
          reason: refundReason.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setShowRefundModal(false);
      onRefresh?.();
    } catch (err) {
      setRefundError(err instanceof Error ? err.message : 'Refund failed');
    } finally {
      setRefundSubmitting(false);
    }
  }

  async function handleToggleStatus() {
    setBusy(true);
    try {
      await fetch(`/api/stripe/additional-payments/${encodeURIComponent(ap.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: ap.status === 'unpaid' ? 'paid' : 'unpaid' }),
      });
      onRefresh?.();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await fetch(`/api/stripe/additional-payments/${encodeURIComponent(ap.id)}`, {
        method: 'DELETE',
      });
      onRefresh?.();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  async function handleRegenerate() {
    setRegenerating(true);
    setRegenError(null);
    setRegeneratedUrl(null);
    try {
      const res = await fetch('/api/stripe/regenerate-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId: ap.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setRegeneratedUrl(data.url);
      onRefresh?.();
    } catch (err) {
      setRegenError(err instanceof Error ? err.message : 'Failed to regenerate link');
    } finally {
      setRegenerating(false);
    }
  }

  function handleCopyRegenerated() {
    if (!regeneratedUrl) return;
    navigator.clipboard.writeText(regeneratedUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleWhatsAppRegenerated() {
    if (!regeneratedUrl) return;
    const text = encodeURIComponent(
      `Hi ${guestName || 'there'}, here is your payment link for your Baker House stay: ${regeneratedUrl}`,
    );
    const num = (guestPhone ?? '').replace(/\D/g, '');
    window.open(`https://wa.me/${num}?text=${text}`, '_blank');
  }

  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        {/* Status dot */}
        <span
          className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full text-white shrink-0 ${
            isUnpaid ? "bg-amber-500 animate-pulse" : "bg-emerald-500"
          }`}
        >
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
              d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </span>

        {/* Description + dates */}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-800 truncate">{ap.description}</p>
          <p className="text-[10px] text-gray-500">
            Sent {ap.createdAt.slice(0, 10)}
            {ap.paidAt ? ` · Paid ${ap.paidAt.slice(0, 10)}` : ""}
            {linkExpired && (
              <span className="ml-1 text-rose-600 font-medium">· Link expired</span>
            )}
          </p>
        </div>

        {/* Amount + status label */}
        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-gray-900">
            {ap.amountCzk.toLocaleString("cs-CZ")} Kč
          </p>
          <span
            className={`text-[10px] font-medium ${
              isUnpaid ? "text-amber-600"
              : isFullyRefunded ? "text-rose-600"
              : isPartiallyRefunded ? "text-orange-600"
              : "text-emerald-600"
            }`}
          >
            {isUnpaid
              ? (linkExpired ? "Pending · expired" : "Pending")
              : isFullyRefunded
                ? "Refunded"
                : isPartiallyRefunded
                  ? `Partially refunded · ${remainingRefundable.toLocaleString("cs-CZ")} Kč left`
                  : "Paid"}
          </span>
        </div>
      </div>

      {/* Refund history — listed beneath the row when any refund exists */}
      {refundsList.length > 0 && (
        <div className="ml-7 space-y-0.5">
          {refundsList.map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-1.5 text-[10px] text-gray-600"
              title={`Refund ${r.id}${r.refundedBy ? ` · by ${r.refundedBy}` : ''}${r.failureReason ? ` · ${r.failureReason}` : ''}`}
            >
              <span className="text-rose-500">↩</span>
              <span className="font-medium text-gray-800">
                −{r.amountCzk.toLocaleString('cs-CZ')} Kč
              </span>
              <span className="text-gray-400">·</span>
              <span>{r.refundedAt.slice(0, 10)}</span>
              {r.status === 'pending' && (
                <span className="text-amber-600">· pending</span>
              )}
              {r.status === 'failed' && (
                <span className="text-red-600 font-medium">· failed</span>
              )}
              {r.reason && (
                <span className="text-gray-500 italic truncate ml-1">&ldquo;{r.reason}&rdquo;</span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Regenerated link preview (after Regenerate succeeds) */}
      {regeneratedUrl && (
        <div className="ml-7 space-y-1.5 rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5">
          <p className="text-[10px] font-medium text-emerald-700">New link ready:</p>
          <div className="flex items-center gap-1.5">
            <input
              readOnly
              value={regeneratedUrl}
              className="flex-1 px-2 py-1 border border-emerald-200 rounded text-[10px] text-gray-600 bg-white truncate"
            />
            <button
              onClick={handleCopyRegenerated}
              className={`px-2 py-1 text-[10px] font-medium rounded transition-colors whitespace-nowrap ${
                copied ? 'bg-green-100 text-green-700' : 'bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50'
              }`}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            {guestPhone && (
              <button
                onClick={handleWhatsAppRegenerated}
                className="px-2 py-1 text-[10px] font-medium bg-white border border-green-200 text-green-700 rounded hover:bg-green-50 transition-colors whitespace-nowrap"
                title="Send via WhatsApp"
              >
                WA
              </button>
            )}
          </div>
        </div>
      )}
      {regenError && (
        <p className="ml-7 text-[10px] text-red-600">{regenError}</p>
      )}

      {/* Action buttons */}
      {!confirmDelete ? (
        <div className="flex items-center gap-2 pl-7 flex-wrap">
          {isUnpaid && (
            <button
              onClick={handleRegenerate}
              disabled={regenerating || busy}
              className={`text-[10px] font-medium px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                linkExpired
                  ? 'bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700'
                  : 'border-indigo-200 text-indigo-600 hover:bg-indigo-50'
              }`}
              title={linkExpired ? 'Original link has expired — generate a fresh one' : 'Generate a new payment link (the old one stays valid until it expires)'}
            >
              {regenerating ? '…' : 'Regenerate link'}
            </button>
          )}
          <button
            onClick={handleToggleStatus}
            disabled={busy}
            className="text-[10px] font-medium px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            Mark as {isUnpaid ? "paid" : "unpaid"}
          </button>
          {isRefundable && remainingRefundable > 0 && (
            <button
              onClick={openRefundModal}
              disabled={busy}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-rose-200 text-rose-600 hover:bg-rose-50 disabled:opacity-40 transition-colors"
              title={`Issue a partial or full refund (up to ${remainingRefundable.toLocaleString('cs-CZ')} Kč remaining)`}
            >
              {isPartiallyRefunded ? "Refund more" : "Refund"}
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            disabled={busy}
            className="text-[10px] font-medium px-2 py-0.5 rounded border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
          >
            Delete
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 pl-7">
          <span className="text-[10px] text-red-600">Delete this record?</span>
          <button
            onClick={handleDelete}
            disabled={busy}
            className="text-[10px] font-semibold px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 transition-colors"
          >
            {busy ? "…" : "Confirm"}
          </button>
          <button
            onClick={() => setConfirmDelete(false)}
            disabled={busy}
            className="text-[10px] font-medium px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Refund modal — opens when operator clicks "Refund" / "Refund more" */}
      {showRefundModal && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4"
          onClick={() => !refundSubmitting && setShowRefundModal(false)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h2 className="text-base font-semibold text-gray-900">Refund payment</h2>
              <button
                onClick={() => !refundSubmitting && setShowRefundModal(false)}
                className="text-gray-400 hover:text-gray-600"
                disabled={refundSubmitting}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-4 space-y-3">
              <div className="rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-[12px] space-y-0.5">
                <div className="flex justify-between text-gray-600">
                  <span>Original payment</span>
                  <span className="text-gray-900 font-medium">{ap.amountCzk.toLocaleString("cs-CZ")} Kč</span>
                </div>
                {totalRefunded > 0 && (
                  <div className="flex justify-between text-gray-600">
                    <span>Already refunded</span>
                    <span className="text-rose-700 font-medium">−{totalRefunded.toLocaleString("cs-CZ")} Kč</span>
                  </div>
                )}
                <div className="flex justify-between text-gray-700 pt-1 border-t border-gray-200 mt-1">
                  <span className="font-medium">Available to refund</span>
                  <span className="text-gray-900 font-semibold">
                    {remainingRefundable.toLocaleString("cs-CZ")} Kč
                  </span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Amount to refund (CZK) <span className="text-red-500">*</span>
                </label>
                <input
                  type="number"
                  min="1"
                  max={remainingRefundable}
                  step="1"
                  value={refundAmount}
                  onChange={(e) => setRefundAmount(e.target.value)}
                  placeholder={String(remainingRefundable)}
                  disabled={refundSubmitting}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 disabled:bg-gray-50"
                  autoFocus
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  Max {remainingRefundable.toLocaleString("cs-CZ")} Kč — defaults to full available
                </p>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">
                  Reason <span className="text-gray-400 font-normal">(optional, for your records)</span>
                </label>
                <input
                  type="text"
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="e.g. Guest didn't use parking; double-charged extras"
                  disabled={refundSubmitting}
                  className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-rose-300 disabled:bg-gray-50"
                />
              </div>

              {refundError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                  {refundError}
                </p>
              )}
            </div>

            <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
              <button
                onClick={() => setShowRefundModal(false)}
                disabled={refundSubmitting}
                className="px-4 py-2 text-sm text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmitRefund}
                disabled={refundSubmitting || !refundAmount}
                className="px-4 py-2 text-sm bg-rose-600 text-white rounded-md hover:bg-rose-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {refundSubmitting ? "Processing…" : "Confirm refund"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scheduled split-payment row (link will be cron-emailed on sendDate) ─────
function ScheduledSplitPaymentRow({ sp }: { sp: SplitPayment }) {
  const today = new Date().toLocaleDateString("sv-SE");
  const isOverdue = sp.sendDate < today; // cron didn't fire yet — temporary lag, or failed
  const daysAway = (() => {
    const a = new Date(sp.sendDate + 'T00:00:00').getTime();
    const b = new Date(today + 'T00:00:00').getTime();
    return Math.round((a - b) / 86_400_000);
  })();

  return (
    <div className="px-3 py-2.5 space-y-1">
      <div className="flex items-start gap-2">
        {/* Calendar dot */}
        <span className="mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-100 text-blue-600 shrink-0">
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
              d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </span>

        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-800 truncate">{sp.description}</p>
          <p className="text-[10px] text-gray-500">
            {isOverdue ? (
              <span className="text-rose-600 font-medium">Overdue · expected {sp.sendDate}</span>
            ) : (
              <>
                Will be emailed on <span className="font-medium text-gray-700">{sp.sendDate}</span>
                {daysAway > 0 && ` · in ${daysAway} day${daysAway === 1 ? '' : 's'}`}
              </>
            )}
            {sp.failureReason && (
              <span className="block text-rose-600">Last attempt failed: {sp.failureReason}</span>
            )}
          </p>
        </div>

        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-gray-900">
            {sp.amountCzk.toLocaleString("cs-CZ")} Kč
          </p>
          <span className="text-[10px] font-medium text-blue-600">Upcoming</span>
        </div>
      </div>
    </div>
  );
}

// ── Voucher row with status + delete ────────────────────────────────────────
function VoucherRow({
  voucher,
  reservationNumber,
  onRefresh,
}: {
  voucher: Voucher;
  reservationNumber: string;
  onRefresh?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function handleDelete() {
    setBusy(true);
    try {
      await fetch(`/api/vouchers/${encodeURIComponent(voucher.id)}`, { method: 'DELETE' });
      onRefresh?.();
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  const discountLabel = voucher.discountType === 'percentage'
    ? `${voucher.value}%`
    : `${voucher.value.toLocaleString('cs-CZ')} Kč`;

  const statusColor = voucher.status === 'issued'
    ? 'bg-purple-500'
    : voucher.status === 'used'
      ? 'bg-emerald-500'
      : 'bg-gray-400';

  const statusLabel = voucher.status === 'issued'
    ? 'Active'
    : voucher.status === 'used'
      ? 'Used'
      : 'Deleted';

  // Decide what to label this row with relative to the current reservation:
  // a single voucher can attach to two different bookings (created-for vs
  // used-on). Show whichever relationship matches THIS drawer.
  const isCreatedHere = voucher.reservationNumber === reservationNumber;
  const isUsedHere = voucher.redeemedOnReservationNumber === reservationNumber;
  const relationLabel = isCreatedHere && isUsedHere
    ? 'Created & redeemed here'
    : isCreatedHere
      ? 'Created for this booking'
      : isUsedHere
        ? 'Redeemed on this booking'
        : '';
  // Cross-reference link: if voucher was created for one booking and used on
  // another, show the OTHER reservation number alongside the relation label.
  const crossRef = isCreatedHere && voucher.redeemedOnReservationNumber && !isUsedHere
    ? voucher.redeemedOnReservationNumber
    : isUsedHere && voucher.reservationNumber && !isCreatedHere
      ? voucher.reservationNumber
      : null;

  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start gap-2">
        <span className={`mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full text-white shrink-0 ${statusColor}`}>
          <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
              d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono font-semibold text-purple-700">{voucher.code}</p>
          <p className="text-[10px] text-gray-500">
            Created {voucher.createdAt.slice(0, 10)}
            {voucher.usedAt ? ` · Used ${voucher.usedAt.slice(0, 10)}` : ''}
          </p>
          {relationLabel && (
            <p className="text-[10px] font-medium text-purple-600 mt-0.5">
              {relationLabel}
              {crossRef && (
                <>
                  {' · '}
                  <span className="font-mono">#{crossRef}</span>
                </>
              )}
            </p>
          )}
        </div>
        <div className="text-right shrink-0">
          <p className="text-xs font-medium text-gray-900">{discountLabel}</p>
          <span className={`text-[10px] font-medium ${
            voucher.status === 'issued' ? 'text-purple-600' :
            voucher.status === 'used' ? 'text-emerald-600' :
            'text-gray-400'
          }`}>
            {statusLabel}
          </span>
        </div>
      </div>

      {/* Delete — only for 'issued' vouchers */}
      {voucher.status === 'issued' && (
        !confirmDelete ? (
          <div className="flex items-center gap-2 pl-7">
            <button
              onClick={() => {
                navigator.clipboard.writeText(voucher.code);
              }}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
            >
              Copy code
            </button>
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={busy}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-red-200 text-red-500 hover:bg-red-50 disabled:opacity-40 transition-colors"
            >
              Delete
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 pl-7">
            <span className="text-[10px] text-red-600">Delete this voucher?</span>
            <button
              onClick={handleDelete}
              disabled={busy}
              className="text-[10px] font-semibold px-2 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 disabled:opacity-40 transition-colors"
            >
              {busy ? '…' : 'Confirm'}
            </button>
            <button
              onClick={() => setConfirmDelete(false)}
              disabled={busy}
              className="text-[10px] font-medium px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 transition-colors"
            >
              Cancel
            </button>
          </div>
        )
      )}
    </div>
  );
}

interface ReservationDrawerProps {
  reservation: Reservation | null;
  allReservations: Reservation[];
  unreadBookingIds: Set<number>;
  onClose: () => void;
  onUpdate: (updated: Reservation) => void;
  onPaymentCreated?: () => void;
  /** Driven by TransactionsPage's persist lifecycle. Renders a toast at the
   *  top of the drawer so any onUpdate write surfaces save feedback without
   *  having to instrument every individual button. */
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

function SourceLabel({ source, color }: { source: string; color?: string }) {
  // `color` brands the chip (channel colours from utils/channelColors); without
  // it the chip stays the neutral "where this data comes from" grey.
  return (
    <span
      className={`text-[10px] font-semibold rounded px-1.5 py-0.5 ml-2 border ${
        color ? "" : "text-gray-400 border-gray-200 font-medium"
      }`}
      style={color ? { color, borderColor: color, backgroundColor: `${color}12` } : undefined}
    >
      {source}
    </span>
  );
}

function SectionTitle({
  children,
  source,
}: {
  children: React.ReactNode;
  source?: string;
}) {
  return (
    <div className="flex items-center gap-1 mb-3">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">{children}</h3>
      {source && <SourceLabel source={source} />}
    </div>
  );
}

/**
 * A drawer section with a fold. Sections the operator needs at a glance
 * (Reservation, Messaging, Reservation Management) stay open; the
 * record-keeping ones (Payment, Cancellation, Invoice) start closed so the
 * drawer opens on what is actionable rather than on a wall of history.
 *
 * `summary` is what survives the fold — a collapsed Payment section still
 * shows whether the booking is paid. Without it, collapsing would hide the
 * very signal the operator opened the drawer for.
 *
 * Open state is per-mount and deliberately NOT persisted: every reservation
 * opens with the same predictable layout.
 */
function DrawerSection({
  title,
  icon,
  source,
  sourceColor,
  summary,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  source?: string;
  sourceColor?: string;
  summary?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 mb-3 text-left group"
      >
        <svg
          className={`w-3 h-3 shrink-0 text-gray-400 transition-transform ${open ? "rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M9 5l7 7-7 7" />
        </svg>
        {icon && <span className="shrink-0 text-gray-400 group-hover:text-gray-600 transition-colors">{icon}</span>}
        <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider group-hover:text-gray-700 transition-colors">
          {title}
        </h3>
        {source && <SourceLabel source={source} color={sourceColor} />}
        {!open && summary && <span className="ml-auto flex items-center gap-1.5">{summary}</span>}
      </button>
      {open && children}
    </section>
  );
}

/** The reservation ID, sized to be read and one click to copy — it's the thing
 *  the operator pastes into Beds24, the bank, and messages to guests. */
function ReservationIdCopy({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      title={copied ? "Copied" : "Copy reservation ID"}
      className="group mt-0.5 inline-flex items-center gap-1.5 rounded px-1 -ml-1 hover:bg-gray-100 transition-colors"
    >
      <span className="text-sm font-mono font-semibold tracking-tight text-gray-700">{value}</span>
      {copied ? (
        <svg className="w-3.5 h-3.5 text-emerald-500" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg
          className="w-3.5 h-3.5 text-gray-300 group-hover:text-indigo-500 transition-colors"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
    </button>
  );
}

/**
 * Header for a task kind. Loud on purpose: the whole point of splitting the list
 * is that WHERE a task goes is obvious at a glance, so the destination is
 * spelled out in the header rather than implied by a grey caption.
 */
function TaskKindHeader({ kind }: { kind: "admin" | "ops" }) {
  const ops = kind === "ops";
  return (
    <div
      className={`rounded-lg border-l-4 px-3 py-2 mb-2.5 ${
        ops ? "border-purple-500 bg-purple-50" : "border-slate-400 bg-slate-50"
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <h4 className={`text-sm font-bold ${ops ? "text-purple-900" : "text-slate-800"}`}>
          {ops ? "Operations" : "Admin"}
        </h4>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            ops ? "bg-purple-600 text-white" : "bg-slate-600 text-white"
          }`}
        >
          {ops ? "→ goes to the cleaners" : "stays with the operator"}
        </span>
      </div>
      <p className={`text-[11px] mt-1 ${ops ? "text-purple-800" : "text-slate-600"}`}>
        {ops
          ? "Room-level work. Cleaner-facing tasks appear on this stay's cleaning in the cleaning app."
          : "Never reaches a cleaner. Shows up as a pending task in the Transactions overview."}
      </p>
    </div>
  );
}

/** Section header icons — 14px line icons, one per drawer section. */
const SECTION_ICON = {
  reservation: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3M3 11h18M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  ),
  messaging: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.9 9.9 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  payment: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h18M3 7a2 2 0 012-2h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  ),
  cancellation: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 5.636L5.636 18.364M12 21a9 9 0 110-18 9 9 0 010 18z" />
    </svg>
  ),
  management: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
    </svg>
  ),
  invoice: (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  ),
} as const;

/** Sub-heading inside a grouped section (e.g. "Notes" within Reservation Management). */
function SubTitle({
  children,
  hint,
  source,
}: {
  children: React.ReactNode;
  hint?: string;
  source?: string;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-1">
        <h4 className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{children}</h4>
        {source && <SourceLabel source={source} />}
      </div>
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// Channels an operator can attribute a manual rating to. Booking.com is out of
// 10; everything else (Airbnb, Google, Direct) is out of 5.
const MANUAL_RATING_CHANNELS: NonNullable<GuestRating["channel"]>[] = [
  "Booking.com",
  "Airbnb",
  "Google",
  "Direct",
];

function manualScaleFor(channel: string): 5 | 10 {
  return channel === "Booking.com" ? 10 : 5;
}

/**
 * Ad-hoc manual rating editor — a channel selector + numeric score. Used for the
 * cases Beds24 can't sync (Google, Direct) or before a synced review lands. Local
 * state initialises from the saved rating; the parent passes a per-reservation
 * `key` so it re-mounts (and re-seeds) when a different reservation opens.
 */
function ManualRatingEditor({
  rating,
  overridden,
  onChange,
}: {
  rating: GuestRating | null | undefined;
  overridden: boolean;
  onChange: (r: GuestRating | null) => void;
}) {
  const [channel, setChannel] = useState<NonNullable<GuestRating["channel"]>>(
    rating?.channel ?? "Google",
  );
  const [scoreInput, setScoreInput] = useState<string>(rating ? String(rating.score) : "");
  const scale = manualScaleFor(channel);

  function emit(nextChannel: NonNullable<GuestRating["channel"]>, nextScore: string) {
    const s = manualScaleFor(nextChannel);
    const n = Number(nextScore);
    if (nextScore.trim() === "" || !Number.isFinite(n)) {
      onChange(null);
      return;
    }
    onChange({
      score: Math.min(Math.max(n, 0), s),
      scale: s,
      source: "manual",
      channel: nextChannel,
    });
  }

  return (
    <div className={overridden ? "opacity-50" : ""}>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-medium text-gray-500">
          Channel
          <select
            value={channel}
            onChange={(e) => {
              const c = e.target.value as NonNullable<GuestRating["channel"]>;
              setChannel(c);
              emit(c, scoreInput);
            }}
            className="rounded-md border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-gray-400 focus:outline-none"
          >
            {MANUAL_RATING_CHANNELS.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-medium text-gray-500">
          Score
          <div className="flex items-center gap-1">
            <input
              type="number"
              min={0}
              max={scale}
              step={scale === 10 ? 0.1 : 1}
              value={scoreInput}
              placeholder="—"
              onChange={(e) => {
                setScoreInput(e.target.value);
                emit(channel, e.target.value);
              }}
              className="w-20 rounded-md border border-gray-200 px-2 py-1.5 text-sm text-gray-700 focus:border-gray-400 focus:outline-none"
            />
            <span className="text-sm text-gray-400">/ {scale}</span>
          </div>
        </label>
        {scoreInput.trim() !== "" && (
          <button
            type="button"
            onClick={() => {
              setScoreInput("");
              onChange(null);
            }}
            className="py-1.5 px-2 text-[11px] font-medium text-gray-400 hover:text-gray-600"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

const PAYMENT_STATUSES: Reservation["paymentStatus"][] = ["Unpaid", "Partially Paid", "Paid", "Refunded"];

function paymentBadgeVariant(status: Reservation["paymentStatus"]) {
  if (status === "Paid") return "green";
  if (status === "Partially Paid") return "amber";
  if (status === "Unpaid") return "red";
  return "gray";
}

function PaymentStatusControl({
  derived,
  override,
  onOverride,
}: {
  derived: Reservation["paymentStatus"];
  override: Reservation["paymentStatus"] | null;
  onOverride: (v: Reservation["paymentStatus"] | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const effective = override ?? derived;
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-1">Status</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        <Badge variant={paymentBadgeVariant(effective)}>{effective}</Badge>
        {override && (
          <span className="text-[10px] text-amber-500 font-medium">manual</span>
        )}
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="text-[10px] text-gray-400 hover:text-indigo-500 underline underline-offset-2"
          >
            override
          </button>
        )}
        {open && (
          <div className="flex items-center gap-1 flex-wrap">
            {PAYMENT_STATUSES.map((s) => (
              <button
                key={s}
                onClick={() => { onOverride(s); setOpen(false); }}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${s === effective ? "bg-indigo-100 border-indigo-300 text-indigo-700" : "border-gray-200 text-gray-600 hover:border-indigo-300"}`}
              >
                {s}
              </button>
            ))}
            {override && (
              <button
                onClick={() => { onOverride(null); setOpen(false); }}
                className="text-[10px] text-red-400 hover:text-red-600 ml-1"
              >
                clear
              </button>
            )}
            <button onClick={() => setOpen(false)} className="text-[10px] text-gray-400 hover:text-gray-600">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Cancellation policy — read-only, straight from the channel. The point of this
 * block is to answer "when can this guest still walk away for free?" without
 * the operator opening the Booking.com extranet or the Airbnb dashboard.
 *
 * Deliberately not overridable: the policy is a contract the channel already
 * made with the guest, so a local override could only ever be wrong. The raw
 * channel wording is shown verbatim underneath so the operator can verify —
 * and spot a rate plan configured differently from what they intended.
 */
function CancellationPolicyPanel({ reservation }: { reservation: Reservation }) {
  const policy = reservation.cancellationPolicy;
  const today = pragueToday();
  const daysLeft = freeCancelDaysLeft(policy, today);
  const tone = cancellationTone(policy, daysLeft, {
    stayFinished: reservation.checkOutDate < today,
  });

  if (!policy) {
    return (
      <div>
        <p className="text-[11px] text-gray-400 mb-1">Cancellation policy</p>
        <p className="text-xs text-gray-500">
          Not available — {reservation.channel}{" "}didn&apos;t send one for this booking
          {reservation.isCancelled ? " (cancelled bookings lose it)" : ""}. Check the channel
          extranet.
        </p>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-1">Cancellation policy</p>
      <div className="flex items-center gap-2 flex-wrap mb-1.5">
        <span className={cancellationChipClasses(tone)}>
          {cancellationShortLabel(tone, daysLeft)}
        </span>
        {policy.freeUntilDate && (
          <span className="text-xs text-gray-700">
            Free until <span className="font-medium">{formatDate(policy.freeUntilDate)}</span>
            <span className="text-gray-400"> ({policy.freeDays}d before arrival)</span>
          </span>
        )}
        <span
          className="text-[10px] text-gray-400"
          title={
            policy.source === "House policy"
              ? "Our own published policy — configured in utils/cancellationPolicy.ts, not sent by a channel"
              : `Read from the ${policy.source} booking data`
          }
        >
          {policy.source === "House policy" ? "house policy" : `from ${policy.source}`}
        </span>
      </div>
      <p className="text-xs text-gray-600">{cancellationSummary(policy, daysLeft, tone)}</p>
      {/* Airbnb's 24 h post-booking window applies to every stay under 28
          nights, non-refundable included — so a just-made booking is not yet
          locked in whatever the chip says. Only shown while it's still open. */}
      {(() => {
        const grace = bookingGraceStatus(policy, reservation.bookingTimestamp);
        if (!grace?.active) return null;
        return (
          <p className="mt-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
            Still inside {policy.source}&apos;s {policy.graceHoursAfterBooking} h post-booking
            cancellation period — the guest can cancel free of charge until{" "}
            <span className="font-medium">
              {grace.endsAt.toLocaleString("cs-CZ", { timeZone: "Europe/Prague", dateStyle: "short", timeStyle: "short" })}
            </span>
            , regardless of the policy above.
          </p>
        );
      })()}
      {policy.sourceText && (
        <p className="mt-1.5 text-[11px] text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 leading-relaxed">
          {policy.sourceText}
        </p>
      )}
    </div>
  );
}

/** Rate plan display + manual override. Mirrors PaymentStatusControl: shows the
 *  effective rate chip (override wins over Beds24 detection), with an inline
 *  picker. When nothing is set on an in-scope OTA stay it prompts for a manual
 *  choice — the same data gap the "Rate type missing" alert surfaces. */
function RateTypeControl({
  detected,
  override,
  onOverride,
}: {
  detected: Reservation["rateType"];
  override: Reservation["rateTypeOverride"];
  onOverride: (v: RateType | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const effective = override ?? detected ?? null;
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-1">Rate plan</p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {effective ? (
          <span className={rateChipClasses(effective)}>{RATE_TYPE_LABELS[effective]}</span>
        ) : (
          <span className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5">
            Not set
          </span>
        )}
        {override ? (
          <span className="text-[10px] text-amber-500 font-medium">manual</span>
        ) : effective ? (
          <span className="text-[10px] text-gray-400">from Beds24</span>
        ) : null}
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="text-[10px] text-gray-400 hover:text-indigo-500 underline underline-offset-2"
          >
            {effective ? "change" : "set"}
          </button>
        )}
        {open && (
          <div className="flex items-center gap-1 flex-wrap">
            {RATE_TYPES.map((s) => (
              <button
                key={s}
                onClick={() => { onOverride(s); setOpen(false); }}
                className={`text-[10px] px-1.5 py-0.5 rounded border ${s === effective ? "bg-indigo-100 border-indigo-300 text-indigo-700" : "border-gray-200 text-gray-600 hover:border-indigo-300"}`}
              >
                {RATE_TYPE_SHORT[s]}
              </button>
            ))}
            {override && (
              <button
                onClick={() => { onOverride(null); setOpen(false); }}
                className="text-[10px] text-red-400 hover:text-red-600 ml-1"
                title="Clear manual override — revert to Beds24 detection"
              >
                auto
              </button>
            )}
            <button onClick={() => setOpen(false)} className="text-[10px] text-gray-400 hover:text-gray-600">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Rate-driven perks. Shows the effective state of each event (early check-in /
 * late checkout / special treatment) and lets the operator turn one off for
 * this booking or reset it to the rate default.
 *
 * Deliberately NOT an authoring surface. The special-treatment note used to be
 * free text here, which made two different controls both able to message a
 * cleaner — and the quieter one silently didn't (see the Operations block in
 * Reservation Management, which is now the single ad-hoc channel). What a rate
 * grants is defined by the rate; what someone should do for one guest is a room
 * task. Removal stays, because running out of wine is a real thing.
 */
function PerksControl({
  rate,
  reservationDate,
  override,
  onOverride,
}: {
  rate: RateType | null;
  reservationDate?: string | null;
  override: PerkOverrides | null | undefined;
  onOverride: (v: PerkOverrides) => void;
}) {
  const auto = autoRatePerks(rate, reservationDate);
  const eff = effectiveRatePerks(auto, override);
  const ov: PerkOverrides = override ?? {};

  function setBool(field: "earlyCheckIn" | "lateCheckout", next: boolean) {
    const copy: PerkOverrides = { ...ov };
    if (next === auto[field]) delete copy[field]; // back to auto → drop the override
    else copy[field] = next;
    onOverride(copy);
  }
  /** `null` = removed for this booking, `undefined` = back to the rate default.
   *  A string is still accepted by the type for any historic stored value, but
   *  nothing here writes one any more. */
  function setSpecial(next: null | undefined) {
    const copy: PerkOverrides = { ...ov };
    if (next === undefined || next === auto.specialTreatment) delete copy.specialTreatment;
    else copy.specialTreatment = next;
    onOverride(copy);
  }

  const boolRow = (
    field: "earlyCheckIn" | "lateCheckout",
    label: string,
    color: string,
  ) => {
    const on = eff[field];
    const overridden = ov[field] !== undefined && ov[field] !== auto[field];
    return (
      <div className="flex items-center gap-2">
        <button
          onClick={() => setBool(field, !on)}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium border ${
            on ? `${color} text-white border-transparent` : "bg-white text-gray-400 border-gray-200"
          }`}
        >
          <span>{on ? "✓" : "—"}</span>
          {label}
        </button>
        {overridden ? (
          <button
            onClick={() => { const c = { ...ov }; delete c[field]; onOverride(c); }}
            className="text-[10px] text-amber-500 hover:text-indigo-500"
            title="Manual override — reset to rate default"
          >
            manual · ↺ auto
          </button>
        ) : (
          <span className="text-[10px] text-gray-300">from rate</span>
        )}
      </div>
    );
  };

  const specialOverridden = ov.specialTreatment !== undefined && ov.specialTreatment !== auto.specialTreatment;

  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-1">Perks (rate-based · manual overrides)</p>
      <p className="text-[10px] text-gray-400 mb-1.5">
        Set by the rate. To ask a cleaner for something on this stay, add a room task under
        Reservation Management → Operations.
      </p>
      <div className="space-y-1.5">
        {boolRow("earlyCheckIn", `Early check-in (from ${EARLY_CHECKIN_TIME})`, "bg-teal-500")}
        {boolRow("lateCheckout", `Late checkout (until ${LATE_CHECKOUT_TIME})`, "bg-orange-500")}
        {/* Special treatment — read-only from the rate; removable, not authorable. */}
        {eff.specialTreatment ? (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full bg-purple-500 px-2 py-0.5 text-[11px] font-medium text-white">
              🍷 {eff.specialTreatment}
            </span>
            <button
              onClick={() => setSpecial(null)}
              className="text-[10px] text-red-400 hover:text-red-600"
              title="Not happening for this booking (e.g. out of wine)"
            >
              remove
            </button>
            {specialOverridden && (
              <button
                onClick={() => setSpecial(undefined)}
                className="text-[10px] text-amber-500 hover:text-indigo-500"
                title="Reset to rate default"
              >
                ↺ auto
              </button>
            )}
          </div>
        ) : auto.specialTreatment ? (
          // The rate grants one but the operator removed it — keep the row so
          // it can be put back.
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2 py-0.5 text-[11px] font-medium text-gray-400 line-through">
              🍷 {auto.specialTreatment}
            </span>
            <button
              onClick={() => setSpecial(undefined)}
              className="text-[10px] text-amber-500 hover:text-indigo-500"
              title="Reset to rate default"
            >
              ↺ auto
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function GuestEmailInput({ onSave }: { onSave: (email: string) => void }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 text-[11px] text-indigo-500 hover:text-indigo-700"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
        Add guest email
      </button>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <input
        autoFocus
        type="email"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="guest@email.com"
        className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
        onKeyDown={(e) => {
          if (e.key === "Enter" && value.trim()) { onSave(value.trim()); setOpen(false); }
          if (e.key === "Escape") { setOpen(false); setValue(""); }
        }}
      />
      <button
        onClick={() => { if (value.trim()) { onSave(value.trim()); setOpen(false); } }}
        className="text-xs px-2 py-1 bg-indigo-500 text-white rounded hover:bg-indigo-600"
      >
        Save
      </button>
      <button onClick={() => { setOpen(false); setValue(""); }} className="text-gray-400 hover:text-gray-600 text-xs">✕</button>
    </div>
  );
}

function PhoneEditField({
  value,
  onSave,
}: {
  value: string;
  onSave: (phone: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [copied, setCopied] = useState(false);

  // Keep draft in sync if reservation changes
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) {
    return (
      <div>
        <p className="text-[11px] text-gray-400 mb-0.5">Phone</p>
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-gray-800">
            {value ? formatPhoneDisplay(value) : <span className="text-gray-400">—</span>}
          </p>
          <button
            onClick={() => { setDraft(value); setEditing(true); }}
            title="Edit phone"
            className="shrink-0 text-gray-400 hover:text-indigo-500"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15.232 5.232l3.536 3.536M9 13l6.586-6.586a2 2 0 112.828 2.828L11.828 15.828a2 2 0 01-1.414.586H9v-2a2 2 0 01.586-1.414z" />
            </svg>
          </button>
          {value && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(value);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              title={copied ? "Copied" : "Copy phone"}
              className={`shrink-0 ${copied ? "text-emerald-500" : "text-gray-400 hover:text-indigo-500"}`}
            >
              {copied ? (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              ) : (
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              )}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-0.5">Phone</p>
      <div className="flex items-center gap-1.5">
        <input
          autoFocus
          type="tel"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="+420 000 000 000"
          className="flex-1 text-sm border border-gray-200 rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-400"
          onKeyDown={(e) => {
            if (e.key === "Enter") { onSave(draft.trim()); setEditing(false); }
            if (e.key === "Escape") { setEditing(false); setDraft(value); }
          }}
        />
        <button
          onClick={() => { onSave(draft.trim()); setEditing(false); }}
          className="text-xs px-2 py-1 bg-indigo-500 text-white rounded hover:bg-indigo-600"
        >
          Save
        </button>
        <button
          onClick={() => { setEditing(false); setDraft(value); }}
          className="text-gray-400 hover:text-gray-600 text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-800">{value}</p>
    </div>
  );
}

/** Sensible default actionable date per category — saves the operator
 *  scrolling the date picker from today. Late-checkout + invoice (send
 *  invoice) key off CHECK-OUT; everything else (problem, mid-stay cleaning,
 *  special treatment, early check-in) keys off CHECK-IN. Always overridable
 *  via the date field. Falls back to today when no reservation is in scope. */
function defaultIssueDate(category: IssueCategory, res: Reservation | null): string {
  if (!res) return new Date().toLocaleDateString("sv-SE");
  return category === "lateCheckout" || category === "invoice"
    ? res.checkOutDate
    : res.checkInDate;
}

// ── Issue category config ─────────────────────────────────────────────────────
const CATEGORY_CONFIG: Record<IssueCategory, {
  label: string;
  badgeBg: string;
  cardBg: string;
  cardBorder: string;
  buttonBg: string;
  icon: React.ReactNode;
}> = {
  problem: {
    label: "Problem",
    badgeBg: "bg-red-500",
    cardBg: "bg-red-50",
    cardBorder: "border-red-100",
    buttonBg: "bg-red-600 hover:bg-red-700",
    icon: <span className="font-bold leading-none">!</span>,
  },
  repair: {
    label: "Repair",
    badgeBg: "bg-amber-700",
    cardBg: "bg-amber-50/70",
    cardBorder: "border-amber-200",
    buttonBg: "bg-amber-700 hover:bg-amber-800",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <circle cx="12" cy="12" r="3" strokeWidth={2.5} />
      </svg>
    ),
  },
  invoice: {
    label: "Send Invoice",
    badgeBg: "bg-amber-500",
    cardBg: "bg-amber-50",
    cardBorder: "border-amber-100",
    buttonBg: "bg-amber-500 hover:bg-amber-600",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
      </svg>
    ),
  },
  cleaning: {
    label: "Mid-stay Cleaning",
    badgeBg: "bg-blue-500",
    cardBg: "bg-blue-50",
    cardBorder: "border-blue-100",
    buttonBg: "bg-blue-600 hover:bg-blue-700",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
      </svg>
    ),
  },
  // The generic ad-hoc room request for CLEANERS. Deliberately keeps the
  // `special` key (was "Special Treatment") so entries logged under the old
  // label carry over with no migration. Purple is kept on purpose: cleaners
  // already read purple as "something extra to prepare" in the cleaning app.
  special: {
    label: "Room Task — cleaners",
    badgeBg: "bg-purple-500",
    cardBg: "bg-purple-50",
    cardBorder: "border-purple-100",
    buttonBg: "bg-purple-600 hover:bg-purple-700",
    icon: <span className="font-bold leading-none">!</span>,
  },
  // Same shape, but for facility/equipment — stays in reporting, never
  // published to the cleaning app.
  facility: {
    label: "Room Task — facility",
    badgeBg: "bg-slate-500",
    cardBg: "bg-slate-50",
    cardBorder: "border-slate-200",
    buttonBg: "bg-slate-600 hover:bg-slate-700",
    icon: <span className="font-bold leading-none">!</span>,
  },
  // Guest-driven REQUESTS — distinct from operator-side "problems".
  // Same teal/orange palette as the table badges in ReservationTable.tsx.
  earlyCheckin: {
    label: "Early Check-in Request",
    badgeBg: "bg-teal-500",
    cardBg: "bg-teal-50",
    cardBorder: "border-teal-100",
    buttonBg: "bg-teal-600 hover:bg-teal-700",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={2.5} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 7v5l3 2" />
      </svg>
    ),
  },
  lateCheckout: {
    label: "Late Checkout Request",
    badgeBg: "bg-orange-500",
    cardBg: "bg-orange-50",
    cardBorder: "border-orange-100",
    buttonBg: "bg-orange-600 hover:bg-orange-700",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M6 3h12M6 21h12M8 3v3a4 4 0 008 0V3M8 21v-3a4 4 0 018-0v3" />
      </svg>
    ),
  },
};

/**
 * Who acts on each category. The drawer renders one list per kind, so this map
 * IS the Admin/Operations split — no new field, no migration: every issue ever
 * logged classifies itself.
 *
 *   ADMIN      — falls on the operator: invoices, complaints, cancellations,
 *                the generic problem, and the booking actions (non-arrival,
 *                shorten stay) that sit alongside them.
 *   OPERATIONS — room-level work. `special` (cleaners) and the three
 *                guest-timing categories reach the cleaning app; `facility`
 *                is operator-only, marked as such per row so the mistake of
 *                "I logged it and the cleaner never saw it" can't repeat.
 */
const CATEGORY_KIND: Record<IssueCategory, "admin" | "ops"> = {
  problem: "admin",
  repair: "admin",
  invoice: "admin",
  // Order matters: KIND_CATEGORIES derives from it, and the FIRST entry of each
  // kind is what a fresh form defaults to. The cleaner-facing room task leads
  // because it is the common case.
  special: "ops",
  facility: "ops",
  cleaning: "ops",
  earlyCheckin: "ops",
  lateCheckout: "ops",
};

/** Operations categories the cleaning app is (or will be) fed. */
const CLEANER_FACING: ReadonlySet<IssueCategory> = new Set<IssueCategory>([
  "special",
  "cleaning",
  "earlyCheckin",
  "lateCheckout",
]);

const KIND_CATEGORIES: Record<"admin" | "ops", IssueCategory[]> = {
  admin: (Object.keys(CATEGORY_KIND) as IssueCategory[]).filter((c) => CATEGORY_KIND[c] === "admin"),
  ops: (Object.keys(CATEGORY_KIND) as IssueCategory[]).filter((c) => CATEGORY_KIND[c] === "ops"),
};

/** Categories where the note IS the task, so free text is required. */
const TEXT_REQUIRED: ReadonlySet<IssueCategory> = new Set<IssueCategory>([
  "problem",
  "repair",
  "special",
  "facility",
]);

/**
 * One task list + its entry form, for a single kind (Admin or Operations).
 *
 * Extracted from the old single "Issue Log" so the two kinds can sit in
 * separate blocks without duplicating ~120 lines of JSX. Each block owns its
 * OWN draft state — otherwise typing an operational task would bleed into the
 * admin form and vice versa.
 */
function TaskBlock({
  kind,
  reservation,
  onAdd,
  onToggleResolved,
  onDelete,
}: {
  kind: "admin" | "ops";
  reservation: Reservation;
  onAdd: (issue: Issue) => void;
  onToggleResolved: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const categories = KIND_CATEGORIES[kind];
  const [category, setCategory] = useState<IssueCategory>(categories[0]);
  const [text, setText] = useState("");
  const [date, setDate] = useState(() => defaultIssueDate(categories[0], reservation));
  const [timing, setTiming] = useState<"prep" | "after">("prep");
  const [saved, setSaved] = useState(false);
  const [adding, setAdding] = useState(false);

  const issues = (reservation.issues ?? [])
    .filter((i) => CATEGORY_KIND[i.category ?? "problem"] === kind)
    .sort((a, b) => a.actionableDate.localeCompare(b.actionableDate));

  // Timing decides WHICH cleaning a cleaner-facing room task lands on, so it's
  // only asked where it can change the answer.
  const showTiming = category === "special";
  const textRequired = TEXT_REQUIRED.has(category);

  /** Timing decides the date the task is anchored to, because that's the date
   *  the operator would otherwise have to work out by hand: "before arrival"
   *  means ready by check-in, "during / after" means the checkout clean — which
   *  is the last cleaning of the stay, and the right guess unless a mid-stay
   *  clean exists, in which case the operator moves the date. */
  function pickTiming(next: "prep" | "after") {
    setTiming(next);
    setDate(next === "after" ? reservation.checkOutDate : reservation.checkInDate);
  }

  function submit() {
    if (textRequired && !text.trim()) return;
    onAdd({
      id: Date.now().toString(),
      category,
      text: text.trim(),
      actionableDate: date,
      resolved: false,
      createdAt: new Date().toISOString(),
      ...(showTiming ? { timing } : {}),
    });
    setText("");
    setCategory(categories[0]);
    setDate(defaultIssueDate(categories[0], reservation));
    setTiming("prep");
    setAdding(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div>
      {issues.length > 0 && (
        <div className="space-y-2 mb-2">
          {issues.map((issue) => {
            const cat = issue.category ?? "problem";
            const cfg = CATEGORY_CONFIG[cat];
            return (
              <div
                key={issue.id}
                className={`rounded-md border px-3 py-2.5 ${
                  issue.resolved ? "border-gray-100 bg-gray-50" : `${cfg.cardBorder} ${cfg.cardBg}`
                }`}
              >
                <div className="flex items-start gap-2">
                  <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-white ${cfg.badgeBg}`}>
                    {cfg.icon}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`text-xs font-semibold mb-0.5 flex items-center gap-1.5 flex-wrap ${issue.resolved ? "text-gray-400" : "text-gray-500"}`}>
                      {cfg.label}
                      {kind === "ops" && !issue.resolved && (
                        <span
                          className={`inline-flex items-center rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide ${
                            CLEANER_FACING.has(cat)
                              ? "bg-purple-100 text-purple-700"
                              : "bg-gray-100 text-gray-500"
                          }`}
                          title={
                            CLEANER_FACING.has(cat)
                              ? "Shown to the assigned cleaner in the cleaning app"
                              : "Stays in this app — the cleaner never sees it"
                          }
                        >
                          {CLEANER_FACING.has(cat) ? "→ cleaner" : "operator only"}
                        </span>
                      )}
                      {issue.timing && !issue.resolved && (
                        <span className="inline-flex items-center rounded bg-white/70 border border-current/20 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-gray-500">
                          {issue.timing === "prep" ? "before arrival" : "during / after stay"}
                        </span>
                      )}
                    </p>
                    {issue.text && (
                      <p className={`text-sm ${issue.resolved ? "line-through text-gray-400" : "text-gray-800"}`}>
                        {issue.text}
                      </p>
                    )}
                    <p className="text-[11px] text-gray-400 mt-0.5">
                      Actionable: {formatDate(issue.actionableDate)}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => onToggleResolved(issue.id)}
                      className={`text-[11px] px-2 py-1 rounded border font-medium transition-colors ${
                        issue.resolved
                          ? "border-gray-200 text-gray-500 hover:border-green-300 hover:text-green-600"
                          : "border-green-200 text-green-700 bg-green-50 hover:bg-green-100"
                      }`}
                    >
                      {issue.resolved ? "Reopen" : "Resolve"}
                    </button>
                    <button
                      onClick={() => onDelete(issue.id)}
                      className="p-1 text-gray-300 hover:text-red-400 transition-colors"
                      title="Delete"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* The form is behind a click: with two blocks on screen, two always-open
          forms would bury the lists they belong to. */}
      {!adding ? (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-white shadow-sm transition-colors ${
            kind === "ops"
              ? "bg-purple-600 hover:bg-purple-700"
              : "bg-slate-600 hover:bg-slate-700"
          }`}
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          {saved
            ? "Added ✓ — add another"
            : kind === "ops"
            ? "Add room task / request"
            : "Add admin task"}
        </button>
      ) : (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50/60 p-2.5">
          <div className="flex gap-1.5 flex-wrap">
            {categories.map((cat) => {
              const cfg = CATEGORY_CONFIG[cat];
              const active = category === cat;
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => {
                    setCategory(cat);
                    setDate(defaultIssueDate(cat, reservation));
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                    active
                      ? `${cfg.badgeBg} text-white border-transparent`
                      : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                  }`}
                >
                  <span className={`inline-flex items-center justify-center w-3.5 h-3.5 rounded-full ${active ? "bg-white/20" : cfg.badgeBg} text-white`}>
                    {cfg.icon}
                  </span>
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {kind === "ops" && (
            <p className="text-[10px] text-gray-400">
              {CLEANER_FACING.has(category)
                ? "The assigned cleaner reads this text as written — write it in Czech."
                : "Stays in this app. The cleaner never sees a facility task."}
            </p>
          )}

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
            placeholder={
              kind === "ops"
                ? "e.g. Doplnit minibar · Připravit láhev vína · Navíc ručníky"
                : "Describe the issue or task…"
            }
            className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
          />

          {showTiming && (
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">When does it need doing?</label>
              <div className="flex gap-1.5">
                {([
                  ["prep", "Before arrival", "Goes on the cleaning that readies the room for this guest"],
                  ["after", "During / after the stay", "Goes on the next cleaning up to check-out"],
                ] as const).map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    title={hint}
                    onClick={() => pickTiming(value)}
                    className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                      timing === value
                        ? "bg-purple-600 text-white border-transparent"
                        : "bg-white text-gray-500 border-gray-200 hover:border-gray-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex-1">
              <label className="text-[11px] text-gray-400 block mb-1">Actionable date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div className="flex items-end gap-1.5">
              <button
                onClick={submit}
                disabled={textRequired && !text.trim()}
                className={`px-4 py-1.5 text-white text-sm font-medium rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${CATEGORY_CONFIG[category].buttonBg}`}
              >
                Add
              </button>
              <button
                onClick={() => { setAdding(false); setText(""); }}
                className="px-2 py-1.5 text-gray-400 hover:text-gray-600 text-sm"
              >
                ✕
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Invoice preview rendered inside the drawer ────────────────────────────────
/**
 * Shows the REAL invoice: the same `buildInvoiceHTML()` output that Print,
 * Send and Save-to-Drive produce, in an iframe.
 *
 * This was previously a hand-written JSX copy of the invoice layout, so every
 * change to the actual document silently left the preview behind — it was
 * showing an invoice that no longer existed. One source of truth is the point:
 * what renders here is what the guest receives.
 */

/** A4 (210mm) minus the 18mm side margins `buildInvoiceHTML` sets via @page,
 *  at 96dpi — the width the invoice actually occupies on the printed page. */
const PRINT_CONTENT_WIDTH_PX = 658;
/** Placeholder box height until the iframe reports its real content height. */
const PREVIEW_PLACEHOLDER_HEIGHT = 420;

function InvoicePreview({
  res,
  invoiceData,
  includeQR,
  split,
  splitCount,
}: {
  res: Reservation;
  invoiceData: InvoiceData;
  includeQR: boolean;
  /** Preview one part of a split booking instead of the whole booking. */
  split?: InvoiceSplit;
  splitCount?: number;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [docHeight, setDocHeight] = useState(0);
  const [scale, setScale] = useState(1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  // Build exactly what would be printed, QR toggle included. forEmail=true
  // omits the auto-print script — a preview must never open a print dialog.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const invoiceNum = split
        ? splitInvoiceNumber(res.reservationNumber, split.seq)
        : generateInvoiceNumber(res.reservationNumber);
      const amount = split ? split.amountCzk : res.price;
      let payment: { qrDataUrl: string; info: PaymentQRInfo } | undefined;
      if (includeQR) {
        const info = buildPaymentQRInfo(res.reservationNumber, amount, invoiceNum);
        const qrDataUrl = await QRCodeLib.toDataURL(info.spdString, {
          width: 200,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        payment = { qrDataUrl, info };
      }
      const renderOpts = split
        ? {
            amountOverride: split.amountCzk,
            guestName: split.guestName,
            shareNote: splitShareNote(res.reservationNumber, split.seq, splitCount ?? 1),
          }
        : undefined;
      const next = buildInvoiceHTML(res, invoiceData, invoiceNum, payment, true, undefined, renderOpts);
      // Identical strings bail out of the re-render, so an unrelated
      // reservation update doesn't reload the iframe.
      if (!cancelled) setHtml(next);
    })();
    return () => { cancelled = true; };
  }, [res, invoiceData, includeQR, split, splitCount]);

  // Scale the full-width page down to whatever width the drawer gives us.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, el.clientWidth / PRINT_CONTENT_WIDTH_PX));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Body height, not documentElement — documentElement fills the iframe and
   *  would latch the height at its largest ever value. */
  function measure() {
    const body = frameRef.current?.contentDocument?.body;
    if (!body) return;
    const h = Math.ceil(body.getBoundingClientRect().height || body.scrollHeight);
    if (h > 0) setDocHeight(h);
  }

  return (
    <div
      ref={wrapRef}
      className="rounded-lg border border-[#e8e0d6] bg-white overflow-hidden"
      style={{ height: docHeight ? Math.ceil(docHeight * scale) : PREVIEW_PLACEHOLDER_HEIGHT }}
    >
      {html && (
        <iframe
          ref={frameRef}
          srcDoc={html}
          title="Invoice preview"
          // No scripts: the document carries none, and this guarantees it.
          sandbox="allow-same-origin"
          onLoad={() => {
            measure();
            // The signature webfont lands late and changes the height.
            frameRef.current?.contentDocument?.fonts?.ready.then(measure).catch(() => {});
          }}
          style={{
            width: PRINT_CONTENT_WIDTH_PX,
            height: docHeight || PREVIEW_PLACEHOLDER_HEIGHT,
            border: 0,
            display: "block",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
          }}
        />
      )}
    </div>
  );
}

// ── Split invoice editor ─────────────────────────────────────────────────────
/**
 * The form for billing one booking to several parties — two colleagues sharing
 * an apartment who each need their own invoice to expense.
 *
 * Each part carries its own customer block and its own share of the price. The
 * parts may add up to less than the booking (the rest simply isn't invoiced)
 * but never to more, which is the one hard rule enforced here and again
 * server-side in /api/send-invoice.
 */
function SplitInvoiceEditor({
  reservation,
  splits,
  onPatch,
  onPatchInvoiceData,
  onRemove,
  onAdd,
  onSplitEvenly,
  onSaveDetails,
  saved,
  onGenerate,
}: {
  reservation: Reservation;
  splits: InvoiceSplit[];
  onPatch: (id: string, patch: Partial<InvoiceSplit>) => void;
  onPatchInvoiceData: (id: string, patch: Partial<InvoiceData>) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
  onSplitEvenly: () => void;
  onSaveDetails: () => void;
  saved: boolean;
  onGenerate: () => void;
}) {
  const { allocated, remaining, over } = splitTotals(reservation.price, splits);
  const missingEmail = splits.some((sp) => !sp.invoiceData.billingEmail.trim());
  const missingAmount = splits.some((sp) => !(Number(sp.amountCzk) > 0));
  const canGenerate = splits.length > 0 && !over && !missingEmail && !missingAmount;

  const inputCls =
    "w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500";

  return (
    <div className="space-y-3">
      {splits.map((sp, i) => (
        <div key={sp.id} className="border border-indigo-100 rounded-lg p-3 space-y-2.5 bg-indigo-50/30">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-indigo-800">
              Invoice {i + 1}
              <span className="ml-2 font-mono font-normal text-[10px] text-indigo-500">
                {splitInvoiceNumber(reservation.reservationNumber, sp.seq)}
              </span>
            </span>
            {splits.length > 1 && (
              <button
                onClick={() => onRemove(sp.id)}
                className="text-gray-400 hover:text-red-600"
                aria-label={`Remove invoice ${i + 1}`}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          <div>
            <label className="text-[11px] text-gray-400 block mb-1">Company Name</label>
            <input
              type="text"
              value={sp.invoiceData.companyName}
              onChange={(e) => onPatchInvoiceData(sp.id, { companyName: e.target.value })}
              className={inputCls}
              placeholder="Acme s.r.o."
            />
          </div>
          <div>
            <label className="text-[11px] text-gray-400 block mb-1">Company Address</label>
            <input
              type="text"
              value={sp.invoiceData.companyAddress}
              onChange={(e) => onPatchInvoiceData(sp.id, { companyAddress: e.target.value })}
              className={inputCls}
              placeholder="Šumavská 10, 602 00, Brno"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">IČO</label>
              <input
                type="text"
                value={sp.invoiceData.ico}
                onChange={(e) => onPatchInvoiceData(sp.id, { ico: e.target.value })}
                className={inputCls}
                placeholder="19876107"
              />
            </div>
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">DIČ / VAT</label>
              <input
                type="text"
                value={sp.invoiceData.vatNumber}
                onChange={(e) => onPatchInvoiceData(sp.id, { vatNumber: e.target.value })}
                className={inputCls}
                placeholder="CZ19876107"
              />
            </div>
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">Billing Email</label>
              <input
                type="email"
                value={sp.invoiceData.billingEmail}
                onChange={(e) => onPatchInvoiceData(sp.id, { billingEmail: e.target.value })}
                className={`${inputCls} ${sp.invoiceData.billingEmail.trim() ? "" : "border-amber-300"}`}
                placeholder="accounting@acme.cz"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">Amount (CZK)</label>
              <input
                type="number"
                min={0}
                value={Number.isFinite(sp.amountCzk) ? sp.amountCzk : ""}
                onChange={(e) => onPatch(sp.id, { amountCzk: Number(e.target.value) })}
                className={`${inputCls} ${Number(sp.amountCzk) > 0 ? "" : "border-amber-300"}`}
              />
            </div>
            <div>
              <label className="text-[11px] text-gray-400 block mb-1">Guest name (optional)</label>
              <input
                type="text"
                value={sp.guestName ?? ""}
                onChange={(e) => onPatch(sp.id, { guestName: e.target.value })}
                className={inputCls}
                placeholder={`${reservation.firstName} ${reservation.lastName}`.trim()}
              />
            </div>
          </div>
        </div>
      ))}

      <div className="flex gap-2">
        <button
          onClick={onAdd}
          className="flex-1 py-1.5 px-3 border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
        >
          + Add invoice
        </button>
        <button
          onClick={onSplitEvenly}
          className="flex-1 py-1.5 px-3 border border-gray-300 text-gray-700 text-xs font-medium rounded-md hover:bg-gray-50 transition-colors"
        >
          Split evenly
        </button>
      </div>

      {/* Running total against the booking price */}
      <div
        className={`rounded-md px-2.5 py-2 text-xs border ${
          over
            ? "bg-red-50 border-red-200 text-red-700"
            : Math.abs(remaining) <= 1
              ? "bg-green-50 border-green-200 text-green-800"
              : "bg-amber-50 border-amber-200 text-amber-800"
        }`}
      >
        <div className="flex justify-between font-medium">
          <span>Invoiced</span>
          <span>
            {formatCurrency(allocated)} of {formatCurrency(reservation.price)}
          </span>
        </div>
        {over ? (
          <p className="mt-1">
            <span className="font-semibold">Over the booking price by {formatCurrency(-remaining)}.</span>{" "}
            The parts of a bill can add up to less than the stay, never more — reduce an amount before generating.
          </p>
        ) : Math.abs(remaining) <= 1 ? (
          <p className="mt-1">The whole booking is accounted for.</p>
        ) : (
          <p className="mt-1">{formatCurrency(remaining)} of the booking will not be invoiced.</p>
        )}
      </div>

      {(missingEmail || missingAmount) && !over && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
          Every invoice needs a billing email and an amount above zero.
        </p>
      )}

      <div className="flex gap-2">
        <button
          onClick={onSaveDetails}
          className={`flex-1 py-2 px-4 border text-sm font-medium rounded-md transition-colors ${
            saved
              ? "border-green-300 bg-green-50 text-green-700"
              : "border-gray-300 text-gray-700 hover:bg-gray-50"
          }`}
        >
          {saved ? "✓ Saved" : "Save details"}
        </button>
        <button
          onClick={onGenerate}
          disabled={!canGenerate}
          className="flex-1 py-2 px-4 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Generate {splits.length} invoice{splits.length === 1 ? "" : "s"}
        </button>
      </div>
    </div>
  );
}

// ── Payment breakdown ────────────────────────────────────────────────────────
function BreakdownRow({
  label,
  value,
  bold,
}: {
  label: string;
  value: number;
  bold?: boolean;
}) {
  const isDeduction = value < 0;
  return (
    <div className={`flex justify-between items-baseline ${bold ? "font-semibold text-gray-800" : "text-gray-600"}`}>
      <span>{label}</span>
      <span className={isDeduction ? "text-red-500" : bold ? "text-gray-900" : ""}>
        {isDeduction ? `−${formatCurrency(Math.abs(value))}` : formatCurrency(value)}
      </span>
    </div>
  );
}

// Channels where zero fees is expected and should NOT trigger a warning
const NO_FEE_CHANNELS: Reservation["channel"][] = ["Direct-Phone"];

function PaymentBreakdown({ reservation }: { reservation: Reservation }) {
  const [open, setOpen] = useState(false);
  const { price, commissionAmount, paymentChargeAmount, channel } = reservation;
  const totalFees = commissionAmount + paymentChargeAmount;
  // `price` is what the channel billed. A refund comes off it to give the gross
  // booking value everything downstream uses, but the fees are NOT recalculated
  // — the channel charged them on the original price and never learns about the
  // refund, so the effective rate on this booking is simply higher.
  const refund = platformRefundShare(reservation);
  const gbv = price - refund;
  const net = gbv - totalFees;
  const hasBreakdown = totalFees > 0 || refund > 0;
  const feesAreMissing = !NO_FEE_CHANNELS.includes(channel) && totalFees === 0;

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => hasBreakdown && setOpen((v) => !v)}
          className={`flex items-center gap-1 text-sm font-medium text-gray-800 transition-colors ${hasBreakdown ? "hover:text-indigo-600 cursor-pointer" : "cursor-default"}`}
          title={hasBreakdown ? "Click to see fee breakdown" : undefined}
        >
          {formatCurrency(gbv)}
          {hasBreakdown && (
            <svg
              className={`w-3 h-3 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
        </button>
        {feesAreMissing && (
          <span
            title="Commission data not available from Beds24 for this booking"
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 text-amber-600 text-[10px] font-bold leading-none shrink-0"
          >
            !
          </span>
        )}
      </div>
      {open && hasBreakdown && (
        <div className="mt-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2.5 space-y-1.5 text-xs">
          {refund > 0 ? (
            <>
              <BreakdownRow label="Billed by channel" value={price} />
              <BreakdownRow label="Refunded to guest" value={-refund} />
              <div className="border-t border-gray-200 pt-1.5">
                <BreakdownRow label="Gross Booking Value" value={gbv} />
              </div>
            </>
          ) : (
            <BreakdownRow label="Gross Booking Value" value={gbv} />
          )}
          {totalFees > 0 && (
            <BreakdownRow
              label={refund > 0 ? `${channel} commission (on ${formatCurrency(price)})` : `${channel} commission`}
              value={-totalFees}
            />
          )}
          <div className="border-t border-gray-200 pt-1.5">
            <BreakdownRow label="Net Revenue" value={net} bold />
          </div>
          {reservation.amountPaid > 0 && reservation.amountPaid !== price && (
            <div className="border-t border-gray-200 pt-1.5 text-gray-500">
              <div className="flex justify-between items-baseline">
                <span>Deposited (Beds24)</span>
                <span>{formatCurrency(reservation.amountPaid)}</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────
export default function ReservationDrawer({
  reservation,
  allReservations,
  unreadBookingIds,
  onClose,
  onUpdate,
  onPaymentCreated,
  saveStatus = 'idle',
}: ReservationDrawerProps) {
  const { data: naSession } = useSession();
  const naUserEmail = (naSession?.user as { email?: string } | undefined)?.email ?? "";
  const naUserRole = (naSession?.user as { role?: Role } | undefined)?.role;
  const canEditNonArrival = naUserRole ? canMutate(naUserRole, "transactions") : false;
  const [naBusy, setNaBusy] = useState(false);

  // Shorten-stay form (see applyShortening below).
  const [shortenOpen, setShortenOpen] = useState(false);
  const [shortenArrival, setShortenArrival] = useState("");
  const [shortenDeparture, setShortenDeparture] = useState("");
  const [shortenReason, setShortenReason] = useState("");
  const [shortenLock, setShortenLock] = useState(true);
  const [shortenBusy, setShortenBusy] = useState(false);
  const [shortenError, setShortenError] = useState<string | null>(null);

  // Mark a booking as non-arrival: cancel + channel-lock it in Beds24 (frees the
  // room to resell; guest stays charged on the OTA), then persist our flag, seed
  // the net-retained price, and drop a checkout-dated task to finalise the price.
  async function markNonArrival() {
    if (!reservation || naBusy) return;
    const r = reservation;
    if (
      !window.confirm(
        `Mark as non-arrival?\n\nThis cancels the booking in Beds24 and locks the channel so the room can be resold. ${r.firstName} ${r.lastName} stays booked and charged on ${r.channel} — nothing changes on the OTA side.`,
      )
    )
      return;
    setNaBusy(true);
    try {
      const res = await fetch("/api/bookings/non-arrival", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservationNumber: r.reservationNumber }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const taskId = `na-price-${r.reservationNumber}`;
      const issues = r.issues ?? [];
      const withTask = issues.some((i) => i.id === taskId)
        ? issues
        : [
            ...issues,
            {
              id: taskId,
              category: "problem" as const,
              text: "Non-arrival: set the final price after the channel refund",
              actionableDate: r.checkOutDate,
              resolved: false,
              createdAt: new Date().toISOString(),
            },
          ];
      onUpdate({
        ...r,
        isCancelled: true,
        nonArrival: { flaggedAt: new Date().toISOString(), flaggedBy: naUserEmail, originalPriceCzk: r.price },
        nonArrivalNetPriceCzk: r.price,
        // Net-retained already nets off any channel-side refund — keeping a
        // separate platform refund on top would deduct the same money twice.
        platformRefund: null,
        issues: withTask,
      });
    } catch (e) {
      alert(e instanceof Error ? e.message : "Failed to cancel the booking in Beds24");
    } finally {
      setNaBusy(false);
    }
  }

  // Remove the non-arrival flag (overlay only) + its task. Does NOT un-cancel in
  // Beds24 — reinstate the booking manually there if this was a mistake.
  function unmarkNonArrival() {
    if (!reservation) return;
    const r = reservation;
    const taskId = `na-price-${r.reservationNumber}`;
    onUpdate({
      ...r,
      nonArrival: null,
      nonArrivalNetPriceCzk: null,
      issues: (r.issues ?? []).filter((i) => i.id !== taskId),
    });
  }

  // Set the final net retained; fulfilling this resolves the checkout task.
  function setNonArrivalNet(value: number) {
    if (!reservation) return;
    const r = reservation;
    const taskId = `na-price-${r.reservationNumber}`;
    onUpdate({
      ...r,
      nonArrivalNetPriceCzk: Math.max(0, Math.round(value || 0)),
      issues: (r.issues ?? []).map((i) => (i.id === taskId ? { ...i, resolved: true } : i)),
    });
  }

  // ── Shorten the stay ───────────────────────────────────────────────────────
  // The guest keeps the booking but drops a night (arrives later or leaves
  // earlier) and wants that night's money back. The dates move in Beds24 — so
  // the trimmed nights are instantly back on sale — and the price is adjusted
  // by hand afterwards, because the refund is what was agreed with the guest,
  // not what a rate would say. Beds24 never recalculates a price on a date
  // change, so nothing here touches money.
  const shortenPreview =
    reservation && shortenArrival && shortenDeparture
      ? planShortening(
          { arrival: reservation.checkInDate, departure: reservation.checkOutDate },
          { arrival: shortenArrival, departure: shortenDeparture },
          { today: pragueToday() },
        )
      : null;

  function openShorten() {
    if (!reservation) return;
    setShortenArrival(reservation.checkInDate);
    setShortenDeparture(reservation.checkOutDate);
    setShortenReason("");
    // OTA bookings default to locked: the channel still holds the original
    // reservation and its next sync would otherwise re-block a night we may
    // already have resold. Direct bookings have no channel to lock.
    setShortenLock(reservation.channel === "Booking.com" || reservation.channel === "Airbnb");
    setShortenError(null);
    setShortenOpen(true);
  }

  async function applyShortening() {
    if (!reservation || shortenBusy) return;
    const r = reservation;
    if (!shortenPreview) return;
    if (!shortenPreview.ok) {
      setShortenError(shortenPreview.error);
      return;
    }
    const { plan } = shortenPreview;
    if (
      !window.confirm(
        `Shorten this stay?\n\n${r.checkInDate} → ${r.checkOutDate} becomes ${plan.toArrival} → ${plan.toDeparture} (${describeShortening(plan)}).\n\n` +
          `${nightsLabel(plan.nightsRemoved)} go back on sale immediately. The price stays at ${formatCurrency(r.price)} — adjust it in Beds24 and refund the guest yourself.` +
          (shortenLock ? `\n\n${r.channel} will be blocked from changing this booking, so it can't restore the original dates.` : ""),
      )
    )
      return;
    setShortenBusy(true);
    setShortenError(null);
    try {
      const res = await fetch("/api/bookings/shorten", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: r.reservationNumber,
          arrival: plan.toArrival,
          departure: plan.toDeparture,
          lockChannel: shortenLock,
          reason: shortenReason.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      // Shortening the same booking twice keeps the ORIGINAL dates and price as
      // the baseline — that's what "what did this stay start out as?" means.
      const prior = r.stayShortened;
      const record: StayShortening = {
        shortenedAt: new Date().toISOString(),
        shortenedBy: naUserEmail,
        fromArrival: prior?.fromArrival ?? plan.fromArrival,
        fromDeparture: prior?.fromDeparture ?? plan.fromDeparture,
        toArrival: plan.toArrival,
        toDeparture: plan.toDeparture,
        nightsRemoved: (prior?.nightsRemoved ?? 0) + plan.nightsRemoved,
        originalPriceCzk: prior?.originalPriceCzk ?? r.price,
        channelLocked: shortenLock || prior?.channelLocked,
        reason: shortenReason.trim() || prior?.reason,
      };
      const taskId = `shorten-price-${r.reservationNumber}`;
      const issues = r.issues ?? [];
      const withTask = issues.some((i) => i.id === taskId && !i.resolved)
        ? issues
        : [
            ...issues.filter((i) => i.id !== taskId),
            {
              id: taskId,
              category: "problem" as const,
              text: `Stay shortened by ${nightsLabel(record.nightsRemoved)} — adjust the price in Beds24 and refund the guest`,
              actionableDate: pragueToday(),
              resolved: false,
              createdAt: new Date().toISOString(),
            },
          ];
      // Optimistic dates: Beds24 is the source of truth, but its shared cache
      // coalesces refetches for 90s, so show the operator their own change now.
      onUpdate({
        ...r,
        checkInDate: plan.toArrival,
        checkOutDate: plan.toDeparture,
        numberOfNights: plan.nightsAfter,
        stayShortened: record,
        issues: withTask,
      });
      setShortenOpen(false);
    } catch (e) {
      setShortenError(e instanceof Error ? e.message : "Failed to shorten the stay in Beds24");
    } finally {
      setShortenBusy(false);
    }
  }

  /** Drop the shortening record. Does NOT restore the dates in Beds24. */
  function clearShortening() {
    if (!reservation) return;
    const r = reservation;
    const taskId = `shorten-price-${r.reservationNumber}`;
    onUpdate({
      ...r,
      stayShortened: null,
      issues: (r.issues ?? []).filter((i) => i.id !== taskId),
    });
  }

  // ── Partial platform refund ────────────────────────────────────────────────
  // Money handed back to a guest on a booking that still stands. The channel
  // never learns about it (Booking.com keeps commissioning the original price
  // and doesn't push the reduction to Beds24), so it only exists here.
  function setPlatformRefund(patch: { amountCzk?: number; refundedAt?: string; reason?: string }) {
    if (!reservation) return;
    const r = reservation;
    const existing = r.platformRefund;
    const amountCzk = Math.max(0, Math.round(patch.amountCzk ?? existing?.amountCzk ?? 0));
    // `||` not `??` on the free-text fields: clearing an input yields "", and an
    // empty date would render a blank control the operator can't tell from
    // unset. An emptied reason genuinely means "no reason", so drop it.
    const reason = (patch.reason ?? existing?.reason ?? "").trim();
    onUpdate({
      ...r,
      platformRefund: {
        amountCzk,
        refundedAt: patch.refundedAt || existing?.refundedAt || pragueToday(),
        reason: reason || undefined,
        flaggedAt: existing?.flaggedAt ?? new Date().toISOString(),
        flaggedBy: existing?.flaggedBy ?? naUserEmail,
        // Frozen at first flag so the refund keeps its proportional share if the
        // booking price is later split across rooms or edited on the channel.
        originalPriceCzk: existing?.originalPriceCzk ?? r.price,
      },
    });
  }

  function clearPlatformRefund() {
    if (!reservation) return;
    onUpdate({ ...reservation, platformRefund: null });
  }

  const [notes, setNotes] = useState("");
  const [includePaymentQR, setIncludePaymentQR] = useState(false);
  const [invoiceForm, setInvoiceForm] = useState<InvoiceData>({
    companyName: "",
    companyAddress: "",
    ico: "",
    vatNumber: "",
    billingEmail: "",
  });
  const [isMounted, setIsMounted] = useState(false);
  const [isSendingInvoice, setIsSendingInvoice] = useState(false);
  const [sendInvoiceError, setSendInvoiceError] = useState<string | null>(null);
  /** Raw SMTP deferral — the mail server took the message but didn't confirm it. */
  const [sendInvoiceDeferral, setSendInvoiceDeferral] = useState<string | null>(null);
  /** Which modified version is mid-send / mid-Drive-save (one row at a time). */
  const [sendingModId, setSendingModId] = useState<string | null>(null);
  const [savingModDriveId, setSavingModDriveId] = useState<string | null>(null);
  const [modDriveResults, setModDriveResults] = useState<Record<string, { url: string; name: string }>>({});
  const [modDriveErrors, setModDriveErrors] = useState<Record<string, string>>({});
  const [isSavingToDrive, setIsSavingToDrive] = useState(false);
  const [driveSaveResult, setDriveSaveResult] = useState<{ url: string; name: string } | null>(null);
  const [driveSaveError, setDriveSaveError] = useState<string | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [showEmailGuestModal, setShowEmailGuestModal] = useState(false);
  const [showWhatsAppGuestModal, setShowWhatsAppGuestModal] = useState(false);
  const [showSmsGuestModal, setShowSmsGuestModal] = useState(false);

  // ── Manual "move to another room" (maintenance / ad-hoc) ──
  const [showMoveModal, setShowMoveModal] = useState(false);
  const [moveTargetRoom, setMoveTargetRoom] = useState("");
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [moveDone, setMoveDone] = useState(false);
  /** Operator override: offer occupied units too (see the modal's own note). */
  const [moveIgnoreOccupied, setMoveIgnoreOccupied] = useState(false);

  /**
   * Who holds each unit during this stay, and which overlapping bookings are
   * still unallocated. Both live in `utils/moveTargets` (with tests) — the
   * cancelled-booking exclusion in there is what makes this picker usable at
   * all; see that module's notes.
   */
  const occupiersDuringStay = useMemo(
    () => (reservation ? occupiersByRoom(reservation, allReservations) : new Map<string, Reservation[]>()),
    [reservation, allReservations],
  );
  const unallocatedDuringStay = useMemo(
    () => (reservation ? unallocatedOverlapping(reservation, allReservations) : []),
    [reservation, allReservations],
  );

  const occupierLabel = (r: Reservation): string => {
    const who = r.isBlackout ? "Blackout" : `${r.firstName ?? ""} ${r.lastName ?? ""}`.trim() || r.reservationNumber;
    return `${who} · ${formatDate(r.checkInDate)}→${formatDate(r.checkOutDate)}`;
  };

  async function handleMoveRoom() {
    if (!reservation || !moveTargetRoom) return;
    setMoveSubmitting(true);
    setMoveError(null);
    try {
      const res = await fetch("/api/bookings/relocate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationNumber: reservation.reservationNumber,
          toRoom: moveTargetRoom,
          allowOccupied: moveIgnoreOccupied,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setMoveDone(true);
      // Re-syncs bookings from Beds24 so the new room shows — and picks up the
      // fresh move notice, which is what the alert bar renders.
      onPaymentCreated?.();
      setTimeout(() => {
        setShowMoveModal(false);
        setMoveDone(false);
      }, 1400);
    } catch (e) {
      setMoveError(e instanceof Error ? e.message : "Move failed");
    } finally {
      setMoveSubmitting(false);
    }
  }
  const [invoiceExpanded, setInvoiceExpanded] = useState(false);
  // ── Split invoices: one booking billed to several parties ──────────────────
  // Editable drafts, mirroring how invoiceForm is held locally until the
  // operator generates. Never written to the reservation on keystroke.
  const [splitMode, setSplitMode] = useState(false);
  const [splitForms, setSplitForms] = useState<InvoiceSplit[]>([]);
  /** Which split the preview + QR panel are showing (issued state). */
  const [previewSplitId, setPreviewSplitId] = useState<string | null>(null);
  /** Which split is mid-send / mid-Drive-save (one at a time). */
  const [sendingSplitId, setSendingSplitId] = useState<string | null>(null);
  const [savingSplitDriveId, setSavingSplitDriveId] = useState<string | null>(null);
  const [splitDriveResults, setSplitDriveResults] = useState<Record<string, { url: string; name: string }>>({});
  const [splitDriveErrors, setSplitDriveErrors] = useState<Record<string, string>>({});
  // Check-Stripe button state
  const [checkingStripe, setCheckingStripe] = useState(false);
  const [checkStripeResult, setCheckStripeResult] = useState<
    | { kind: 'ok'; status: string | null; updated: number; checked: number; message?: string; webPayment?: { amountCzk: number; paidAt: string; guestEmail: string; stripeFeeCzk?: number; stripePaymentStatus?: string | null }; manualLink?: boolean }
    | { kind: 'error'; message: string }
    | null
  >(null);
  // Manual Stripe session linking (operator pastes a cs_… session ID)
  const [showManualLink, setShowManualLink] = useState(false);
  const [manualSessionId, setManualSessionId] = useState('');
  const [linkingManually, setLinkingManually] = useState(false);
  // Send-confirmation button state
  const [sendingConfirmation, setSendingConfirmation] = useState(false);
  const [confirmationResult, setConfirmationResult] = useState<
    | { kind: 'ok'; sentTo: string }
    | { kind: 'error'; message: string }
    | null
  >(null);
  // Preview modal state — confirmation flow now renders the email in an iframe
  // before committing to Send, to catch styling / data issues.
  const [showConfirmationPreview, setShowConfirmationPreview] = useState(false);
  const [confirmationPreviewHtml, setConfirmationPreviewHtml] = useState<string | null>(null);
  const [confirmationPreviewError, setConfirmationPreviewError] = useState<string | null>(null);
  // Save details feedback
  const [saveDetailsSaved, setSaveDetailsSaved] = useState(false);
  // Notes save feedback
  const [noteSaved, setNoteSaved] = useState(false);
  // Add issue feedback
  // Invoice request accept/reject — tracks which request is currently being processed
  const [processingInvoiceRequestId, setProcessingInvoiceRequestId] = useState<string | null>(null);
  // Invoice modification editor
  const [showModifyEditor, setShowModifyEditor] = useState(false);
  const [modifyDateRanges, setModifyDateRanges] = useState<{ from: string; to: string }[]>([{ from: "", to: "" }]);
  const [modifyNights, setModifyNights] = useState(0);
  const [modifyGuests, setModifyGuests] = useState(1);
  const [modifyRoom, setModifyRoom] = useState("");
  const [modifyGuestName, setModifyGuestName] = useState("");
  const [modifyLineDescription, setModifyLineDescription] = useState("");
  // Invoice total override (string so it can be left blank = use booking price).
  const [modifyAmount, setModifyAmount] = useState("");

  const parkingResult = useMemo(() => computeParking(allReservations), [allReservations]);
  const myParking = reservation ? parkingResult.byReservation.get(reservation.reservationNumber) ?? null : null;
  const freeSpaces = reservation
    ? getFreeSpaces(parkingResult, reservation.checkInDate, reservation.checkOutDate, reservation.reservationNumber)
    : [];

  useEffect(() => {
    if (reservation) {
      setIncludePaymentQR(reservation.includeQR ?? false);
      setInvoiceExpanded(false);
      setNotes(reservation.notes);
      setDriveSaveResult(null);
      setDriveSaveError(null);
      setSaveDetailsSaved(false);
      setCheckStripeResult(null);
      setConfirmationResult(null);
      setShowConfirmationPreview(false);
      setConfirmationPreviewHtml(null);
      setConfirmationPreviewError(null);
      setShowModifyEditor(false);
      setModifyDateRanges([{ from: reservation.checkInDate, to: reservation.checkOutDate }]);
      setModifyNights(reservation.numberOfNights);
      setModifyGuests(reservation.numberOfGuests);
      setModifyRoom(reservation.room);
      setModifyGuestName("");
      setModifyLineDescription("");
      setModifyAmount("");
      // Billing email defaults to the guest's own address so the operator
      // doesn't retype it — a stored billingEmail always wins, and the field
      // stays editable either way.
      const guestEmail = guestBillingEmail(reservation);
      if (reservation.invoiceData) {
        setInvoiceForm({
          ...reservation.invoiceData,
          billingEmail: reservation.invoiceData.billingEmail || guestEmail,
        });
      } else {
        setInvoiceForm({ companyName: "", companyAddress: "", ico: "", vatNumber: "", billingEmail: guestEmail });
      }
      const splits = reservation.invoiceSplits ?? [];
      setSplitForms(splits);
      setSplitMode(splits.length > 0);
      setPreviewSplitId(splits[0]?.id ?? null);
      setSplitDriveResults({});
      setSplitDriveErrors({});
    }
  }, [reservation]);

  // Send / Drive feedback belongs to the booking, not to a single save — keyed
  // on the reservation number so the onUpdate that follows a send (which
  // replaces the reservation object) doesn't wipe the notice it just produced.
  useEffect(() => {
    setSendInvoiceError(null);
    setSendInvoiceDeferral(null);
    setModDriveResults({});
    setModDriveErrors({});
    // Half-filled shorten dates belong to the booking they were typed for.
    setShortenOpen(false);
    setShortenError(null);
  }, [reservation?.reservationNumber]);

  // Re-seed the shorten form whenever the stay's dates move — on opening it, and
  // if a sync (or another operator) changes them while it sits open. Without
  // this the form keeps offering dates the booking no longer has. Deliberately
  // depends on the two date VALUES, not the reservation object, so an unrelated
  // save (a note, a flag) doesn't wipe what the operator is typing.
  const shortenSeedIn = reservation?.checkInDate;
  const shortenSeedOut = reservation?.checkOutDate;
  useEffect(() => {
    if (!shortenOpen || !shortenSeedIn || !shortenSeedOut) return;
    setShortenArrival(shortenSeedIn);
    setShortenDeparture(shortenSeedOut);
  }, [shortenOpen, shortenSeedIn, shortenSeedOut]);

  useEffect(() => {
    if (reservation) {
      requestAnimationFrame(() => setIsMounted(true));
    } else {
      setIsMounted(false);
    }
  }, [reservation]);

  // Auto-calculate nights when modification date ranges change
  useEffect(() => {
    const auto = modifyDateRanges.reduce((sum, r) => {
      if (!r.from || !r.to || r.from >= r.to) return sum;
      const a = new Date(r.from + "T00:00:00");
      const b = new Date(r.to + "T00:00:00");
      return sum + Math.round((b.getTime() - a.getTime()) / 86_400_000);
    }, 0);
    if (auto > 0) setModifyNights(auto);
  }, [modifyDateRanges]);

  if (!reservation) return null;

  const autoFlags = computeAutoFlags(reservation, allReservations);
  const effectiveFlags = getEffectiveFlags(reservation, allReservations);

  function handleToggleFlag(flag: CustomerFlag) {
    const newOverrides = toggleFlagOverride(reservation!, flag, allReservations);
    onUpdate({ ...reservation!, manualFlagOverrides: newOverrides });
  }

  function handleRating(status: RatingStatus) {
    onUpdate({ ...reservation!, ratingStatus: status });
  }

  // Manual ad-hoc rating — the fallback for channels Beds24 can't sync (Google,
  // Direct) or before a synced review lands. Passing null clears it.
  function handleManualRating(rating: GuestRating | null) {
    onUpdate({ ...reservation!, manualRating: rating });
  }

  function saveNote() {
    onUpdate({ ...reservation!, notes });
    setNoteSaved(true);
    setTimeout(() => setNoteSaved(false), 2500);
  }

  /** Append one task. The form (category, text, date, timing) lives in
   *  `TaskBlock`, which owns its own draft state per kind — the drawer only
   *  persists what comes back. */
  function addIssue(issue: Issue) {
    onUpdate({ ...reservation!, issues: [...(reservation!.issues ?? []), issue] });
  }

  function toggleIssueResolved(id: string) {
    const issues = (reservation!.issues ?? []).map((i) =>
      i.id === id ? { ...i, resolved: !i.resolved } : i
    );
    onUpdate({ ...reservation!, issues });
  }

  function deleteIssue(id: string) {
    const issues = (reservation!.issues ?? []).filter((i) => i.id !== id);
    onUpdate({ ...reservation!, issues });
  }

  function handleSaveDetails() {
    onUpdate({ ...reservation!, invoiceData: invoiceForm });
    setSaveDetailsSaved(true);
    setTimeout(() => setSaveDetailsSaved(false), 2500);
  }

  function saveModification() {
    const validRanges = modifyDateRanges.filter(r => r.from && r.to && r.from < r.to);
    if (validRanges.length === 0) return;
    // Optional invoice-total override — self-contained to this invoice, never
    // touches the booking price. Blank/invalid = fall back to res.price.
    const parsedAmount = Number(modifyAmount.trim());
    const hasAmount = modifyAmount.trim() !== "" && Number.isFinite(parsedAmount) && parsedAmount >= 0;
    const mod: InvoiceModification = {
      id: Date.now().toString(),
      dateRanges: validRanges,
      numberOfNights: modifyNights,
      numberOfGuests: modifyGuests,
      room: modifyRoom,
      ...(modifyGuestName.trim() ? { guestName: modifyGuestName.trim() } : {}),
      ...(modifyLineDescription.trim() ? { lineDescription: modifyLineDescription.trim() } : {}),
      ...(hasAmount ? { amount: parsedAmount } : {}),
      createdAt: new Date().toISOString(),
    };
    onUpdate({
      ...reservation!,
      invoiceModifications: [...(reservation!.invoiceModifications ?? []), mod],
    });
    setShowModifyEditor(false);
  }

  function deleteModification(id: string) {
    const invoiceModifications = (reservation!.invoiceModifications ?? []).filter(m => m.id !== id);
    onUpdate({ ...reservation!, invoiceModifications });
  }

  async function handlePrintModified(mod: InvoiceModification) {
    if (reservation!.invoiceData) {
      // Honour the "Include Payment QR" toggle here too — the QR asks for this
      // version's total, which may be an override of the booking price.
      const qrInfo = includePaymentQR
        ? buildPaymentQRInfo(reservation!.reservationNumber, mod.amount ?? reservation!.price)
        : undefined;
      await printInvoice(reservation!, reservation!.invoiceData, qrInfo, mod);
    }
  }

  /**
   * Send a modified version. Treated exactly like a normal invoice send:
   * respects the payment-QR toggle, marks the reservation Sent, and stamps
   * sentAt/sentTo on THIS version so the list shows what went where.
   */
  async function handleSendModified(mod: InvoiceModification) {
    setSendInvoiceError(null);
    setSendInvoiceDeferral(null);
    setIsSendingInvoice(true);
    setSendingModId(mod.id);
    try {
      const res = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR, modification: mod }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      if (json.outcome === 'deferred') setSendInvoiceDeferral(json.deferral ?? 'Mail server deferred the message');
      const sentTo: string = json.sentTo ?? reservation!.invoiceData?.billingEmail ?? '';
      const updated = {
        ...reservation!,
        invoiceStatus: 'Sent' as const,
        invoiceModifications: (reservation!.invoiceModifications ?? []).map((m) =>
          m.id === mod.id ? { ...m, sentAt: new Date().toISOString(), sentTo } : m,
        ),
      };
      onUpdate(updated);
      syncRevenueInvoices(updated, mod.amount);
    } catch (err) {
      setSendInvoiceError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setIsSendingInvoice(false);
      setSendingModId(null);
    }
  }

  /** Same Drive archive as a normal invoice, rendering this version's PDF. */
  async function handleSaveModifiedToDrive(mod: InvoiceModification) {
    setModDriveErrors((prev) => { const next = { ...prev }; delete next[mod.id]; return next; });
    setSavingModDriveId(mod.id);
    try {
      const res = await fetch('/api/transactions/invoice-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR, modification: mod }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { driveUrl: string; driveFileName: string };
      setModDriveResults((prev) => ({ ...prev, [mod.id]: { url: data.driveUrl, name: data.driveFileName } }));
    } catch (err) {
      setModDriveErrors((prev) => ({
        ...prev,
        [mod.id]: err instanceof Error ? err.message : 'Failed to save to Drive',
      }));
    } finally {
      setSavingModDriveId(null);
    }
  }

  /** Make the revenue-invoice records match what this booking actually issued.
   *
   *  Sends the whole desired set rather than upserting one record, because the
   *  count changes: one invoice for the booking, or one per split. Anything the
   *  booking no longer issues is dropped server-side, so switching between the
   *  two never leaves a stale record double-counting the stay in the P&L.
   *
   *  `amountCZK` overrides the booking price when a modified version with its
   *  own total is the invoice that was actually issued. */
  async function syncRevenueInvoices(res: typeof reservation, amountCZK?: number) {
    if (!res || !res.includeQR) return;
    try {
      const invoiceDate = new Date().toISOString().slice(0, 10);
      const guestName = `${res.firstName} ${res.lastName}`.trim();
      const splits = res.invoiceSplits ?? [];
      const invoices = splits.length > 0
        ? splits.map((sp) => ({
            id: revenueInvoiceId(res.reservationNumber, sp.seq),
            invoiceNumber: splitInvoiceNumber(res.reservationNumber, sp.seq),
            invoiceDate,
            amountCZK: sp.amountCzk,
            guestName: sp.guestName?.trim() || guestName,
          }))
        : [{
            id: revenueInvoiceId(res.reservationNumber),
            invoiceNumber: generateInvoiceNumber(res.reservationNumber),
            invoiceDate,
            amountCZK: amountCZK ?? res.price,
            guestName,
          }];
      await fetch('/api/revenue-invoices/reservation-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationNumber: res.reservationNumber, invoices }),
      });
    } catch { /* non-fatal */ }
  }

  // ── Split invoices ─────────────────────────────────────────────────────────

  /** Next unused sequence. Never reuses a number an invoice already carries. */
  function nextSplitSeq(list: InvoiceSplit[]): number {
    return list.reduce((max, sp) => Math.max(max, sp.seq), 0) + 1;
  }

  function blankSplit(seq: number, amountCzk: number, billingEmail = ""): InvoiceSplit {
    return {
      id: `${Date.now()}-${seq}`,
      seq,
      invoiceData: { companyName: "", companyAddress: "", ico: "", vatNumber: "", billingEmail },
      amountCzk,
      createdAt: new Date().toISOString(),
    };
  }

  /** Turning the toggle on seeds the case it exists for: two colleagues, an
   *  even share each, first one pre-filled with the guest's billing address. */
  function toggleSplitMode() {
    const next = !splitMode;
    setSplitMode(next);
    if (next && splitForms.length === 0) {
      // Whole crowns on both parts: a booking price carrying haléře would
      // otherwise seed a field with 13760.599999999999. The ≤1 Kč tolerance in
      // splitTotals absorbs the rounding.
      const price = Math.round(reservation?.price ?? 0);
      const half = Math.round(price / 2);
      setSplitForms([
        blankSplit(1, half, invoiceForm.billingEmail),
        blankSplit(2, price - half),
      ]);
    }
  }

  function addSplit() {
    setSplitForms((list) => {
      const { remaining } = splitTotals(reservation?.price ?? 0, list);
      return [...list, blankSplit(nextSplitSeq(list), Math.max(0, Math.round(remaining)))];
    });
  }

  function removeSplit(id: string) {
    setSplitForms((list) => list.filter((sp) => sp.id !== id));
  }

  function patchSplit(id: string, patch: Partial<InvoiceSplit>) {
    setSplitForms((list) => list.map((sp) => (sp.id === id ? { ...sp, ...patch } : sp)));
  }

  function patchSplitInvoiceData(id: string, patch: Partial<InvoiceData>) {
    setSplitForms((list) =>
      list.map((sp) => (sp.id === id ? { ...sp, invoiceData: { ...sp.invoiceData, ...patch } } : sp)),
    );
  }

  /** Distribute the booking price evenly; the last part absorbs the rounding. */
  function splitEvenly() {
    setSplitForms((list) => {
      if (list.length === 0) return list;
      const price = Math.round(reservation?.price ?? 0);
      const each = Math.round(price / list.length);
      return list.map((sp, i) => ({
        ...sp,
        amountCzk: i === list.length - 1 ? price - each * (list.length - 1) : each,
      }));
    });
  }

  /** Persist the parts without issuing them — the split equivalent of
   *  "Save details", so a half-filled set survives closing the drawer. */
  function handleSaveSplitDetails() {
    onUpdate({ ...reservation!, invoiceSplits: splitForms });
    setSaveDetailsSaved(true);
    setTimeout(() => setSaveDetailsSaved(false), 2500);
  }

  function handleGenerateSplitInvoices() {
    const updated = {
      ...reservation!,
      invoiceSplits: splitForms,
      invoiceStatus: "Issued" as const,
    };
    onUpdate(updated);
    setPreviewSplitId(splitForms[0]?.id ?? null);
    syncRevenueInvoices(updated);
  }

  /** Leave split mode: drops the parts and goes back to one invoice for the
   *  whole booking.
   *
   *  Also clears the revenue records, because nothing is issued any more. If it
   *  didn't, two split records would sit in the P&L counting the stay twice
   *  until someone happened to generate again. Reconciled records survive —
   *  the sync route refuses to strand a bank transaction. */
  function handleClearSplits() {
    const hadSplits = (reservation?.invoiceSplits ?? []).length > 0;
    setSplitMode(false);
    setSplitForms([]);
    setPreviewSplitId(null);
    if (hadSplits) {
      onUpdate({ ...reservation!, invoiceSplits: [], invoiceStatus: "Not Issued" as const });
      clearRevenueInvoices(reservation!);
    }
  }

  /** Drop every issued revenue record for this booking — nothing is issued. */
  async function clearRevenueInvoices(res: Reservation) {
    if (!res.includeQR) return;
    try {
      await fetch('/api/revenue-invoices/reservation-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationNumber: res.reservationNumber, invoices: [] }),
      });
    } catch { /* non-fatal */ }
  }

  async function handlePrintSplit(sp: InvoiceSplit) {
    const invoiceNumber = splitInvoiceNumber(reservation!.reservationNumber, sp.seq);
    const qrInfo = includePaymentQR
      ? buildPaymentQRInfo(reservation!.reservationNumber, sp.amountCzk, invoiceNumber)
      : undefined;
    await printInvoice(reservation!, sp.invoiceData, qrInfo, undefined, {
      invoiceNumber,
      amountOverride: sp.amountCzk,
      guestName: sp.guestName,
      shareNote: splitShareNote(
        reservation!.reservationNumber,
        sp.seq,
        (reservation!.invoiceSplits ?? []).length || 1,
      ),
    });
  }

  /** Send one part. Marks the booking Sent only once every part has gone out —
   *  a half-sent split is still the operator's to finish. */
  async function handleSendSplit(sp: InvoiceSplit) {
    setSendInvoiceError(null);
    setSendInvoiceDeferral(null);
    setIsSendingInvoice(true);
    setSendingSplitId(sp.id);
    try {
      const res = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR, split: sp }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      if (json.outcome === 'deferred') setSendInvoiceDeferral(json.deferral ?? 'Mail server deferred the message');

      const sentAt = new Date().toISOString();
      const splits = (reservation!.invoiceSplits ?? []).map((x) =>
        x.id === sp.id ? { ...x, sentAt, sentTo: json.sentTo ?? sp.invoiceData.billingEmail } : x,
      );
      const allSent = splits.length > 0 && splits.every((x) => x.sentAt);
      const updated: Reservation = {
        ...reservation!,
        invoiceSplits: splits,
        invoiceStatus: allSent ? "Sent" : "Issued",
      };
      onUpdate(updated);
      setSplitForms(splits);
      syncRevenueInvoices(updated);
    } catch (err) {
      setSendInvoiceError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setIsSendingInvoice(false);
      setSendingSplitId(null);
    }
  }

  async function handleSaveSplitToDrive(sp: InvoiceSplit) {
    setSavingSplitDriveId(sp.id);
    setSplitDriveErrors((prev) => ({ ...prev, [sp.id]: '' }));
    try {
      const res = await fetch('/api/transactions/invoice-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR, split: sp }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSplitDriveResults((prev) => ({ ...prev, [sp.id]: { url: json.driveUrl, name: json.driveFileName } }));
    } catch (err) {
      setSplitDriveErrors((prev) => ({
        ...prev,
        [sp.id]: err instanceof Error ? err.message : 'Failed to save to Drive',
      }));
    } finally {
      setSavingSplitDriveId(null);
    }
  }

  function handleGenerateInvoice() {
    const updated = {
      ...reservation!,
      invoiceData: invoiceForm,
      invoiceStatus: "Issued" as const,
    };
    onUpdate(updated);
    syncRevenueInvoices(updated);
  }

  async function handleSendInvoice() {
    setSendInvoiceError(null);
    setSendInvoiceDeferral(null);
    setIsSendingInvoice(true);
    try {
      const res = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      // outcome 'deferred' = the mail server took the message but deferred its
      // acknowledgement. It is NOT a failure (and must not be re-sent blindly),
      // so the invoice is marked Sent and the operator gets a warning instead.
      if (json.outcome === 'deferred') setSendInvoiceDeferral(json.deferral ?? 'Mail server deferred the message');
      const updated = { ...reservation!, invoiceStatus: "Sent" as const };
      onUpdate(updated);
      syncRevenueInvoices(updated);
    } catch (err) {
      setSendInvoiceError(err instanceof Error ? err.message : 'Failed to send invoice');
    } finally {
      setIsSendingInvoice(false);
    }
  }

  async function handleDownloadPDF() {
    if (reservation!.invoiceData) {
      const qrInfo = includePaymentQR
        ? buildPaymentQRInfo(reservation!.reservationNumber, reservation!.price)
        : undefined;
      await printInvoice(reservation!, reservation!.invoiceData, qrInfo);
    }
  }

  // Manual fallback for the case where the Stripe webhook didn't fire — asks
  // the server to query Stripe directly for every linked AdditionalPayment,
  // flips local state if Stripe says paid, and recomputes the override.
  async function callCheckPayment(extraBody: Record<string, unknown> = {}): Promise<void> {
    if (!reservation) return;
    setCheckStripeResult(null);
    try {
      const res = await fetch('/api/stripe/check-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reservationNumber: reservation.reservationNumber,
          checkInDate:       reservation.checkInDate,
          guestEmail:        reservation.additionalEmail || reservation.email || undefined,
          expectedAmount:    typeof reservation.price === 'number' ? reservation.price : undefined,
          ...extraBody,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setCheckStripeResult({
        kind: 'ok',
        status: data.status ?? null,
        updated: data.updated ?? 0,
        checked: data.checked ?? 0,
        message: data.message,
        webPayment: data.webPayment,
        manualLink: data.manualLink,
      });
      // Trigger reservation refresh so updated AdditionalPayments + override show through
      onPaymentCreated?.();
    } catch (err) {
      setCheckStripeResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to check Stripe',
      });
    } finally {
      // Auto-clear feedback after a few seconds (longer for web import — has more info)
      setTimeout(() => setCheckStripeResult(null), 8000);
    }
  }

  async function handleCheckStripe() {
    setCheckingStripe(true);
    try {
      await callCheckPayment();
    } finally {
      setCheckingStripe(false);
    }
  }

  async function handleManualLink() {
    const id = manualSessionId.trim();
    if (!id) return;
    setLinkingManually(true);
    try {
      await callCheckPayment({ sessionId: id });
      setManualSessionId('');
      setShowManualLink(false);
    } finally {
      setLinkingManually(false);
    }
  }

  // ── Invoice request banner — accept/reject pending detected requests ──────
  // On Accept: pre-fills invoiceData (only fields currently empty, so existing
  // operator entries aren't overwritten) + creates an Issue (category=invoice,
  // actionableDate=checkout). Marks request 'accepted' server-side.
  // On Reject: marks 'rejected' server-side so the banner stops showing.
  // Reservation merges happen client-side too — the next /api/invoice-requests
  // sync will re-attach the persisted state.
  async function processInvoiceRequest(
    requestId: string,
    action: 'accept' | 'reject',
  ) {
    if (!reservation) return;
    const request = (reservation.invoiceRequests ?? []).find((r) => r.id === requestId);
    if (!request) return;
    setProcessingInvoiceRequestId(requestId);

    // Build the updated reservation in one shot (single onUpdate call → single save)
    const updates: Partial<Reservation> = {
      invoiceRequests: (reservation.invoiceRequests ?? []).map((r) =>
        r.id === requestId
          ? { ...r, status: action === 'accept' ? 'accepted' : 'rejected', processedAt: new Date().toISOString() }
          : r,
      ),
    };

    if (action === 'accept') {
      const existing = reservation.invoiceData ?? {
        companyName: '',
        companyAddress: '',
        ico: '',
        vatNumber: '',
        billingEmail: '',
      };

      // Apply IČO/DIČ cross-fallback for already-stored requests (parser handles new ones,
      // but requests detected before the fix won't have both fields populated).
      const effectiveIco = request.ico || (request.dic ? request.dic.replace(/^(CZ|SK)/i, '') : '');
      const effectiveDic = request.dic || (request.ico ? `CZ${request.ico}` : '');

      // Email: use message email first, then fall back to drawer's additionalEmail
      const effectiveEmail = request.email || reservation.additionalEmail || '';

      // If the message contained an email and the drawer's additionalEmail is empty, populate it
      if (request.email && !reservation.additionalEmail) {
        updates.additionalEmail = request.email;
      }

      // Strip Booking.com's "[link removed]" artifact from stored company names
      const effectiveCompanyName = (request.companyName ?? '')
        .replace(/\[link removed\]/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();

      updates.invoiceData = {
        companyName: existing.companyName || effectiveCompanyName || '',
        companyAddress: existing.companyAddress,
        ico: existing.ico || effectiveIco,
        vatNumber: existing.vatNumber || effectiveDic,
        billingEmail: existing.billingEmail || effectiveEmail,
      };
      updates.issues = [
        ...(reservation.issues ?? []),
        {
          id: Date.now().toString(),
          category: 'invoice',
          text: effectiveCompanyName
            ? `Send invoice — ${effectiveCompanyName}${effectiveDic ? ` (DIČ ${effectiveDic})` : ''}`
            : 'Send invoice — guest requested via Booking.com',
          actionableDate: reservation.checkOutDate,
          resolved: false,
          createdAt: new Date().toISOString(),
        },
      ];
    }

    onUpdate({ ...reservation, ...updates });

    // Persist server-side (best-effort — local state is already optimistic).
    try {
      await fetch(`/api/invoice-requests/${encodeURIComponent(requestId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
    } catch (err) {
      console.error('[invoice-request]', err);
    } finally {
      setProcessingInvoiceRequestId(null);
    }
    onPaymentCreated?.();
  }

  // Open the preview modal first — operator confirms styling/data before
  // committing to send. Preview HTML is fetched lazily on open.
  async function handleOpenConfirmationPreview() {
    if (!reservation) return;
    setShowConfirmationPreview(true);
    setConfirmationPreviewHtml(null);
    setConfirmationPreviewError(null);
    try {
      const res = await fetch('/api/send-confirmation?preview=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const html = await res.text();
      setConfirmationPreviewHtml(html);
    } catch (err) {
      setConfirmationPreviewError(err instanceof Error ? err.message : 'Failed to load preview');
    }
  }

  // Actually send the email (called from the preview modal's Send button).
  async function handleSendConfirmation() {
    if (!reservation) return;
    setSendingConfirmation(true);
    setConfirmationResult(null);
    try {
      const res = await fetch('/api/send-confirmation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setConfirmationResult({ kind: 'ok', sentTo: data.sentTo ?? '' });
      setShowConfirmationPreview(false);
    } catch (err) {
      setConfirmationResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to send confirmation',
      });
    } finally {
      setSendingConfirmation(false);
      setTimeout(() => setConfirmationResult(null), 5000);
    }
  }

  async function handleSaveToDrive() {
    setDriveSaveError(null);
    setIsSavingToDrive(true);
    try {
      const res = await fetch('/api/transactions/invoice-to-drive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as { driveUrl: string; driveFileName: string };
      setDriveSaveResult({ url: data.driveUrl, name: data.driveFileName });
    } catch (err) {
      setDriveSaveError(err instanceof Error ? err.message : 'Failed to save to Drive');
    } finally {
      setIsSavingToDrive(false);
    }
  }

  const ALL_FLAGS: CustomerFlag[] = [
    "VIP Customer",
    "High Value Customer",
    "Repeat Customer",
    "Problematic Customer",
  ];

  const flagConfig: Record<
    CustomerFlag,
    { label: string; activeClass: string; inactiveClass: string }
  > = {
    "VIP Customer": {
      label: "👑 VIP Customer",
      activeClass: "bg-purple-600 text-white border-purple-600 ring-2 ring-purple-300",
      inactiveClass:
        "bg-white text-gray-500 border-gray-200 hover:border-purple-400 hover:text-purple-600",
    },
    "High Value Customer": {
      label: "★ High Value Customer",
      activeClass: "bg-yellow-500 text-white border-yellow-500",
      inactiveClass:
        "bg-white text-gray-500 border-gray-200 hover:border-yellow-400 hover:text-yellow-600",
    },
    "Repeat Customer": {
      label: "↩ Repeat Customer",
      activeClass: "bg-indigo-600 text-white border-indigo-600",
      inactiveClass:
        "bg-white text-gray-500 border-gray-200 hover:border-indigo-400 hover:text-indigo-600",
    },
    "Problematic Customer": {
      label: "⚠ Problematic Customer",
      activeClass: "bg-red-600 text-white border-red-600",
      inactiveClass:
        "bg-white text-gray-500 border-gray-200 hover:border-red-400 hover:text-red-600",
    },
  };

  const issuedSplits = reservation.invoiceSplits ?? [];
  const hasSplits = issuedSplits.length > 0;
  /** The part the preview + QR panel are showing; defaults to the first. */
  const activeSplit = issuedSplits.find((sp) => sp.id === previewSplitId) ?? issuedSplits[0];
  /** Bank details for whatever the panel is showing — a split pays its own
   *  share under its own variable symbol. */
  const activeSplitQR = buildPaymentQRInfo(
    reservation.reservationNumber,
    activeSplit ? activeSplit.amountCzk : reservation.price,
    activeSplit ? splitInvoiceNumber(reservation.reservationNumber, activeSplit.seq) : undefined,
  );

  const isOTAChannel = reservation.channel === "Booking.com" || reservation.channel === "Airbnb";
  const isDirectPhone = reservation.channel === "Direct-Phone";
  const isDirectWeb = reservation.channel === "Direct-Web";
  // Rate plan applies to OTA + Direct-Web stays that are current/future or booked
  // since launch, or whenever a rate is already known (detected or manually set).
  const showRatePlan =
    (isOTAChannel || isDirectWeb) &&
    (isRateTypeInScope(reservation, new Date().toLocaleDateString("sv-SE")) ||
      !!effectiveRateType(reservation));
  const nationalityFlag = countryCodeToFlag(reservation.nationality);
  const nationalityName = countryCodeToName(reservation.nationality);

  // ── Blackout-specific drawer view — completely different UI: no payment,
  //    no invoice, no guest, no messaging, no cleaning, no flags. Just the
  //    room/dates/reason/creator + a delete button.
  if (reservation.isBlackout) {
    return (
      <BlackoutDrawerView
        reservation={reservation}
        isMounted={isMounted}
        onClose={onClose}
        onDeleted={() => {
          onPaymentCreated?.(); // re-uses the existing refresh callback
          onClose();
        }}
      />
    );
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Drawer */}
      <div
        className={`fixed top-0 right-0 h-full w-full sm:w-[480px] bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ${
          isMounted ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Save-status toast — fixed pill at top centre, fades automatically.
            Driven by TransactionsPage.persistOverride lifecycle so any onUpdate
            write surfaces feedback, no per-button instrumentation needed. */}
        {saveStatus !== 'idle' && (
          <div className="absolute top-2 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
            {saveStatus === 'saving' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-gray-800/90 text-white text-[11px] font-medium shadow-md">
                <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                Saving…
              </span>
            )}
            {saveStatus === 'saved' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-600 text-white text-[11px] font-medium shadow-md">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
                Saved
              </span>
            )}
            {saveStatus === 'error' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-red-600 text-white text-[11px] font-medium shadow-md">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                Save failed — retry
              </span>
            )}
          </div>
        )}
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200 shrink-0">
          <div>
            <p className="font-semibold text-gray-900">
              {nationalityFlag && (
                <span className="mr-1.5" title={nationalityName}>
                  {nationalityFlag}
                </span>
              )}
              {reservation.firstName} {reservation.lastName}
              {ratingSmiley(reservation) && (
                <span className="ml-1.5">{ratingSmiley(reservation)}</span>
              )}
            </p>
            <ReservationIdCopy value={reservation.reservationNumber} />
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

          {/* Auto-detected invoice requests from the guest's Booking.com message.
              Shows only `pending` rows; once accepted/rejected they vanish. */}
          {(reservation.invoiceRequests ?? [])
            .filter((r) => r.status === 'pending')
            .map((req) => {
              // Compute the same effective values the accept handler will store —
              // so the banner always shows exactly what will land in the reservation.
              const displayCompany = (req.companyName ?? '')
                .replace(/\[link removed\]/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim();
              const displayIco = req.ico || (req.dic ? req.dic.replace(/^(CZ|SK)/i, '') : '');
              const displayDic = req.dic || (req.ico ? `CZ${req.ico}` : '');
              const displayEmail = req.email || reservation.additionalEmail || '';
              return (
              <div
                key={req.id}
                className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 space-y-2.5"
              >
                <div className="flex items-start gap-2">
                  <svg className="w-4 h-4 mt-0.5 text-amber-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-amber-900 uppercase tracking-wide">
                      Invoice request detected
                    </p>
                    <p className="text-[10px] text-amber-700 mt-0.5">
                      Auto-parsed from guest message · review before accepting
                    </p>
                  </div>
                </div>

                {/* Parsed fields — show exactly what will be stored on Accept */}
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  <div>
                    <span className="text-amber-700 text-[10px] block">Company</span>
                    <span className="text-amber-950 font-medium truncate block">
                      {displayCompany || <span className="italic text-amber-400">not detected</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-amber-700 text-[10px] block">DIČ / Tax ID</span>
                    <span className="text-amber-950 font-mono">
                      {displayDic || <span className="italic text-amber-400 font-sans">not detected</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-amber-700 text-[10px] block">IČO</span>
                    <span className="text-amber-950 font-mono">
                      {displayIco || <span className="italic text-amber-400 font-sans">not detected</span>}
                    </span>
                  </div>
                  <div>
                    <span className="text-amber-700 text-[10px] block">Email</span>
                    <span className="text-amber-950 break-all">
                      {displayEmail || <span className="italic text-amber-400">not detected</span>}
                    </span>
                  </div>
                </div>

                {/* Original message (collapsed by default; clickable to expand) */}
                <details className="text-[11px] text-amber-700">
                  <summary className="cursor-pointer hover:text-amber-900">View original message</summary>
                  <p className="mt-1.5 p-2 bg-white/60 rounded border border-amber-200 text-amber-900 whitespace-pre-wrap">
                    {req.rawMessage}
                  </p>
                </details>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    onClick={() => processInvoiceRequest(req.id, 'accept')}
                    disabled={processingInvoiceRequestId === req.id}
                    className="px-3 py-1 text-[11px] font-semibold rounded bg-amber-600 text-white hover:bg-amber-700 transition-colors disabled:opacity-60 disabled:cursor-wait"
                    title="Pre-fill invoice details and create a Send-Invoice task for checkout"
                  >
                    {processingInvoiceRequestId === req.id ? '…' : 'Accept'}
                  </button>
                  <button
                    onClick={() => processInvoiceRequest(req.id, 'reject')}
                    disabled={processingInvoiceRequestId === req.id}
                    className="px-3 py-1 text-[11px] font-medium rounded border border-amber-300 text-amber-800 hover:bg-amber-100 transition-colors disabled:opacity-60 disabled:cursor-wait"
                    title="Dismiss — guest didn't actually want an invoice"
                  >
                    {processingInvoiceRequestId === req.id ? '…' : 'Reject'}
                  </button>
                  <span className="text-[10px] text-amber-600 ml-auto">
                    Detected {req.detectedAt.slice(0, 10)}
                  </span>
                </div>
              </div>
              );
            })}

          {/* ── 1. Reservation — the stay, the guest, and the two operational
               facts that belong to it (cleaning + parking). Always open: this is
               what the operator needs before anything else. ── */}
          <DrawerSection title="Reservation" icon={SECTION_ICON.reservation} source="Beds24">
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="Room" value={reservation.room} />
              <ReadOnlyField label="Channel" value={reservation.channel} />
              <ReadOnlyField label="Check-in" value={formatDate(reservation.checkInDate)} />
              <ReadOnlyField label="Check-out" value={formatDate(reservation.checkOutDate)} />
              <ReadOnlyField label="Nights" value={String(reservation.numberOfNights)} />
              <ReadOnlyField label="Reservation Date" value={formatDate(reservation.reservationDate)} />
            </div>

            {/* Manual room move — maintenance / ad-hoc. Hidden for multi-room
                packages (those must be handled in Beds24). */}
            {(reservation.linkedRooms?.length ?? 0) <= 1 && (
              <button
                onClick={() => {
                  setMoveTargetRoom("");
                  setMoveError(null);
                  setMoveDone(false);
                  setMoveIgnoreOccupied(false);
                  setShowMoveModal(true);
                }}
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-gray-200 text-xs font-medium text-gray-600 hover:bg-gray-50 transition-colors"
                title="Reassign this reservation to a different room"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m4 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
                Move to another room
              </button>
            )}

            {/* Send Reservation Confirmation — emails a styled summary from
                reservations@bakerhouseapartments.cz to the best email on file. */}
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <button
                onClick={handleOpenConfirmationPreview}
                disabled={sendingConfirmation}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 border border-amber-200 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors disabled:opacity-50"
                title="Preview a styled reservation confirmation email, then send"
              >
                {sendingConfirmation ? (
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                  </svg>
                ) : (
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                )}
                {sendingConfirmation ? 'Sending…' : 'Send Reservation Confirmation'}
              </button>
              {confirmationResult && (
                <span
                  className={`text-[11px] px-2 py-1 rounded ${
                    confirmationResult.kind === 'error'
                      ? 'text-red-700 bg-red-50 border border-red-200'
                      : 'text-green-700 bg-green-50 border border-green-200'
                  }`}
                >
                  {confirmationResult.kind === 'error'
                    ? confirmationResult.message
                    : `Sent to ${confirmationResult.sentTo}`}
                </span>
              )}
            </div>
            <hr className="border-gray-100 my-4" />
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="First Name" value={reservation.firstName} />
              <ReadOnlyField label="Last Name" value={reservation.lastName} />
              {/* Email — OTA conduit address with truncation + copy + additional email */}
              <div className="col-span-2">
                <p className="text-[11px] text-gray-400 mb-0.5">Email (channel)</p>
                <div className="flex items-center gap-1.5">
                  <p className="text-sm text-gray-800 truncate max-w-[220px]" title={reservation.email}>
                    {reservation.email || "—"}
                  </p>
                  {reservation.email && (
                    <button
                      onClick={() => navigator.clipboard.writeText(reservation.email)}
                      title="Copy email"
                      className="shrink-0 text-gray-400 hover:text-gray-600"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              {/* Additional guest email */}
              <div className="col-span-2">
                {reservation.additionalEmail ? (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Guest Email</p>
                    <div className="flex items-center gap-1.5">
                      <p className="text-sm text-gray-800 truncate max-w-[220px]" title={reservation.additionalEmail}>
                        {reservation.additionalEmail}
                      </p>
                      <button
                        onClick={() => navigator.clipboard.writeText(reservation.additionalEmail)}
                        title="Copy guest email"
                        className="shrink-0 text-gray-400 hover:text-gray-600"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                      </button>
                      <button
                        onClick={() => onUpdate({ ...reservation, additionalEmail: "" })}
                        title="Remove guest email"
                        className="shrink-0 text-gray-300 hover:text-red-400"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  </div>
                ) : (
                  <GuestEmailInput
                    onSave={(email) => onUpdate({ ...reservation, additionalEmail: email })}
                  />
                )}
              </div>
              <PhoneEditField
                value={reservation.phone}
                onSave={(phone) => onUpdate({ ...reservation, phone })}
              />
              <ReadOnlyField label="Guests" value={String(reservation.numberOfGuests)} />
              {reservation.nationality && (
                <ReadOnlyField
                  label="Nationality"
                  value={`${nationalityFlag} ${nationalityName}`}
                />
              )}
            </div>
            <hr className="border-gray-100 my-4" />
            <SubTitle source="Cleaning App">Cleaning</SubTitle>
            <div>
              <p className="text-[11px] text-gray-400 mb-1">Status</p>
              <Badge
                variant={
                  reservation.cleaningStatus === "Completed"
                    ? "green"
                    : reservation.cleaningStatus === "In Progress"
                      ? "blue"
                      : "amber"
                }
              >
                {reservation.cleaningStatus}
              </Badge>
            </div>
            <hr className="border-gray-100 my-4" />
            <SubTitle>Parking</SubTitle>
            <div className="space-y-2">
              {/* Current assignment */}
              {myParking ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-700">
                    Space <span className="font-semibold">{myParking.space}</span>
                  </span>
                  <Badge variant={myParking.type === "auto" ? "blue" : "purple"}>
                    {myParking.type}
                  </Badge>
                  {myParking.conflict && (
                    <Badge variant="amber">conflict</Badge>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-400">No parking assigned</p>
              )}

              {/* Conflict warning */}
              {myParking?.conflict && (
                <div className="flex items-start gap-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg">
                  <svg className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                  <p className="text-xs text-amber-700">{myParking.conflict}</p>
                </div>
              )}

              {/* Dropdown */}
              <select
                value={
                  reservation.parkingOverride === undefined
                    ? "__auto__"
                    : reservation.parkingOverride === "none"
                      ? "__none__"
                      : reservation.parkingOverride
                }
                onChange={(e) => {
                  const val = e.target.value;
                  const override =
                    val === "__auto__" ? undefined :
                    val === "__none__" ? "none" :
                    val;
                  // Build a clean update — remove key entirely for undefined
                  const updated = { ...reservation! };
                  if (override === undefined) {
                    delete updated.parkingOverride;
                  } else {
                    updated.parkingOverride = override;
                  }
                  onUpdate(updated);
                }}
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
              >
                <option value="__auto__">Auto (room rules)</option>
                <option value="__none__">No parking</option>
                {/* Show currently assigned space if it's manual and not in free list */}
                {reservation.parkingOverride &&
                  reservation.parkingOverride !== "none" &&
                  !freeSpaces.includes(reservation.parkingOverride) && (
                    <option value={reservation.parkingOverride}>
                      Space {reservation.parkingOverride} (current)
                    </option>
                  )}
                {freeSpaces.map((space) => {
                  const ps = PARKING_SPACES.find((p) => p.space === space);
                  const label = ps?.permanentRoom
                    ? `Space ${space} (${ps.permanentRoom})`
                    : `Space ${space} (hot)`;
                  return (
                    <option key={space} value={space}>{label}</option>
                  );
                })}
              </select>
            </div>
          </DrawerSection>

          <hr className="border-gray-100" />

          {/* ── 2. Messaging ── */}
          <DrawerSection title="Messaging" icon={SECTION_ICON.messaging} source="Beds24">
            <div className="flex items-center justify-end mb-2 flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {/* Email Guest pill — only when a usable email is on file.
                    The send log appears as a small line under the pill (see the
                    section below the messaging section). */}
                {(reservation.additionalEmail
                  || reservation.invoiceData?.billingEmail
                  || reservation.email) && (
                  <button
                    onClick={() => setShowEmailGuestModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold transition-colors"
                    title={`Send a templated email to ${reservation.firstName}`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    Email Guest
                  </button>
                )}
                {/* WhatsApp Guest pill — opens the template/voucher modal
                    with a rendered message pre-filled. Use this when you
                    want a structured outbound (thank-you + voucher etc.).
                    Available on every channel (Booking, Airbnb, Direct,
                    Direct-Phone, Direct-Web) — only requires a phone. */}
                {reservation.phone && (
                  <button
                    onClick={() => setShowWhatsAppGuestModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-xs font-semibold transition-colors"
                    title={`Send a templated WhatsApp message to ${reservation.firstName}`}
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                    WhatsApp Guest
                  </button>
                )}
                {/* SMS Guest pill — sends a real one-way SMS via Twilio
                    ("BakerHouse" sender), delivered from the app (no handoff).
                    Only requires a phone. */}
                {reservation.phone && (
                  <button
                    onClick={() => setShowSmsGuestModal(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors"
                    title={`Send a templated SMS to ${reservation.firstName}`}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 3v-3z" />
                    </svg>
                    SMS Guest
                  </button>
                )}
                {/* WhatsApp Chat — bypasses the template modal entirely.
                    Opens wa.me with the guest's phone number and NO
                    pre-filled text, so the operator can type a freeform
                    message inside WhatsApp directly. Use this for any
                    ad-hoc conversation; the templated pill above is for
                    structured outbound (thank-you + voucher etc.). */}
                {reservation.phone && (
                  <button
                    onClick={() => {
                      const num = (reservation.phone ?? '').replace(/\D/g, '');
                      if (!num) return;
                      window.open(`https://wa.me/${num}`, '_blank');
                    }}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-green-500 text-green-600 hover:bg-green-50 text-xs font-semibold transition-colors"
                    title={`Open WhatsApp chat with ${reservation.firstName} — no template, freeform message`}
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                    Open chat
                  </button>
                )}
              </div>
            </div>

            {/* Guest-message send log — appears as a discreet line under
                the pill row. Shows every Email Guest / WhatsApp Guest
                dispatch for this reservation with template + timestamp +
                channel + recipient + sender. Newest first. */}
            {(reservation.emailSendLog ?? []).length > 0 && (
              <div className="mb-3 -mt-1 space-y-0.5">
                {(reservation.emailSendLog ?? []).map((entry) => {
                  // Old log entries pre-date the channel field — treat as email.
                  const channelIcon =
                    entry.channel === 'whatsapp' ? '💬' : entry.channel === 'sms' ? '📱' : '✉️';
                  const channelLabel =
                    entry.channel === 'whatsapp' ? 'WhatsApp' : entry.channel === 'sms' ? 'SMS' : 'Email';
                  return (
                    <div
                      key={entry.id}
                      className="text-[10.5px] text-gray-500 flex items-center gap-1.5"
                      title={`${channelLabel} sent by ${entry.sentBy} to ${entry.to}${entry.subject ? ` · Subject: "${entry.subject}"` : ''}`}
                    >
                      <span aria-hidden className="text-[11px] leading-none">{channelIcon}</span>
                      <span className="font-medium text-gray-700">{entry.templateLabel}</span>
                      <span className="text-gray-400">sent via {channelLabel.toLowerCase()}</span>
                      <span>
                        {new Date(entry.sentAt).toLocaleDateString('en-GB', {
                          day: '2-digit', month: 'short', year: 'numeric',
                        })}
                        {', '}
                        {new Date(entry.sentAt).toLocaleTimeString('en-GB', {
                          hour: '2-digit', minute: '2-digit',
                        })}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {isOTAChannel ? (
              <MessageThread
                beds24Id={parseInt(reservation.reservationNumber.slice(3))}
                hasUnread={unreadBookingIds.has(parseInt(reservation.reservationNumber.slice(3)))}
                guestName={`${reservation.firstName} ${reservation.lastName}`}
                room={reservation.room}
                guestFirstName={reservation.firstName}
              />
            ) : (
              <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded px-3 py-2.5">
                In-app messaging is only available for Booking.com and Airbnb reservations.
                Use WhatsApp{reservation.phone ? "" : " (add a phone number above)"} or email to contact this guest directly.
              </p>
            )}
          </DrawerSection>

          <hr className="border-gray-100" />

          {/* ── 3. Payment — money in, money back, and the vouchers attached to
               it. Collapsed: on a paid booking there is nothing to do here, and
               the summary chip carries the one fact that matters. ── */}
          <DrawerSection
            title="Payment"
            icon={SECTION_ICON.payment}
            source={isOTAChannel ? reservation.channel : isDirectPhone ? "Direct" : "Stripe"}
            sourceColor={getChannelColor(reservation.channel)}
            defaultOpen={false}
            summary={(() => {
              // Money collected is good news, so the folded summary says so in
              // green; anything short of Paid stays amber so it reads as open.
              const st = reservation.paymentStatusOverride ?? reservation.paymentStatus;
              const good = st === "Paid";
              return (
                <span
                  className={`text-[11px] font-semibold ${good ? "text-emerald-600" : "text-amber-600"}`}
                >
                  {st}
                  <span className="text-gray-300 font-normal"> · </span>
                  {formatCurrency(reservation.price)}
                </span>
              );
            })()}
          >
            {isOTAChannel ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3 flex-wrap">
                  <PaymentStatusControl
                    derived={reservation.paymentStatus}
                    override={reservation.paymentStatusOverride}
                    onOverride={(v) => onUpdate({ ...reservation, paymentStatusOverride: v })}
                  />
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1">Total</p>
                    <PaymentBreakdown reservation={reservation} />
                  </div>
                  {showRatePlan && (
                    <RateTypeControl
                      detected={reservation.rateType}
                      override={reservation.rateTypeOverride ?? null}
                      onOverride={(v) => onUpdate({ ...reservation, rateTypeOverride: v })}
                    />
                  )}
                </div>
                {showRatePlan && (
                  <PerksControl
                    rate={reservation.rateTypeOverride ?? reservation.rateType ?? null}
                    reservationDate={reservation.reservationDate}
                    override={reservation.perkOverrides}
                    onOverride={(v) => onUpdate({ ...reservation, perkOverrides: v })}
                  />
                )}
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2.5 py-1.5">
                  Paid through {reservation.channel} — collected by channel.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3">
                  <PaymentStatusControl
                    derived={reservation.paymentStatus}
                    override={reservation.paymentStatusOverride}
                    onOverride={(v) => onUpdate({ ...reservation, paymentStatusOverride: v })}
                  />
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Total Price</p>
                    <PaymentBreakdown reservation={reservation} />
                  </div>
                  <ReadOnlyField label="Amount Paid" value={formatCurrency(reservation.amountPaid)} />
                </div>
                {showRatePlan && (
                  <RateTypeControl
                    detected={reservation.rateType}
                    override={reservation.rateTypeOverride ?? null}
                    onOverride={(v) => onUpdate({ ...reservation, rateTypeOverride: v })}
                  />
                )}
                {reservation.paymentStatus === "Partially Paid" && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                    Outstanding balance: {formatCurrency(reservation.price - reservation.amountPaid)}
                  </p>
                )}
              </div>
            )}

            {/* Partially refunded — the operator handed money back on a booking
                that still stands. Nothing about this reaches the channel: it
                keeps charging commission on the original price and never pushes
                the reduction to Beds24, so the amount is only ever recorded
                here. It comes off gross booking value, leaving the channel's fee
                where it was — a higher effective rate on a smaller sale. Hidden
                for non-arrivals, whose net-retained price already nets one off. */}
            {!reservation.nonArrival && (
              <div className="mt-2">
                {reservation.platformRefund ? (
                  <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-800">
                        ↩︎ Partially refunded
                      </span>
                      {canEditNonArrival && (
                        <button
                          onClick={clearPlatformRefund}
                          className="text-[11px] text-amber-600 hover:underline"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-amber-600 mt-0.5">
                      Comes off gross revenue. {reservation.channel} keeps its fee on the full{" "}
                      {formatCurrency(reservation.platformRefund.originalPriceCzk)} it billed.
                    </p>
                    <div className="mt-2 flex items-end gap-3 flex-wrap">
                      <label className="text-[11px] text-amber-700">
                        Refunded (Kč)
                        <input
                          type="number"
                          min={0}
                          step={1}
                          defaultValue={reservation.platformRefund.amountCzk}
                          onBlur={(e) => setPlatformRefund({ amountCzk: Number(e.target.value) })}
                          disabled={!canEditNonArrival}
                          className="block w-32 mt-0.5 border border-amber-200 rounded px-2 py-1 text-sm text-amber-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60"
                        />
                      </label>
                      <label className="text-[11px] text-amber-700">
                        Refunded on
                        <input
                          type="date"
                          defaultValue={reservation.platformRefund.refundedAt}
                          onBlur={(e) => setPlatformRefund({ refundedAt: e.target.value })}
                          disabled={!canEditNonArrival}
                          className="block mt-0.5 border border-amber-200 rounded px-2 py-1 text-sm text-amber-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60"
                        />
                      </label>
                      <label className="text-[11px] text-amber-700 flex-1 min-w-[10rem]">
                        Reason
                        <input
                          type="text"
                          placeholder="e.g. goodwill after complaint"
                          defaultValue={reservation.platformRefund.reason ?? ""}
                          onBlur={(e) => setPlatformRefund({ reason: e.target.value })}
                          disabled={!canEditNonArrival}
                          className="block w-full mt-0.5 border border-amber-200 rounded px-2 py-1 text-sm text-amber-900 bg-white focus:outline-none focus:ring-2 focus:ring-amber-400 disabled:opacity-60"
                        />
                      </label>
                    </div>
                    {reservation.platformRefund.originalPriceCzk !== reservation.price && (
                      <p className="text-[11px] text-amber-700 mt-1.5">
                        ⚠ Price was {formatCurrency(reservation.platformRefund.originalPriceCzk)} when this was
                        recorded, now {formatCurrency(reservation.price)} — the refund is pro-rated to match.
                      </p>
                    )}
                  </div>
                ) : canEditNonArrival ? (
                  <button
                    onClick={() => setPlatformRefund({ amountCzk: 0 })}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 border border-amber-200 rounded-lg hover:bg-amber-50 transition-colors"
                    title="Money handed back to the guest on a booking that still stands — gross revenue drops, the channel keeps its fee on the full price"
                  >
                    ↩︎ Mark partially refunded
                  </button>
                ) : null}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap mt-2">
              <button
                onClick={() => setShowPaymentModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-indigo-700 border border-indigo-200 rounded-lg hover:bg-indigo-50 transition-colors w-fit"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
                Request Payment
              </button>

              {/* Manual Stripe re-check — fallback when webhook didn't fire.
                  Shown for any reservation likely paid via Stripe: linked
                  payment links, Direct-Web (rental site), or generic "Direct"
                  (legacy bookings — channel mapping falls back to "Direct"
                  when Beds24 referer doesn't contain "web"/"phone"). */}
              {((reservation.additionalPayments ?? []).length > 0 ||
                reservation.channel === 'Direct-Web' ||
                reservation.channel === 'Direct') && (
                <>
                  <button
                    onClick={handleCheckStripe}
                    disabled={checkingStripe}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors w-fit disabled:opacity-50"
                    title="Auto-match a Stripe payment by reservation/email/amount/check-in"
                  >
                    {checkingStripe ? (
                      <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    {checkingStripe ? 'Checking…' : 'Check Stripe'}
                  </button>
                  <button
                    onClick={() => setShowManualLink((v) => !v)}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded-lg transition-colors w-fit"
                    title="Paste a Stripe payment ID (pi_… or cs_…) to import the payment manually"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                    </svg>
                    Link by ID
                  </button>
                </>
              )}
            </div>

            {/* Manual session-ID linking — disclosure panel under the buttons */}
            {showManualLink && (
              <div className="mt-2 p-3 border border-gray-200 rounded-lg bg-gray-50 space-y-2">
                <p className="text-[11px] text-gray-500">
                  Paste a Stripe ID — either <code className="text-gray-700">pi_…</code> (PaymentIntent, shown on the payment&apos;s detail page in the Stripe dashboard) or <code className="text-gray-700">cs_…</code> (Checkout Session).
                </p>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={manualSessionId}
                    onChange={(e) => setManualSessionId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && manualSessionId.trim()) handleManualLink(); }}
                    placeholder="pi_… or cs_…"
                    className="flex-1 px-2.5 py-1.5 text-xs font-mono border border-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-300"
                    autoFocus
                  />
                  <button
                    onClick={handleManualLink}
                    disabled={!manualSessionId.trim() || linkingManually}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-indigo-600 rounded-md hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {linkingManually ? '…' : 'Link'}
                  </button>
                  <button
                    onClick={() => { setShowManualLink(false); setManualSessionId(''); }}
                    className="px-2 py-1.5 text-xs text-gray-500 hover:text-gray-700"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {/* Check-Stripe result feedback */}
            {checkStripeResult && (
              <div
                className={`text-[11px] mt-1 px-2 py-1.5 rounded ${
                  checkStripeResult.kind === 'error'
                    ? 'text-red-700 bg-red-50 border border-red-200'
                    : checkStripeResult.kind === 'ok' && checkStripeResult.webPayment
                      ? 'text-green-700 bg-green-50 border border-green-200'
                      : checkStripeResult.kind === 'ok' && checkStripeResult.updated > 0
                        ? 'text-green-700 bg-green-50 border border-green-200'
                        : 'text-gray-500 bg-gray-50 border border-gray-200'
                }`}
              >
                {checkStripeResult.kind === 'error'
                  ? checkStripeResult.message
                  : checkStripeResult.webPayment
                    ? <>
                        ✓ Web payment imported · {checkStripeResult.webPayment.amountCzk.toLocaleString('cs-CZ')} Kč
                        {' · '}paid {checkStripeResult.webPayment.paidAt.slice(0, 10)}
                        {checkStripeResult.webPayment.stripeFeeCzk !== undefined
                          ? ` · fee ${checkStripeResult.webPayment.stripeFeeCzk.toFixed(2)} Kč`
                          : ' · fee pending'}
                        {checkStripeResult.webPayment.guestEmail ? ` · ${checkStripeResult.webPayment.guestEmail}` : ''}
                      </>
                    : checkStripeResult.updated > 0
                      ? `Updated ${checkStripeResult.updated} payment${checkStripeResult.updated > 1 ? 's' : ''}${checkStripeResult.status ? ` · status now ${checkStripeResult.status}` : ''}`
                      : checkStripeResult.message
                        ? checkStripeResult.message
                        : checkStripeResult.checked > 0
                          ? `Checked ${checkStripeResult.checked} — already in sync${checkStripeResult.status ? ` (${checkStripeResult.status})` : ''}`
                          : 'No linked Stripe payments to check'}
              </div>
            )}

            {/* Main Payments (booking payments created via Stripe link) */}
            {(reservation.additionalPayments ?? []).some((ap) => ap.isMainPayment) && (
              <div className="mt-3 border border-indigo-100 rounded-lg overflow-hidden">
                <p className="text-[11px] font-medium text-indigo-600 uppercase tracking-wide px-3 py-2 bg-indigo-50 border-b border-indigo-100">
                  Booking Payment
                </p>
                <div className="divide-y divide-gray-100">
                  {(reservation.additionalPayments ?? [])
                    .filter((ap) => ap.isMainPayment)
                    .map((ap) => (
                      <AdditionalPaymentRow
                        key={ap.id}
                        ap={ap}
                        guestPhone={reservation.phone}
                        guestName={`${reservation.firstName} ${reservation.lastName}`.trim()}
                        onRefresh={onPaymentCreated}
                      />
                    ))}
                </div>
              </div>
            )}

            {/* Additional Payments sub-list (sent links — paid + pending) */}
            {(reservation.additionalPayments ?? []).some((ap) => !ap.isMainPayment) && (
              <div className="mt-3 border border-gray-100 rounded-lg overflow-hidden">
                <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide px-3 py-2 bg-gray-50 border-b border-gray-100">
                  Additional Payments
                </p>
                <div className="divide-y divide-gray-100">
                  {(reservation.additionalPayments ?? []).filter((ap) => !ap.isMainPayment).map((ap) => (
                    <AdditionalPaymentRow
                      key={ap.id}
                      ap={ap}
                      guestPhone={reservation.phone}
                      guestName={`${reservation.firstName} ${reservation.lastName}`.trim() || undefined}
                      onRefresh={onPaymentCreated}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Upcoming scheduled split-payments (cron will email the link on sendDate) */}
            {(reservation.splitPayments ?? []).filter((sp) => sp.status === 'scheduled').length > 0 && (
              <div className="mt-3 border border-blue-100 rounded-lg overflow-hidden">
                <p className="text-[11px] font-medium text-blue-700 uppercase tracking-wide px-3 py-2 bg-blue-50 border-b border-blue-100">
                  Upcoming
                </p>
                <div className="divide-y divide-blue-50">
                  {(reservation.splitPayments ?? [])
                    .filter((sp) => sp.status === 'scheduled')
                    .sort((a, b) => a.paymentNumber - b.paymentNumber)
                    .map((sp) => (
                      <ScheduledSplitPaymentRow key={sp.id} sp={sp} />
                    ))}
                </div>
              </div>
            )}
            <hr className="border-gray-100 my-4" />
            <SubTitle>Vouchers</SubTitle>

            <button
              onClick={() => setShowVoucherModal(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 border border-purple-200 rounded-lg hover:bg-purple-50 transition-colors w-fit"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A2 2 0 013 12V7a4 4 0 014-4z" />
              </svg>
              Create Voucher
            </button>

            {/* Voucher list */}
            {(reservation.vouchers ?? []).length > 0 && (
              <div className="mt-3 border border-gray-100 rounded-lg overflow-hidden">
                <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide px-3 py-2 bg-gray-50 border-b border-gray-100">
                  Vouchers
                </p>
                <div className="divide-y divide-gray-100">
                  {(reservation.vouchers ?? []).map((v) => (
                    <VoucherRow
                      key={v.id}
                      voucher={v}
                      reservationNumber={reservation.reservationNumber}
                      onRefresh={onPaymentCreated}
                    />
                  ))}
                </div>
              </div>
            )}
          </DrawerSection>

          <hr className="border-gray-100" />

          {/* ── 4. Cancellation — promoted out of Payment: the policy is a
               property of the booking, not of how it was paid. ── */}
          <DrawerSection
            title="Cancellation"
            icon={SECTION_ICON.cancellation}
            defaultOpen={false}
            summary={(() => {
              // The booked rate determines the terms, so it's the one fact worth
              // carrying through the fold.
              const rt = effectiveRateType(reservation);
              return rt ? <span className={rateChipClasses(rt)}>{RATE_TYPE_SHORT[rt]}</span> : null;
            })()}
          >
            <CancellationPolicyPanel reservation={reservation} />
          </DrawerSection>

          <hr className="border-gray-100" />

          {/* ── 5. Reservation Management — the drawer's action centre, and the
               reason it stays open. Two task lists split by who acts:
               OPERATIONS is room-level work (the cleaner-facing ones reach the
               cleaning app), ADMIN falls on the operator and carries the booking
               actions that belong with it. Guest record follows underneath. ── */}
          <DrawerSection title="Reservation Management" icon={SECTION_ICON.management}>
            <TaskKindHeader kind="ops" />
            <TaskBlock
              key={`ops-${reservation.reservationNumber}`}
              kind="ops"
              reservation={reservation}
              onAdd={addIssue}
              onToggleResolved={toggleIssueResolved}
              onDelete={deleteIssue}
            />

            <hr className="border-gray-100 my-4" />
            <TaskKindHeader kind="admin" />
            {/* Non-arrival — guest can't come and can't cancel on the OTA. Marking
                it cancels + channel-locks the booking in Beds24 (frees the room to
                resell) while the guest stays charged on the OTA; revenue counts the
                net retained after any channel-side refund, set below. */}
            <div className="mt-3">
              {reservation.nonArrival ? (
                <div className="rounded-lg border border-purple-300 bg-purple-50 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 text-sm font-medium text-purple-800">
                      🚨 Non-arrival
                    </span>
                    {canEditNonArrival && (
                      <button
                        onClick={unmarkNonArrival}
                        className="text-[11px] text-purple-600 hover:underline"
                      >
                        Remove flag
                      </button>
                    )}
                  </div>
                  <p className="text-[11px] text-purple-600 mt-0.5">
                    Cancelled &amp; channel-locked in Beds24; guest still charged via {reservation.channel}.
                  </p>
                  <div className="mt-2 flex items-end gap-3 flex-wrap">
                    <label className="text-[11px] text-purple-700">
                      Net retained (Kč)
                      <input
                        type="number"
                        min={0}
                        step={1}
                        defaultValue={reservation.nonArrivalNetPriceCzk ?? reservation.nonArrival.originalPriceCzk}
                        onBlur={(e) => setNonArrivalNet(Number(e.target.value))}
                        disabled={!canEditNonArrival}
                        className="block w-32 mt-0.5 border border-purple-200 rounded px-2 py-1 text-sm text-purple-900 bg-white focus:outline-none focus:ring-2 focus:ring-purple-400 disabled:opacity-60"
                      />
                    </label>
                    <span className="text-[11px] text-purple-500 pb-1.5">
                      Original {formatCurrency(reservation.nonArrival.originalPriceCzk)}
                    </span>
                  </div>
                </div>
              ) : canEditNonArrival ? (
                <button
                  onClick={markNonArrival}
                  disabled={naBusy}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 border border-purple-200 rounded-lg hover:bg-purple-50 transition-colors disabled:opacity-50"
                  title="Guest can't come and can't cancel on the OTA — cancel + lock in Beds24 to free the room for resale while still charging"
                >
                  🚨 {naBusy ? "Marking…" : "Mark as non-arrival"}
                </button>
              ) : null}
            </div>

            {/* Shorten stay — the guest still comes but drops a night and wants
                that night's money back. Moves the dates in Beds24 (freeing the
                trimmed nights for resale straight away) and leaves the price
                alone: the refund is whatever was agreed, entered by hand in
                Beds24 afterwards. Not offered on non-arrivals or cancellations
                — those nights are already free. */}
            {!reservation.nonArrival && !reservation.isCancelled && !reservation.isBlackout && (
              <div className="mt-2">
                {reservation.stayShortened && (
                  <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2.5 mb-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="inline-flex items-center gap-1.5 text-sm font-medium text-sky-800">
                        ✂️ Stay shortened by {nightsLabel(reservation.stayShortened.nightsRemoved)}
                      </span>
                      {canEditNonArrival && (
                        <button
                          onClick={clearShortening}
                          className="text-[11px] text-sky-600 hover:underline"
                          title="Removes this record only — the dates stay as they are in Beds24"
                        >
                          Clear record
                        </button>
                      )}
                    </div>
                    <p className="text-[11px] text-sky-700 mt-0.5">
                      {reservation.stayShortened.fromArrival} → {reservation.stayShortened.fromDeparture}
                      {"  ⇒  "}
                      {reservation.stayShortened.toArrival} → {reservation.stayShortened.toDeparture}
                      {reservation.stayShortened.channelLocked && " · channel updates blocked"}
                    </p>
                    {reservation.stayShortened.reason && (
                      <p className="text-[11px] text-sky-600 mt-0.5 italic">
                        {reservation.stayShortened.reason}
                      </p>
                    )}
                    <p className="text-[11px] mt-1">
                      {Math.round(reservation.price) === Math.round(reservation.stayShortened.originalPriceCzk) ? (
                        <span className="text-amber-700">
                          ⏳ Price still {formatCurrency(reservation.stayShortened.originalPriceCzk)} — adjust it in
                          Beds24 and refund the guest.
                        </span>
                      ) : (
                        <span className="text-sky-700">
                          Price adjusted: {formatCurrency(reservation.stayShortened.originalPriceCzk)} →{" "}
                          {formatCurrency(reservation.price)}
                        </span>
                      )}
                    </p>
                  </div>
                )}

                {canEditNonArrival && reservation.numberOfNights > 1 && (
                  shortenOpen ? (
                    <div className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2.5">
                      <div className="text-sm font-medium text-sky-800">✂️ Shorten stay</div>
                      <p className="text-[11px] text-sky-600 mt-0.5">
                        Moves the dates in Beds24 and puts the trimmed nights back on sale. The price is
                        left untouched — adjust it in Beds24 and refund the guest yourself.
                      </p>
                      <div className="mt-2 flex items-end gap-3 flex-wrap">
                        <label className="text-[11px] text-sky-700">
                          New check-in
                          <input
                            type="date"
                            value={shortenArrival}
                            min={reservation.checkInDate}
                            max={reservation.checkOutDate}
                            disabled={reservation.checkInDate <= pragueToday()}
                            onChange={(e) => { setShortenArrival(e.target.value); setShortenError(null); }}
                            className="block mt-0.5 border border-sky-200 rounded px-2 py-1 text-sm text-sky-900 bg-white focus:outline-none focus:ring-2 focus:ring-sky-400 disabled:opacity-60 disabled:bg-sky-50"
                            title={
                              reservation.checkInDate <= pragueToday()
                                ? "The stay has already started — only the check-out can move"
                                : undefined
                            }
                          />
                        </label>
                        <label className="text-[11px] text-sky-700">
                          New check-out
                          <input
                            type="date"
                            value={shortenDeparture}
                            min={reservation.checkInDate}
                            max={reservation.checkOutDate}
                            onChange={(e) => { setShortenDeparture(e.target.value); setShortenError(null); }}
                            className="block mt-0.5 border border-sky-200 rounded px-2 py-1 text-sm text-sky-900 bg-white focus:outline-none focus:ring-2 focus:ring-sky-400"
                          />
                        </label>
                      </div>
                      <input
                        type="text"
                        value={shortenReason}
                        onChange={(e) => setShortenReason(e.target.value)}
                        placeholder="Why (optional) — e.g. guest flying home a day early"
                        className="mt-2 w-full border border-sky-200 rounded px-2 py-1 text-sm text-sky-900 bg-white focus:outline-none focus:ring-2 focus:ring-sky-400"
                      />
                      {(reservation.channel === "Booking.com" || reservation.channel === "Airbnb") && (
                        <label className="mt-2 flex items-start gap-1.5 text-[11px] text-sky-700">
                          <input
                            type="checkbox"
                            checked={shortenLock}
                            onChange={(e) => setShortenLock(e.target.checked)}
                            className="mt-0.5"
                          />
                          <span>
                            Block {reservation.channel} from changing this booking. Recommended — it still holds
                            the original dates and could otherwise re-block the freed nights. Genuine
                            channel-side changes stop arriving too, until you unlock it in Beds24.
                          </span>
                        </label>
                      )}
                      <p className="text-[11px] mt-2">
                        {shortenArrival === reservation.checkInDate &&
                        shortenDeparture === reservation.checkOutDate ? (
                          // Untouched form — a hint, not an error the operator caused.
                          <span className="text-sky-600">
                            Move a date to see what gets freed. Currently{" "}
                            {reservation.checkInDate} → {reservation.checkOutDate}.
                          </span>
                        ) : shortenPreview && !shortenPreview.ok ? (
                          <span className="text-red-600">{shortenPreview.error}</span>
                        ) : shortenPreview ? (
                          <span className="text-sky-800 font-medium">
                            {describeShortening(shortenPreview.plan)} ·{" "}
                            {nightsLabel(shortenPreview.plan.nightsRemoved)} back on sale
                          </span>
                        ) : null}
                      </p>
                      {shortenError && <p className="text-[11px] text-red-600 mt-1">{shortenError}</p>}
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={applyShortening}
                          disabled={shortenBusy || !shortenPreview?.ok}
                          className="px-3 py-1.5 text-xs font-medium text-white bg-sky-600 rounded-lg hover:bg-sky-700 transition-colors disabled:opacity-50"
                        >
                          {shortenBusy ? "Shortening…" : "Shorten in Beds24"}
                        </button>
                        <button
                          onClick={() => setShortenOpen(false)}
                          disabled={shortenBusy}
                          className="px-3 py-1.5 text-xs text-sky-700 hover:underline disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={openShorten}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-sky-700 border border-sky-200 rounded-lg hover:bg-sky-50 transition-colors"
                      title="Guest is still coming but wants a night off the stay — move the dates in Beds24 and free those nights for resale"
                    >
                      ✂️ Shorten stay
                    </button>
                  )
                )}
              </div>
            )}

            <div className="mt-3">
              <TaskBlock
                key={`admin-${reservation.reservationNumber}`}
                kind="admin"
                reservation={reservation}
                onAdd={addIssue}
                onToggleResolved={toggleIssueResolved}
                onDelete={deleteIssue}
              />
            </div>

            <hr className="border-gray-100 my-4" />
            <SubTitle>Notes</SubTitle>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Add internal notes about this reservation..."
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
            <button
              onClick={saveNote}
              className={`mt-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
                noteSaved
                  ? "bg-green-600 text-white hover:bg-green-700"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              }`}
            >
              {noteSaved ? "✓ Saved" : "Save Note"}
            </button>
            <hr className="border-gray-100 my-4" />
            <SubTitle>Customer Flags</SubTitle>
            <div className="flex flex-col gap-2">
              {ALL_FLAGS.map((flag) => {
                const isActive = effectiveFlags.includes(flag);
                const isAuto = autoFlags.has(flag);
                const isOverridden = reservation.manualFlagOverrides[flag] !== undefined;
                const { label, activeClass, inactiveClass } = flagConfig[flag];

                return (
                  <button
                    key={flag}
                    onClick={() => handleToggleFlag(flag)}
                    className={`px-3 py-2 rounded-md border text-sm font-medium text-left transition-colors flex items-center justify-between ${
                      isActive ? activeClass : inactiveClass
                    }`}
                  >
                    <span>{label}</span>
                    <span className="text-[10px] opacity-60 font-normal ml-2">
                      {isOverridden ? "manual" : isAuto && isActive ? "auto" : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-gray-400 mt-2">
              High Value (≥5 nights) and Repeat Customer are auto-assigned. Click to override.
            </p>
            <hr className="border-gray-100 my-4" />
            <SubTitle source={reservation.syncedRating ? "Beds24" : undefined}>Guest Rating</SubTitle>
            {/* Synced review (Booking.com / Airbnb) — read-only, takes precedence */}
            {reservation.syncedRating && (
              <div className={`mb-3 rounded-md border p-3 ${
                isTopRating(reservation.syncedRating)
                  ? "bg-green-50 border-green-200"
                  : "bg-red-50 border-red-200"
              }`}>
                <div className="flex items-center gap-2">
                  <span className="text-2xl leading-none">
                    {isTopRating(reservation.syncedRating) ? "😊" : "😡"}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold text-gray-800 tabular-nums">
                        {formatRating(reservation.syncedRating)}
                      </span>
                      <Badge variant="gray" size="xs">
                        {reservation.syncedRating.channel ?? reservation.syncedRating.source}
                      </Badge>
                    </div>
                    {reservation.syncedRating.reviewDate && (
                      <div className="text-[11px] text-gray-400 mt-0.5">
                        {formatDate(reservation.syncedRating.reviewDate)}
                      </div>
                    )}
                  </div>
                </div>
                {reservation.syncedRating.reviewText && (
                  <p className="mt-2 text-xs text-gray-600 whitespace-pre-wrap">
                    “{reservation.syncedRating.reviewText}”
                  </p>
                )}
                <p className="mt-2 text-[10px] text-gray-400">
                  Synced from Beds24 — overrides the manual rating below.
                </p>
              </div>
            )}

            <div className="flex gap-2">
              {(
                [
                  { status: "none", label: "No Rating", emoji: "—" },
                  { status: "good", label: "Good Rating", emoji: "😊" },
                  { status: "bad", label: "Bad Rating", emoji: "😡" },
                ] as { status: RatingStatus; label: string; emoji: string }[]
              ).map(({ status, label, emoji }) => (
                <button
                  key={status}
                  onClick={() => handleRating(status)}
                  className={`flex-1 py-2 px-2 rounded-md border text-sm font-medium transition-colors ${
                    reservation.ratingStatus === status
                      ? status === "good"
                        ? "bg-green-50 border-green-400 text-green-700"
                        : status === "bad"
                          ? "bg-red-50 border-red-400 text-red-700"
                          : "bg-gray-100 border-gray-400 text-gray-700"
                      : "bg-white border-gray-200 text-gray-500 hover:border-gray-400"
                  }`}
                >
                  <span className="block text-xl leading-tight">{emoji}</span>
                  <span className="text-[10px] mt-0.5 block">{label}</span>
                </button>
              ))}
            </div>

            {/* Manual numeric rating — ad-hoc fallback for Google / Direct / pre-review */}
            <div className="mt-3">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-medium text-gray-400">
                  Manual score {reservation.syncedRating ? "(overridden by synced)" : "(optional)"}
                </span>
              </div>
              <ManualRatingEditor
                key={reservation.reservationNumber}
                rating={reservation.manualRating}
                overridden={!!reservation.syncedRating}
                onChange={handleManualRating}
              />
            </div>
          </DrawerSection>

          <hr className="border-gray-100" />

          {/* ── 6. Invoice ── */}
          <DrawerSection
            title="Invoice"
            icon={SECTION_ICON.invoice}
            defaultOpen={false}
            summary={<span className="text-[11px] font-medium text-gray-500">{reservation.invoiceStatus}</span>}
          >
            <div className="flex items-center justify-end mb-3">
              <Badge
                variant={
                  reservation.invoiceStatus === "Sent"
                    ? "green"
                    : reservation.invoiceStatus === "Issued"
                      ? "blue"
                      : "gray"
                }
              >
                {reservation.invoiceStatus}
              </Badge>
            </div>

            {reservation.invoiceStatus === "Not Issued" ? (
              <div className="space-y-3">
                {/* Split invoice — one booking billed to several parties */}
                <button
                  onClick={toggleSplitMode}
                  className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    splitMode
                      ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                      : "bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M8 7h12M8 12h12M8 17h12M4 7h.01M4 12h.01M4 17h.01" />
                    </svg>
                    Split invoice
                    <span className="text-[10px] font-normal text-gray-400">
                      bill this stay to more than one party
                    </span>
                  </span>
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 transition-colors ${
                      splitMode ? "bg-indigo-600 border-indigo-600" : "bg-gray-200 border-gray-200"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                        splitMode ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>

                {splitMode ? (
                  <SplitInvoiceEditor
                    reservation={reservation}
                    splits={splitForms}
                    onPatch={patchSplit}
                    onPatchInvoiceData={patchSplitInvoiceData}
                    onRemove={removeSplit}
                    onAdd={addSplit}
                    onSplitEvenly={splitEvenly}
                    onSaveDetails={handleSaveSplitDetails}
                    saved={saveDetailsSaved}
                    onGenerate={handleGenerateSplitInvoices}
                  />
                ) : (<>
                <div>
                  <label className="text-[11px] text-gray-400 block mb-1">Company Name</label>
                  <input
                    type="text"
                    value={invoiceForm.companyName}
                    onChange={(e) => setInvoiceForm({ ...invoiceForm, companyName: e.target.value })}
                    className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Acme s.r.o."
                  />
                </div>
                <div>
                  <label className="text-[11px] text-gray-400 block mb-1">Company Address</label>
                  <input
                    type="text"
                    value={invoiceForm.companyAddress}
                    onChange={(e) =>
                      setInvoiceForm({ ...invoiceForm, companyAddress: e.target.value })
                    }
                    className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    placeholder="Šumavská 10, 602 00, Brno"
                  />
                </div>
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">IČO</label>
                    <input
                      type="text"
                      value={invoiceForm.ico}
                      onChange={(e) => setInvoiceForm({ ...invoiceForm, ico: e.target.value })}
                      className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="19876107"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">DIČ / VAT</label>
                    <input
                      type="text"
                      value={invoiceForm.vatNumber}
                      onChange={(e) =>
                        setInvoiceForm({ ...invoiceForm, vatNumber: e.target.value })
                      }
                      className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="CZ19876107"
                    />
                  </div>
                  <div>
                    <label className="text-[11px] text-gray-400 block mb-1">Billing Email</label>
                    <input
                      type="email"
                      value={invoiceForm.billingEmail}
                      onChange={(e) =>
                        setInvoiceForm({ ...invoiceForm, billingEmail: e.target.value })
                      }
                      className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="accounting@acme.cz"
                    />
                  </div>
                </div>
                {/* Save details without generating — lets operator store company info early */}
                <div className="flex gap-2">
                  <button
                    onClick={handleSaveDetails}
                    className={`flex-1 py-2 px-4 border text-sm font-medium rounded-md transition-colors ${
                      saveDetailsSaved
                        ? "border-green-300 bg-green-50 text-green-700"
                        : "border-gray-300 text-gray-700 hover:bg-gray-50"
                    }`}
                  >
                    {saveDetailsSaved ? "✓ Saved" : "Save details"}
                  </button>
                  <button
                    onClick={handleGenerateInvoice}
                    className="flex-1 py-2 px-4 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-700 transition-colors"
                  >
                    Generate Invoice
                  </button>
                </div>
                </>)}
              </div>
            ) : (
              <div className="space-y-3">
                {/* Collapsible summary bar */}
                <button
                  onClick={() => setInvoiceExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-700 truncate">
                    {hasSplits
                      ? `${issuedSplits.length} split invoices`
                      : reservation.invoiceData?.companyName || "Invoice"}
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant={reservation.invoiceStatus === "Sent" ? "green" : "blue"}>
                      {reservation.invoiceStatus}
                    </Badge>
                    <svg
                      className={`w-4 h-4 text-gray-400 transition-transform ${invoiceExpanded ? "rotate-180" : ""}`}
                      fill="none" stroke="currentColor" viewBox="0 0 24 24"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </span>
                </button>

                {invoiceExpanded && (<>
                {/* PDF Preview */}
                <InvoicePreview
                  res={reservation}
                  invoiceData={activeSplit ? activeSplit.invoiceData : reservation.invoiceData!}
                  includeQR={includePaymentQR}
                  split={activeSplit}
                  splitCount={issuedSplits.length}
                />

                {/* Payment QR toggle */}
                <button
                  onClick={() => {
                    const next = !includePaymentQR;
                    setIncludePaymentQR(next);
                    onUpdate({ ...reservation!, includeQR: next });
                  }}
                  className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg border text-sm font-medium transition-colors ${
                    includePaymentQR
                      ? "bg-indigo-50 border-indigo-300 text-indigo-700"
                      : "bg-gray-50 border-gray-200 text-gray-600 hover:border-gray-300"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"
                      />
                    </svg>
                    Include Payment QR
                  </span>
                  {/* Toggle pill */}
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 transition-colors ${
                      includePaymentQR ? "bg-indigo-600 border-indigo-600" : "bg-gray-200 border-gray-200"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                        includePaymentQR ? "translate-x-4" : "translate-x-0"
                      }`}
                    />
                  </span>
                </button>

                {/* QR Panel */}
                {includePaymentQR && (
                  <div className="rounded-lg border border-indigo-100 bg-indigo-50/40 p-4 flex gap-4 items-center">
                    {/* QR code */}
                    <div className="shrink-0 bg-white p-2 rounded-lg border border-indigo-100 shadow-sm">
                      <QRCodeSVG
                        value={activeSplitQR.spdString}
                        size={110}
                        level="M"
                      />
                    </div>
                    {/* Payment details */}
                    <div className="flex-1 space-y-1.5 text-xs">
                      <p className="font-semibold text-gray-700 text-sm mb-2">Payment Details</p>
                      <div>
                        <span className="text-gray-400">Account</span>
                        <p className="font-mono text-gray-800">{PAYMENT_ACCOUNT_DISPLAY}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">IBAN</span>
                        <p className="font-mono text-gray-800 tracking-wide">
                          {PAYMENT_IBAN.replace(/(.{4})/g, "$1 ").trim()}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400">SWIFT</span>
                        <p className="font-mono text-gray-800">{PAYMENT_SWIFT}</p>
                      </div>
                      <div>
                        <span className="text-gray-400">VS</span>
                        <p className="font-mono text-gray-800">
                          {activeSplitQR.vs}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400">Amount</span>
                        <p className="font-semibold text-indigo-700">
                          {Math.round(activeSplitQR.amountCZK).toLocaleString("cs-CZ")} Kč
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Per-split actions — replaces the single-invoice buttons */}
                {hasSplits && (
                  <div className="space-y-2">
                    <p className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide">
                      Invoices ({issuedSplits.length})
                    </p>
                    {issuedSplits.map((sp, i) => {
                      const isPreviewing = activeSplit?.id === sp.id;
                      return (
                        <div
                          key={sp.id}
                          className={`rounded-lg border p-2.5 space-y-2 transition-colors ${
                            isPreviewing ? "border-indigo-300 bg-indigo-50/40" : "border-gray-200 bg-white"
                          }`}
                        >
                          <button
                            onClick={() => setPreviewSplitId(sp.id)}
                            className="w-full flex items-start justify-between gap-2 text-left"
                          >
                            <span className="min-w-0">
                              <span className="block text-sm font-medium text-gray-800 truncate">
                                {sp.invoiceData.companyName || `Invoice ${i + 1}`}
                              </span>
                              <span className="block font-mono text-[10px] text-gray-400">
                                {splitInvoiceNumber(reservation.reservationNumber, sp.seq)}
                              </span>
                            </span>
                            <span className="shrink-0 text-sm font-semibold text-gray-800">
                              {formatCurrency(sp.amountCzk)}
                            </span>
                          </button>

                          {sp.sentAt && (
                            <p className="text-[11px] text-green-700">
                              ✓ Sent {new Date(sp.sentAt).toLocaleString("en-GB", {
                                day: "numeric", month: "short", year: "numeric",
                                hour: "2-digit", minute: "2-digit",
                              })} to {sp.sentTo}
                            </p>
                          )}

                          <div className="flex gap-1.5">
                            <button
                              onClick={() => handlePrintSplit(sp)}
                              className="flex-1 py-1.5 px-2 bg-gray-900 text-white text-xs font-medium rounded-md hover:bg-gray-700 transition-colors"
                            >
                              Print
                            </button>
                            <button
                              onClick={() => handleSendSplit(sp)}
                              disabled={isSendingInvoice}
                              className="flex-1 py-1.5 px-2 bg-indigo-600 text-white text-xs font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {sendingSplitId === sp.id ? "Sending…" : sp.sentAt ? "Send again" : "Send"}
                            </button>
                            <button
                              onClick={() => handleSaveSplitToDrive(sp)}
                              disabled={savingSplitDriveId === sp.id}
                              className="flex-1 py-1.5 px-2 border border-gray-200 text-gray-700 text-xs font-medium rounded-md hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 transition-colors"
                            >
                              {savingSplitDriveId === sp.id ? "Saving…" : "Drive"}
                            </button>
                          </div>

                          {splitDriveErrors[sp.id] && (
                            <p className="text-[11px] text-red-600">{splitDriveErrors[sp.id]}</p>
                          )}
                          {splitDriveResults[sp.id] && (
                            <a
                              href={splitDriveResults[sp.id].url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-[11px] text-green-700 hover:underline truncate"
                            >
                              Saved to Drive — {splitDriveResults[sp.id].name}
                            </a>
                          )}
                        </div>
                      );
                    })}
                    {(() => {
                      const { allocated, remaining, over } = splitTotals(reservation.price, issuedSplits);
                      return (
                        <p
                          className={`text-[11px] rounded px-2.5 py-1.5 border ${
                            over
                              ? "text-red-700 bg-red-50 border-red-200"
                              : "text-gray-600 bg-gray-50 border-gray-200"
                          }`}
                        >
                          {formatCurrency(allocated)} invoiced of {formatCurrency(reservation.price)}
                          {over
                            ? ` — ${formatCurrency(-remaining)} over the booking price.`
                            : Math.abs(remaining) <= 1
                              ? "."
                              : ` — ${formatCurrency(remaining)} not invoiced.`}
                        </p>
                      );
                    })()}
                  </div>
                )}

                {/* Actions */}
                {sendInvoiceError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                    {sendInvoiceError}
                  </p>
                )}
                {sendInvoiceDeferral && (
                  <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                    <span className="font-semibold">Sent — delivery deferred.</span> The mail server accepted the
                    message but deferred its confirmation, which it normally still delivers. Check the Sent folder
                    before sending again so the guest doesn&apos;t get two copies.
                    <span className="block mt-0.5 font-mono text-[10px] text-amber-700 break-all">{sendInvoiceDeferral}</span>
                  </p>
                )}
                {!hasSplits && (<>
                <div className="flex gap-2">
                  <button
                    onClick={handleDownloadPDF}
                    className="flex-1 py-2 px-3 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-700 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
                      />
                    </svg>
                    Print / Save PDF
                  </button>
                  {reservation.invoiceStatus === "Issued" && (
                    <button
                      onClick={handleSendInvoice}
                      disabled={isSendingInvoice}
                      className="flex-1 py-2 px-3 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                    >
                      <svg
                        className={`w-4 h-4 ${isSendingInvoice ? 'animate-spin' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        {isSendingInvoice ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                          />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                            d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                          />
                        )}
                      </svg>
                      {isSendingInvoice ? 'Sending…' : 'Send Invoice'}
                    </button>
                  )}
                </div>
                {/* Save to Drive */}
                <button
                  onClick={handleSaveToDrive}
                  disabled={isSavingToDrive}
                  className="w-full py-2 px-3 border border-gray-200 text-gray-700 text-sm font-medium rounded-md hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                >
                  {isSavingToDrive ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Saving to Drive…
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                          d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      Save to Drive
                    </>
                  )}
                </button>
                {driveSaveError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                    {driveSaveError}
                  </p>
                )}
                {driveSaveResult && (
                  <a
                    href={driveSaveResult.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-green-700 bg-green-50 border border-green-200 rounded px-2.5 py-1.5 hover:underline"
                  >
                    <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <span className="truncate">Saved — {driveSaveResult.name}</span>
                  </a>
                )}

                {/* ── Modify Invoice ─────────────────────────────────────── */}
                {!showModifyEditor && (
                  <button
                    onClick={() => setShowModifyEditor(true)}
                    className="w-full py-1.5 px-3 border border-amber-200 text-amber-700 text-xs font-medium rounded-md hover:bg-amber-50 transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    Modify Invoice
                  </button>
                )}

                {/* ── Modification editor ────────────────────────────────── */}
                {showModifyEditor && (
                  <div className="border border-amber-200 rounded-lg p-3 space-y-3 bg-amber-50/50">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Modify Invoice</span>
                      <button onClick={() => setShowModifyEditor(false)} className="text-gray-400 hover:text-gray-600">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>

                    {/* Date ranges */}
                    <div className="space-y-2">
                      <label className="text-[11px] text-gray-500 font-medium block">Date Ranges</label>
                      {modifyDateRanges.map((r, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <input
                            type="date"
                            value={r.from}
                            onChange={(e) => {
                              const next = [...modifyDateRanges];
                              next[i] = { ...next[i], from: e.target.value };
                              setModifyDateRanges(next);
                            }}
                            className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                          <span className="text-gray-400 text-xs shrink-0">→</span>
                          <input
                            type="date"
                            value={r.to}
                            onChange={(e) => {
                              const next = [...modifyDateRanges];
                              next[i] = { ...next[i], to: e.target.value };
                              setModifyDateRanges(next);
                            }}
                            className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                          />
                          {modifyDateRanges.length > 1 && (
                            <button
                              onClick={() => setModifyDateRanges(modifyDateRanges.filter((_, j) => j !== i))}
                              className="shrink-0 text-red-400 hover:text-red-600"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          )}
                        </div>
                      ))}
                      <button
                        onClick={() => setModifyDateRanges([...modifyDateRanges, { from: "", to: "" }])}
                        className="text-[11px] text-amber-700 hover:text-amber-900 flex items-center gap-0.5"
                      >
                        + Add date range
                      </button>
                    </div>

                    {/* Override fields */}
                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Nights</label>
                        <input
                          type="number"
                          min={1}
                          value={modifyNights}
                          onChange={(e) => setModifyNights(Number(e.target.value))}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Guests</label>
                        <input
                          type="number"
                          min={1}
                          value={modifyGuests}
                          onChange={(e) => setModifyGuests(Number(e.target.value))}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">Room</label>
                        <input
                          type="text"
                          value={modifyRoom}
                          onChange={(e) => setModifyRoom(e.target.value)}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                    </div>

                    {/* Manual content overrides — name + line description.
                        Empty value = use the Beds24-derived default. */}
                    <div className="space-y-2">
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">
                          Guest name on invoice <span className="text-gray-400 font-normal">(optional override)</span>
                        </label>
                        <input
                          type="text"
                          value={modifyGuestName}
                          onChange={(e) => setModifyGuestName(e.target.value)}
                          placeholder={`${reservation.firstName} ${reservation.lastName}`.trim()}
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                      <div>
                        <label className="text-[11px] text-gray-500 block mb-1">
                          Line description <span className="text-gray-400 font-normal">(optional override)</span>
                        </label>
                        <input
                          type="text"
                          value={modifyLineDescription}
                          onChange={(e) => setModifyLineDescription(e.target.value)}
                          placeholder="Ubytování / Accommodation"
                          className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                        />
                      </div>
                    </div>

                    {/* Invoice amount override — self-contained to this invoice.
                        Blank = booking price. NEVER changes res.price / payment. */}
                    <div>
                      <label className="text-[11px] text-gray-500 block mb-1">
                        Invoice amount (CZK) <span className="text-gray-400 font-normal">(optional override)</span>
                      </label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={modifyAmount}
                        onChange={(e) => setModifyAmount(e.target.value)}
                        placeholder={`${formatCurrency(reservation.price)} · booking price`}
                        className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-amber-400"
                      />
                      <p className="text-[10px] text-gray-400 mt-1">
                        Changes only this invoice&apos;s total — the booking price and payment stay unchanged.
                      </p>
                    </div>

                    <button
                      onClick={saveModification}
                      disabled={modifyDateRanges.every(r => !r.from || !r.to || r.from >= r.to)}
                      className="w-full py-1.5 px-3 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium rounded-md transition-colors"
                    >
                      Save Modification
                    </button>
                  </div>
                )}

                {/* ── Saved modifications list ───────────────────────────── */}
                {(reservation.invoiceModifications ?? []).length > 0 && (
                  <div className="border border-amber-100 rounded-lg overflow-hidden">
                    <div className="px-3 py-2 bg-amber-50 border-b border-amber-100 flex items-center gap-1.5">
                      <svg className="w-3 h-3 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                      </svg>
                      <span className="text-xs font-semibold text-amber-700">Modified Versions</span>
                    </div>
                    <div className="divide-y divide-amber-50">
                      {[...(reservation.invoiceModifications ?? [])].reverse().map((mod) => {
                        const rangeStr = mod.dateRanges
                          .map(r => {
                            const fmt = (s: string) => new Date(s + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
                            return `${fmt(r.from)} – ${fmt(r.to)}`;
                          })
                          .join(" · ");
                        const createdLabel = new Date(mod.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
                        return (
                          <div key={mod.id} className="px-3 py-2.5 space-y-1.5 bg-white">
                            <div className="flex items-center justify-between">
                              <span className="text-[11px] text-gray-400">{createdLabel}</span>
                              <div className="flex items-center gap-1">
                                <button
                                  onClick={() => handlePrintModified(mod)}
                                  className="px-2 py-0.5 text-[11px] font-medium bg-gray-900 text-white rounded hover:bg-gray-700 transition-colors"
                                >
                                  Print
                                </button>
                                <button
                                  onClick={() => handleSendModified(mod)}
                                  disabled={isSendingInvoice || !reservation.invoiceData?.billingEmail}
                                  title={!reservation.invoiceData?.billingEmail ? "No billing email set" : "Send this version by email"}
                                  className="px-2 py-0.5 text-[11px] font-medium bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                  {sendingModId === mod.id ? "Sending…" : "Send"}
                                </button>
                                <button
                                  onClick={() => handleSaveModifiedToDrive(mod)}
                                  disabled={savingModDriveId !== null}
                                  title="Save this version to Drive"
                                  className="px-2 py-0.5 text-[11px] font-medium border border-gray-200 text-gray-600 rounded hover:border-indigo-300 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                >
                                  {savingModDriveId === mod.id ? "Saving…" : "Drive"}
                                </button>
                                <button
                                  onClick={() => deleteModification(mod.id)}
                                  className="p-0.5 text-gray-300 hover:text-red-500 transition-colors"
                                  title="Delete this modification"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                  </svg>
                                </button>
                              </div>
                            </div>
                            <p className="text-[11px] text-gray-600 leading-snug">
                              {rangeStr} · {mod.numberOfNights}N · {mod.numberOfGuests} guests · {mod.room}
                            </p>
                            {mod.amount != null && (
                              <p className="text-[11px] font-medium text-amber-700 leading-snug">
                                Amount: {formatCurrency(mod.amount)} <span className="font-normal text-gray-400">(booking price {formatCurrency(reservation.price)})</span>
                              </p>
                            )}
                            {/* Sent record — persisted on the modification itself. */}
                            {mod.sentAt && (
                              <p className="text-[11px] text-green-700 leading-snug flex items-start gap-1">
                                <svg className="w-3 h-3 mt-[2px] shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                <span>
                                  Sent {new Date(mod.sentAt).toLocaleString("en-GB", {
                                    day: "numeric", month: "short", year: "numeric",
                                    hour: "2-digit", minute: "2-digit",
                                  })}
                                  {mod.sentTo ? ` to ${mod.sentTo}` : ""}
                                </span>
                              </p>
                            )}
                            {modDriveErrors[mod.id] && (
                              <p className="text-[11px] text-red-600 leading-snug">{modDriveErrors[mod.id]}</p>
                            )}
                            {modDriveResults[mod.id] && (
                              <a
                                href={modDriveResults[mod.id].url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[11px] text-green-700 hover:underline truncate block"
                              >
                                Saved to Drive — {modDriveResults[mod.id].name}
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                </>)}

                <div className="flex gap-2">
                  <button
                    onClick={() => onUpdate({ ...reservation!, invoiceStatus: "Not Issued" })}
                    className="flex-1 py-1.5 px-3 border border-gray-200 text-gray-500 text-xs font-medium rounded-md hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Re-issue with new details
                  </button>
                  {hasSplits && (
                    <button
                      onClick={handleClearSplits}
                      className="flex-1 py-1.5 px-3 border border-gray-200 text-gray-500 text-xs font-medium rounded-md hover:border-gray-400 hover:text-gray-700 transition-colors"
                    >
                      Back to one invoice
                    </button>
                  )}
                </div>
                </>)}
              </div>
            )}
          </DrawerSection>

          {/* Modals — overlays, so their position among these siblings is
               immaterial; kept together at the end. */}
          {showPaymentModal && (
            <PaymentLinkModal
              defaultEmail={reservation.additionalEmail || reservation.invoiceData?.billingEmail || undefined}
              defaultPhone={reservation.phone}
              defaultAmount={reservation.paymentStatus === "Partially Paid" ? reservation.price - reservation.amountPaid : undefined}
              defaultDescription={`Baker House — reservation ${reservation.reservationNumber}`}
              reservationNumber={reservation.reservationNumber}
              guestName={`${reservation.firstName} ${reservation.lastName}`.trim()}
              onPaymentCreated={onPaymentCreated}
              onClose={() => setShowPaymentModal(false)}
            />
          )}



          {showVoucherModal && (
            <CreateVoucherModal
              reservationNumber={reservation.reservationNumber}
              guestName={`${reservation.firstName} ${reservation.lastName}`.trim()}
              guestEmail={reservation.additionalEmail || reservation.invoiceData?.billingEmail || undefined}
              guestPhone={reservation.phone}
              onVoucherCreated={onPaymentCreated}
              onClose={() => setShowVoucherModal(false)}
            />
          )}

          {showEmailGuestModal && (
            <EmailGuestModal
              reservation={reservation}
              channel="email"
              defaultEmail={
                reservation.additionalEmail
                  || reservation.invoiceData?.billingEmail
                  || reservation.email
                  || ''
              }
              onClose={() => setShowEmailGuestModal(false)}
              onSent={() => {
                setShowEmailGuestModal(false);
                onPaymentCreated?.();
              }}
            />
          )}

          {showWhatsAppGuestModal && reservation.phone && (
            <EmailGuestModal
              reservation={reservation}
              channel="whatsapp"
              phone={reservation.phone}
              onClose={() => setShowWhatsAppGuestModal(false)}
              onSent={() => {
                setShowWhatsAppGuestModal(false);
                onPaymentCreated?.();
              }}
            />
          )}

          {showSmsGuestModal && reservation.phone && (
            <EmailGuestModal
              reservation={reservation}
              channel="sms"
              phone={reservation.phone}
              onClose={() => setShowSmsGuestModal(false)}
              onSent={() => {
                setShowSmsGuestModal(false);
                onPaymentCreated?.();
              }}
            />
          )}

          {/* Move-to-another-room confirmation modal — maintenance / ad-hoc.
              Allows any room incl. cross-type and in-house guests. Occupied
              targets are disabled unless the operator ticks "Ignore occupied",
              which is how a multi-step swap/rotation gets its first leg done. */}
          {showMoveModal && reservation && (() => {
            const todayStr = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Prague" });
            const inHouse =
              reservation.checkInDate <= todayStr && reservation.checkOutDate > todayStr;
            const targetOccupiers = occupiersDuringStay.get(moveTargetRoom) ?? [];
            return (
              <div
                className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
                onClick={() => !moveSubmitting && setShowMoveModal(false)}
              >
                <div
                  className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-5"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-base font-semibold text-gray-900">Move to another room</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {reservation.firstName} {reservation.lastName} ·{" "}
                    {formatDate(reservation.checkInDate)} → {formatDate(reservation.checkOutDate)}
                  </p>
                  <p className="mt-3 text-sm text-gray-700">
                    From <span className="font-medium">{reservation.room}</span>
                  </p>

                  <label className="block text-xs font-medium text-gray-600 mt-3 mb-1">Move to</label>
                  <select
                    value={moveTargetRoom}
                    onChange={(e) => setMoveTargetRoom(e.target.value)}
                    disabled={moveSubmitting || moveDone}
                    className="w-full border border-gray-200 rounded-md px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 disabled:opacity-50"
                  >
                    <option value="">Select a room…</option>
                    {PHYSICAL_ROOMS.filter((u) => u.room !== reservation.room).map((u) => {
                      const occupiers = occupiersDuringStay.get(u.room) ?? [];
                      const occ = occupiers.length > 0;
                      // One holder → name it; several → just the count, since a
                      // native <option> has no room for two of them.
                      const detail = !occ
                        ? " — free"
                        : occupiers.length === 1
                          ? ` — occupied · ${occupierLabel(occupiers[0])}`
                          : ` — occupied · ${occupiers.length} bookings`;
                      return (
                        <option key={u.room} value={u.room} disabled={occ && !moveIgnoreOccupied}>
                          {u.room}{detail}
                        </option>
                      );
                    })}
                  </select>

                  {/* The override. Deliberately unchecked on every open: forcing
                      a double-booking is a per-move decision, not a preference. */}
                  <label className="mt-2 flex items-start gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={moveIgnoreOccupied}
                      disabled={moveSubmitting || moveDone}
                      onChange={(e) => {
                        const on = e.target.checked;
                        setMoveIgnoreOccupied(on);
                        setMoveError(null);
                        // Turning it back OFF must not leave an occupied room
                        // selected — the Move button would then just 409.
                        if (!on && (occupiersDuringStay.get(moveTargetRoom)?.length ?? 0) > 0) {
                          setMoveTargetRoom("");
                        }
                      }}
                      className="mt-0.5 w-3.5 h-3.5 accent-rose-600 disabled:opacity-50"
                    />
                    <span className="text-[11px] leading-snug text-gray-600">
                      <span className="font-medium text-gray-800">Ignore occupied</span> — allow moving into
                      a unit that is already booked. For multi-step swaps and rotations, where every leg but
                      the last lands on a taken room.
                    </span>
                  </label>

                  {moveIgnoreOccupied && targetOccupiers.length > 0 && (
                    <div className="mt-2 text-[11px] text-rose-800 bg-rose-50 border border-rose-300 rounded px-2 py-1.5">
                      <p className="font-semibold">
                        This creates a real double-booking in {moveTargetRoom}.
                      </p>
                      <ul className="mt-1 space-y-0.5">
                        {targetOccupiers.map((o) => (
                          <li key={o.reservationNumber}>
                            · {o.reservationNumber} — {occupierLabel(o)}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1">Finish the remaining moves — Transactions will flag the clash until you do.</p>
                    </div>
                  )}

                  {unallocatedDuringStay.length > 0 && (
                    <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      {unallocatedDuringStay.length}{" "}
                      {unallocatedDuringStay.length === 1 ? "booking" : "bookings"} overlapping this stay
                      {unallocatedDuringStay.length === 1 ? " is" : " are"} still unallocated (
                      {unallocatedDuringStay.map((r) => r.room).join(", ")}) — a unit shown as free may be
                      claimed once Beds24 assigns {unallocatedDuringStay.length === 1 ? "it" : "them"}.
                    </p>
                  )}

                  {inHouse && (
                    <p className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      This guest is currently <strong>in-house</strong> — make sure they&apos;re physically moved.
                    </p>
                  )}
                  {moveError && (
                    <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1.5">
                      {moveError}
                    </p>
                  )}
                  {moveDone && (
                    <p className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">
                      ✓ Moved to {moveTargetRoom}. Syncing… A move notice now sits in the alert bar
                      until you dismiss it.
                    </p>
                  )}

                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => !moveSubmitting && setShowMoveModal(false)}
                      disabled={moveSubmitting}
                      className="px-3 py-2 text-sm text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleMoveRoom}
                      disabled={moveSubmitting || moveDone || !moveTargetRoom}
                      className={`px-4 py-2 text-sm text-white rounded-md disabled:opacity-40 disabled:cursor-not-allowed ${
                        targetOccupiers.length > 0
                          ? "bg-rose-600 hover:bg-rose-700"
                          : "bg-indigo-600 hover:bg-indigo-700"
                      }`}
                    >
                      {moveSubmitting
                        ? "Moving…"
                        : targetOccupiers.length > 0
                          ? `Force into ${moveTargetRoom}`
                          : `Move to ${moveTargetRoom || "…"}`}
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Confirmation email preview modal — operator reviews rendered
              email in an iframe, can Cancel or Send. */}
          {showConfirmationPreview && (
            <div
              className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
              onClick={() => !sendingConfirmation && setShowConfirmationPreview(false)}
            >
              <div
                className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 bg-amber-50">
                  <div className="flex items-center gap-2">
                    <svg className="w-4 h-4 text-amber-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                    </svg>
                    <h2 className="text-sm font-semibold text-amber-900">Preview confirmation email</h2>
                  </div>
                  <button
                    onClick={() => !sendingConfirmation && setShowConfirmationPreview(false)}
                    disabled={sendingConfirmation}
                    className="text-amber-700 hover:text-amber-900 disabled:opacity-50"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 overflow-hidden bg-gray-100">
                  {confirmationPreviewError ? (
                    <p className="p-4 text-sm text-red-600">{confirmationPreviewError}</p>
                  ) : confirmationPreviewHtml ? (
                    <iframe
                      title="Confirmation preview"
                      srcDoc={confirmationPreviewHtml}
                      sandbox=""
                      className="w-full h-full bg-white"
                    />
                  ) : (
                    <div className="p-8 text-center text-xs text-gray-500">
                      <svg className="w-5 h-5 mx-auto mb-2 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                      </svg>
                      Loading preview…
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between gap-3 px-5 py-3 border-t border-gray-100 bg-white">
                  <p className="text-xs text-gray-500 truncate">
                    Will be sent to{' '}
                    <span className="font-medium text-gray-700">
                      {reservation.invoiceData?.billingEmail
                        || reservation.additionalEmail
                        || reservation.email
                        || '(no email on file)'}
                    </span>
                  </p>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => setShowConfirmationPreview(false)}
                      disabled={sendingConfirmation}
                      className="px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-100 rounded-md transition-colors disabled:opacity-50"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleSendConfirmation}
                      disabled={sendingConfirmation || !confirmationPreviewHtml || !!confirmationPreviewError}
                      className="px-4 py-1.5 text-xs font-medium bg-amber-600 text-white rounded-md hover:bg-amber-700 disabled:opacity-50 transition-colors"
                    >
                      {sendingConfirmation ? 'Sending…' : 'Send email'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
