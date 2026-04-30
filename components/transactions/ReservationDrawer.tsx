'use client';
import { useState, useEffect, useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import PaymentLinkModal from "./PaymentLinkModal";
import type { Reservation, CustomerFlag, InvoiceData, RatingStatus, Issue, IssueCategory, InvoiceModification } from "@/types/reservation";
import type { AdditionalPayment } from "@/types/additionalPayment";
import type { Voucher } from "@/types/voucher";
import type { SplitPayment } from "@/types/splitPayment";
import MessageThread from "./MessageThread";
import CreateVoucherModal from "./CreateVoucherModal";
import Badge from "@/components/shared/Badge";
import { formatDate, formatCurrency } from "@/utils/formatters";
import { computeAutoFlags, toggleFlagOverride, getEffectiveFlags } from "@/utils/flagUtils";
import { computeParking, getFreeSpaces, PARKING_SPACES } from "@/utils/parkingUtils";
import { countryCodeToFlag, countryCodeToName } from "@/utils/nationalityUtils";
import {
  printInvoice,
  generateInvoiceNumber,
  PAYMENT_IBAN,
  PAYMENT_SWIFT,
  PAYMENT_ACCOUNT_DISPLAY,
} from "@/utils/invoiceUtils";
import type { PaymentQRInfo } from "@/utils/invoiceUtils";

function buildPaymentQRInfo(reservationNumber: string, priceCZK: number): PaymentQRInfo {
  const invoiceNum = generateInvoiceNumber(reservationNumber);
  const vs = invoiceNum.replace(/\D/g, "");
  const amountCZK = priceCZK;
  const spdString = `SPD*1.0*ACC:${PAYMENT_IBAN}*AM:${amountCZK.toFixed(2)}*CC:CZK*VS:${vs}*MSG:Baker House Apartments`;
  return { spdString, vs, amountCZK };
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

  const isUnpaid = ap.status === 'unpaid';
  const ageMs = Date.now() - new Date(ap.createdAt).getTime();
  const linkExpired = isUnpaid && ageMs > PAYMENT_LINK_TTL_MS;

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
          <span className={`text-[10px] font-medium ${isUnpaid ? "text-amber-600" : "text-emerald-600"}`}>
            {isUnpaid ? (linkExpired ? "Pending · expired" : "Pending") : "Paid"}
          </span>
        </div>
      </div>

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

function SourceLabel({ source }: { source: string }) {
  return (
    <span className="text-[10px] font-medium text-gray-400 border border-gray-200 rounded px-1.5 py-0.5 ml-2">
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

  // Keep draft in sync if reservation changes
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) {
    return (
      <div>
        <p className="text-[11px] text-gray-400 mb-0.5">Phone</p>
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-gray-800">{value || <span className="text-gray-400">—</span>}</p>
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
  special: {
    label: "Special Treatment",
    badgeBg: "bg-purple-500",
    cardBg: "bg-purple-50",
    cardBorder: "border-purple-100",
    buttonBg: "bg-purple-600 hover:bg-purple-700",
    icon: (
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5}
          d="M12 8v13m0-13V6a2 2 0 112 2h-2zm0 0V5.5A2.5 2.5 0 109.5 8H12zm-7 4h14M5 12a2 2 0 110-4h14a2 2 0 110 4M5 12v7a2 2 0 002 2h10a2 2 0 002-2v-7" />
      </svg>
    ),
  },
};

// ── Invoice preview rendered inside the drawer ────────────────────────────────
const GOLD = "#B08D57";
const DARK_BROWN = "#3B2F2F";

function InvoicePreview({
  res,
  invoiceData,
}: {
  res: Reservation;
  invoiceData: InvoiceData;
}) {
  const invoiceNum = generateInvoiceNumber(res.reservationNumber);
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const unitPrice = res.numberOfNights > 0 ? res.price / res.numberOfNights : res.price;

  return (
    <div
      style={{
        fontFamily: "sans-serif",
        color: DARK_BROWN,
        background: "#fff",
        borderRadius: 10,
        border: "1px solid #e8e0d6",
        overflow: "hidden",
        fontSize: 12,
      }}
    >
      {/* Brand name */}
      <div
        style={{
          fontFamily: "'Great Vibes', cursive",
          fontSize: 52,
          color: GOLD,
          textAlign: "center",
          padding: "18px 24px 4px",
          lineHeight: 1.1,
        }}
      >
        Baker House Apartments
      </div>

      {/* Provider + Invoice number row */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: `2px solid ${GOLD}`,
          padding: "10px 20px 14px",
          gap: 16,
        }}
      >
        {/* Left: Provider */}
        <div style={{ flex: 1 }}>
          <div
            style={{
              color: GOLD,
              fontWeight: "bold",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 4,
            }}
          >
            Dodavatel / Provider
          </div>
          <div style={{ fontWeight: "bold" }}>Truthseeker s.r.o.</div>
          <div style={{ color: "#6b5b4e" }}>Šumavská 493/10, 602 00 Brno</div>
          <div style={{ color: "#6b5b4e" }}>IČ: 19876106</div>
          <div style={{ fontStyle: "italic", color: GOLD, fontSize: 11, marginTop: 2 }}>
            Nejsme plátci DPH / Non-VAT payer
          </div>
        </div>

        {/* Right: Invoice details */}
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div style={{ fontSize: 16, fontWeight: "bold", marginBottom: 4 }}>
            FAKTURA č. {invoiceNum}
          </div>
          <div style={{ color: "#6b5b4e" }}>Datum / Date: {today}</div>
          <div style={{ color: "#6b5b4e" }}>Rezervace: #{res.reservationNumber}</div>
        </div>
      </div>

      {/* Customer */}
      <div style={{ padding: "12px 20px", borderBottom: `1px solid #EFEAE4` }}>
        <div
          style={{
            color: GOLD,
            fontWeight: "bold",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: 1,
            marginBottom: 5,
          }}
        >
          Odběratel / Customer
        </div>
        <div style={{ fontWeight: "bold", fontSize: 13 }}>{invoiceData.companyName}</div>
        <div style={{ color: "#6b5b4e" }}>{invoiceData.companyAddress}</div>
        {invoiceData.ico && <div style={{ color: "#6b5b4e" }}>IČO: {invoiceData.ico}</div>}
        {invoiceData.vatNumber && (
          <div style={{ color: "#6b5b4e" }}>DIČ: {invoiceData.vatNumber}</div>
        )}
      </div>

      {/* Booking details */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: 8,
          padding: "12px 20px",
          borderBottom: `1px solid #EFEAE4`,
          background: "#fdfaf7",
        }}
      >
        {[
          ["Pokoj / Room", res.room],
          ["Příjezd / Check-in", formatDate(res.checkInDate)],
          ["Odjezd / Check-out", formatDate(res.checkOutDate)],
          ["Nocí / Nights", String(res.numberOfNights)],
          ["Hostů / Guests", String(res.numberOfGuests)],
          ["Rezervace / Booking", res.reservationNumber],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={{ color: GOLD, fontSize: 9, textTransform: "uppercase", fontWeight: "bold", letterSpacing: 0.5, marginBottom: 2 }}>
              {label}
            </div>
            <div style={{ color: DARK_BROWN, fontWeight: 500 }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Line items table */}
      <div style={{ padding: "12px 20px" }}>
        {/* Header row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            gap: 8,
            borderBottom: `1px solid #d4c4b0`,
            paddingBottom: 5,
            marginBottom: 6,
            color: GOLD,
            fontSize: 10,
            fontWeight: "bold",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          <span>Popis / Description</span>
          <span style={{ textAlign: "right", minWidth: 40 }}>Nocí</span>
          <span style={{ textAlign: "right", minWidth: 70 }}>Cena / night</span>
          <span style={{ textAlign: "right", minWidth: 70 }}>Celkem</span>
        </div>
        {/* Item row */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto auto auto",
            gap: 8,
            paddingBottom: 8,
            borderBottom: `1px solid #EFEAE4`,
            color: DARK_BROWN,
          }}
        >
          <span>
            Ubytování / Accommodation
            <br />
            <span style={{ fontSize: 11, color: "#6b5b4e" }}>
              {res.firstName} {res.lastName}
            </span>
          </span>
          <span style={{ textAlign: "right", minWidth: 40 }}>{res.numberOfNights}</span>
          <span style={{ textAlign: "right", minWidth: 70 }}>{formatCurrency(unitPrice)}</span>
          <span style={{ textAlign: "right", minWidth: 70 }}>{formatCurrency(res.price)}</span>
        </div>
        {/* Total row */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 8,
            fontWeight: "bold",
            fontSize: 14,
            color: DARK_BROWN,
          }}
        >
          <span>Celkem / Total</span>
          <span style={{ color: GOLD }}>{formatCurrency(res.price)}</span>
        </div>
      </div>

      {/* Footer */}
      <div
        style={{
          borderTop: `1px solid #EFEAE4`,
          padding: "14px 20px 16px",
          textAlign: "center",
          background: "#fdfaf7",
        }}
      >
        <div style={{ color: "#6b5b4e", marginBottom: 2, fontSize: 11 }}>
          Děkujeme za Vaši návštěvu! / Thank you for your stay!
        </div>
        <div
          style={{
            fontFamily: "'Great Vibes', cursive",
            fontSize: 34,
            color: GOLD,
            lineHeight: 1.2,
          }}
        >
          Patrik &amp; Zuzana
        </div>
        <a
          href="https://www.bakerhouseapartments.cz"
          style={{ fontSize: 13, color: "#B08D57", fontWeight: 600, textDecoration: "none", display: "block", marginTop: 4 }}
        >
          www.bakerhouseapartments.cz
        </a>
        {invoiceData.billingEmail && (
          <div style={{ fontSize: 10, color: "#aaa", marginTop: 1 }}>
            Billing: {invoiceData.billingEmail}
          </div>
        )}
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
  const net = price - totalFees;
  const hasBreakdown = totalFees > 0;
  const feesAreMissing = !NO_FEE_CHANNELS.includes(channel) && totalFees === 0;

  return (
    <div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => hasBreakdown && setOpen((v) => !v)}
          className={`flex items-center gap-1 text-sm font-medium text-gray-800 transition-colors ${hasBreakdown ? "hover:text-indigo-600 cursor-pointer" : "cursor-default"}`}
          title={hasBreakdown ? "Click to see fee breakdown" : undefined}
        >
          {formatCurrency(price)}
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
            title="Fee data not available from Beds24 for this booking"
            className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-100 text-amber-600 text-[10px] font-bold leading-none shrink-0"
          >
            !
          </span>
        )}
      </div>
      {open && hasBreakdown && (
        <div className="mt-2 rounded-md border border-gray-100 bg-gray-50 px-3 py-2.5 space-y-1.5 text-xs">
          <BreakdownRow label="Gross Booking Value" value={price} />
          {commissionAmount > 0 && (
            <BreakdownRow label={`${channel} commission`} value={-commissionAmount} />
          )}
          {paymentChargeAmount > 0 && (
            <BreakdownRow label="Payment processing fee" value={-paymentChargeAmount} />
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
  const [notes, setNotes] = useState("");
  const [newIssueText, setNewIssueText] = useState("");
  const [newIssueDate, setNewIssueDate] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [newIssueCategory, setNewIssueCategory] = useState<IssueCategory>("problem");
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
  const [isSavingToDrive, setIsSavingToDrive] = useState(false);
  const [driveSaveResult, setDriveSaveResult] = useState<{ url: string; name: string } | null>(null);
  const [driveSaveError, setDriveSaveError] = useState<string | null>(null);
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [showVoucherModal, setShowVoucherModal] = useState(false);
  const [invoiceExpanded, setInvoiceExpanded] = useState(false);
  // Check-Stripe button state
  const [checkingStripe, setCheckingStripe] = useState(false);
  const [checkStripeResult, setCheckStripeResult] = useState<
    | { kind: 'ok'; status: string | null; updated: number; checked: number }
    | { kind: 'error'; message: string }
    | null
  >(null);
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
  // Invoice modification editor
  const [showModifyEditor, setShowModifyEditor] = useState(false);
  const [modifyDateRanges, setModifyDateRanges] = useState<{ from: string; to: string }[]>([{ from: "", to: "" }]);
  const [modifyNights, setModifyNights] = useState(0);
  const [modifyGuests, setModifyGuests] = useState(1);
  const [modifyRoom, setModifyRoom] = useState("");
  const [modifyGuestName, setModifyGuestName] = useState("");
  const [modifyLineDescription, setModifyLineDescription] = useState("");

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
      setNewIssueText("");
      setNewIssueDate(new Date().toLocaleDateString("sv-SE"));
      setNewIssueCategory("problem");
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
      if (reservation.invoiceData) {
        setInvoiceForm({ ...reservation.invoiceData });
      } else {
        setInvoiceForm({ companyName: "", companyAddress: "", ico: "", vatNumber: "", billingEmail: "" });
      }
    }
  }, [reservation]);

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

  function saveNote() {
    onUpdate({ ...reservation!, notes });
  }

  function addIssue() {
    const textRequired = newIssueCategory === "problem" || newIssueCategory === "special";
    if (textRequired && !newIssueText.trim()) return;
    const issue: Issue = {
      id: Date.now().toString(),
      category: newIssueCategory,
      text: newIssueText.trim(),
      actionableDate: newIssueDate,
      resolved: false,
      createdAt: new Date().toISOString(),
    };
    onUpdate({ ...reservation!, issues: [...(reservation!.issues ?? []), issue] });
    setNewIssueText("");
    setNewIssueDate(new Date().toISOString().slice(0, 10));
    setNewIssueCategory("problem");
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
    const mod: InvoiceModification = {
      id: Date.now().toString(),
      dateRanges: validRanges,
      numberOfNights: modifyNights,
      numberOfGuests: modifyGuests,
      room: modifyRoom,
      ...(modifyGuestName.trim() ? { guestName: modifyGuestName.trim() } : {}),
      ...(modifyLineDescription.trim() ? { lineDescription: modifyLineDescription.trim() } : {}),
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
      await printInvoice(reservation!, reservation!.invoiceData, undefined, mod);
    }
  }

  async function handleSendModified(mod: InvoiceModification) {
    setSendInvoiceError(null);
    setIsSendingInvoice(true);
    try {
      const res = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: false, modification: mod }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
    } catch (err) {
      setSendInvoiceError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setIsSendingInvoice(false);
    }
  }

  /** Upsert a revenue invoice for a QR-enabled issued invoice */
  async function upsertRevenueInvoice(res: typeof reservation) {
    if (!res || !res.includeQR) return;
    try {
      // Deterministic id: one revenue invoice per reservation
      const id = `rev-${res.reservationNumber}`;
      const invoiceNumber = generateInvoiceNumber(res.reservationNumber);
      await fetch('/api/revenue-invoices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          sourceType: 'issued',
          category: 'accommodation_direct',
          invoiceNumber,
          invoiceDate: new Date().toISOString().slice(0, 10),
          amountCZK: res.price,
          reservationNumber: res.reservationNumber,
          guestName: `${res.firstName} ${res.lastName}`.trim(),
        }),
      });
    } catch { /* non-fatal */ }
  }

  function handleGenerateInvoice() {
    const updated = {
      ...reservation!,
      invoiceData: invoiceForm,
      invoiceStatus: "Issued" as const,
    };
    onUpdate(updated);
    upsertRevenueInvoice(updated);
  }

  async function handleSendInvoice() {
    setSendInvoiceError(null);
    setIsSendingInvoice(true);
    try {
      const res = await fetch('/api/send-invoice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservation: reservation!, includeQR: includePaymentQR }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? `HTTP ${res.status}`);
      }
      const updated = { ...reservation!, invoiceStatus: "Sent" as const };
      onUpdate(updated);
      upsertRevenueInvoice(updated);
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
  async function handleCheckStripe() {
    if (!reservation) return;
    setCheckingStripe(true);
    setCheckStripeResult(null);
    try {
      const res = await fetch('/api/stripe/check-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationNumber: reservation.reservationNumber }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setCheckStripeResult({
        kind: 'ok',
        status: data.status ?? null,
        updated: data.updated ?? 0,
        checked: data.checked ?? 0,
      });
      // Trigger reservation refresh so updated AdditionalPayments + override show through
      onPaymentCreated?.();
    } catch (err) {
      setCheckStripeResult({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Failed to check Stripe',
      });
    } finally {
      setCheckingStripe(false);
      // Auto-clear feedback after a few seconds
      setTimeout(() => setCheckStripeResult(null), 4500);
    }
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

  const isOTAChannel = reservation.channel === "Booking.com" || reservation.channel === "Airbnb";
  const isDirectPhone = reservation.channel === "Direct-Phone";
  const nationalityFlag = countryCodeToFlag(reservation.nationality);
  const nationalityName = countryCodeToName(reservation.nationality);

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
              {reservation.ratingStatus === "good" && (
                <span className="ml-1.5">😊</span>
              )}
              {reservation.ratingStatus === "bad" && (
                <span className="ml-1.5">😡</span>
              )}
            </p>
            <p className="text-xs text-gray-400 font-mono mt-0.5">
              {reservation.reservationNumber}
            </p>
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

          {/* 1. Reservation Info */}
          <section>
            <SectionTitle source="Beds24">Reservation Info</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              <ReadOnlyField label="Room" value={reservation.room} />
              <ReadOnlyField label="Channel" value={reservation.channel} />
              <ReadOnlyField label="Check-in" value={formatDate(reservation.checkInDate)} />
              <ReadOnlyField label="Check-out" value={formatDate(reservation.checkOutDate)} />
              <ReadOnlyField label="Nights" value={String(reservation.numberOfNights)} />
              <ReadOnlyField label="Reservation Date" value={formatDate(reservation.reservationDate)} />
            </div>

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
          </section>

          <hr className="border-gray-100" />

          {/* 2. Guest Info */}
          <section>
            <SectionTitle source="Beds24">Guest Info</SectionTitle>
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
          </section>

          <hr className="border-gray-100" />

          {/* 3. Messaging */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <SectionTitle source="Beds24">Messaging</SectionTitle>
              {reservation.phone && (() => {
                const cleaned = reservation.phone.replace(/[^\d+]/g, "").replace(/^\+/, "");
                return (
                  <a
                    href={`https://web.whatsapp.com/send?phone=${cleaned}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500 hover:bg-green-600 text-white text-xs font-semibold transition-colors"
                    title={`Open WhatsApp chat with ${reservation.firstName}`}
                  >
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" xmlns="http://www.w3.org/2000/svg">
                      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                    </svg>
                    WhatsApp
                  </a>
                );
              })()}
            </div>
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
          </section>

          <hr className="border-gray-100" />

          {/* 4. Payment */}
          <section>
            <SectionTitle source={isOTAChannel ? reservation.channel : isDirectPhone ? "Direct" : "Stripe"}>
              Payment
            </SectionTitle>

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
                </div>
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
                {reservation.paymentStatus === "Partially Paid" && (
                  <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                    Outstanding balance: {formatCurrency(reservation.price - reservation.amountPaid)}
                  </p>
                )}
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
                  Only relevant when at least one Stripe payment is linked. */}
              {(reservation.additionalPayments ?? []).length > 0 && (
                <button
                  onClick={handleCheckStripe}
                  disabled={checkingStripe}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors w-fit disabled:opacity-50"
                  title="Ask Stripe directly whether linked payments cleared (use if webhook missed)"
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
              )}
            </div>

            {/* Check-Stripe result feedback */}
            {checkStripeResult && (
              <p
                className={`text-[11px] mt-1 px-2 py-1 rounded ${
                  checkStripeResult.kind === 'error'
                    ? 'text-red-700 bg-red-50 border border-red-200'
                    : checkStripeResult.updated > 0
                      ? 'text-green-700 bg-green-50 border border-green-200'
                      : 'text-gray-500 bg-gray-50 border border-gray-200'
                }`}
              >
                {checkStripeResult.kind === 'error'
                  ? checkStripeResult.message
                  : checkStripeResult.updated > 0
                    ? `Updated ${checkStripeResult.updated} payment${checkStripeResult.updated > 1 ? 's' : ''}${checkStripeResult.status ? ` · status now ${checkStripeResult.status}` : ''}`
                    : checkStripeResult.checked > 0
                      ? `Checked ${checkStripeResult.checked} — already in sync${checkStripeResult.status ? ` (${checkStripeResult.status})` : ''}`
                      : 'No linked Stripe payments to check'}
              </p>
            )}

            {/* Additional Payments sub-list (sent links — paid + pending) */}
            {(reservation.additionalPayments ?? []).length > 0 && (
              <div className="mt-3 border border-gray-100 rounded-lg overflow-hidden">
                <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wide px-3 py-2 bg-gray-50 border-b border-gray-100">
                  Additional Payments
                </p>
                <div className="divide-y divide-gray-100">
                  {(reservation.additionalPayments ?? []).map((ap) => (
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
          </section>

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

          <hr className="border-gray-100" />

          {/* 4b. Vouchers */}
          <section>
            <div className="flex items-center justify-between mb-2">
              <SectionTitle>Vouchers</SectionTitle>
            </div>

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
          </section>

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

          <hr className="border-gray-100" />

          {/* 5. Cleaning */}
          <section>
            <SectionTitle source="Cleaning App">Cleaning</SectionTitle>
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
          </section>

          <hr className="border-gray-100" />

          {/* 5b. Parking */}
          <section>
            <SectionTitle>Parking</SectionTitle>
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
          </section>

          <hr className="border-gray-100" />

          {/* 6. Rating */}
          <section>
            <SectionTitle>Guest Rating</SectionTitle>
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
          </section>

          <hr className="border-gray-100" />

          {/* 7. Customer Flags */}
          <section>
            <SectionTitle>Customer Flags</SectionTitle>
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
          </section>

          <hr className="border-gray-100" />

          {/* 8. Notes */}
          <section>
            <SectionTitle>Notes</SectionTitle>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={4}
              placeholder="Add internal notes about this reservation..."
              className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
            />
            <button
              onClick={saveNote}
              className="mt-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors"
            >
              Save Note
            </button>
          </section>

          <hr className="border-gray-100" />

          {/* 9. Issue Log */}
          <section>
            <SectionTitle>Issue Log</SectionTitle>

            {/* Existing issues sorted by actionable date */}
            {(reservation.issues ?? []).length > 0 && (
              <div className="space-y-2 mb-4">
                {[...(reservation.issues ?? [])]
                  .sort((a, b) => a.actionableDate.localeCompare(b.actionableDate))
                  .map((issue) => {
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
                          {/* Category badge */}
                          <span className={`mt-0.5 shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full text-white ${cfg.badgeBg}`}>
                            {cfg.icon}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-semibold mb-0.5 ${issue.resolved ? "text-gray-400" : "text-gray-500"}`}>
                              {cfg.label}
                            </p>
                            <p className={`text-sm ${issue.resolved ? "line-through text-gray-400" : "text-gray-800"}`}>
                              {issue.text}
                            </p>
                            <p className="text-[11px] text-gray-400 mt-0.5">
                              Actionable: {formatDate(issue.actionableDate)}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => toggleIssueResolved(issue.id)}
                              className={`text-[11px] px-2 py-1 rounded border font-medium transition-colors ${
                                issue.resolved
                                  ? "border-gray-200 text-gray-500 hover:border-green-300 hover:text-green-600"
                                  : "border-green-200 text-green-700 bg-green-50 hover:bg-green-100"
                              }`}
                            >
                              {issue.resolved ? "Reopen" : "Resolve"}
                            </button>
                            <button
                              onClick={() => deleteIssue(issue.id)}
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

            {/* New issue form */}
            <div className="space-y-2">
              {/* Category selector */}
              <div className="flex gap-1.5 flex-wrap">
                {(Object.keys(CATEGORY_CONFIG) as IssueCategory[]).map((cat) => {
                  const cfg = CATEGORY_CONFIG[cat];
                  const active = newIssueCategory === cat;
                  return (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => setNewIssueCategory(cat)}
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
              <textarea
                value={newIssueText}
                onChange={(e) => setNewIssueText(e.target.value)}
                rows={2}
                placeholder="Describe the issue or task…"
                className="w-full border border-gray-200 rounded-md px-3 py-2 text-sm text-gray-800 placeholder-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
              />
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-[11px] text-gray-400 block mb-1">Actionable date</label>
                  <input
                    type="date"
                    value={newIssueDate}
                    onChange={(e) => setNewIssueDate(e.target.value)}
                    className="w-full border border-gray-200 rounded-md px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    onClick={addIssue}
                    disabled={(newIssueCategory === "problem" || newIssueCategory === "special") && !newIssueText.trim()}
                    className={`px-4 py-1.5 text-white text-sm font-medium rounded-md disabled:opacity-40 disabled:cursor-not-allowed transition-colors ${CATEGORY_CONFIG[newIssueCategory].buttonBg}`}
                  >
                    Add {CATEGORY_CONFIG[newIssueCategory].label}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <hr className="border-gray-100" />

          {/* 10. Invoice */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <SectionTitle>Invoice</SectionTitle>
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
              </div>
            ) : (
              <div className="space-y-3">
                {/* Collapsible summary bar */}
                <button
                  onClick={() => setInvoiceExpanded((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors"
                >
                  <span className="text-sm font-medium text-gray-700 truncate">
                    {reservation.invoiceData?.companyName || "Invoice"}
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
                <InvoicePreview res={reservation} invoiceData={reservation.invoiceData!} />

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
                        value={buildPaymentQRInfo(reservation.reservationNumber, reservation.price).spdString}
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
                          {buildPaymentQRInfo(reservation.reservationNumber, reservation.price).vs}
                        </p>
                      </div>
                      <div>
                        <span className="text-gray-400">Amount</span>
                        <p className="font-semibold text-indigo-700">
                          {Math.round(reservation.price).toLocaleString("cs-CZ")} Kč
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Actions */}
                {sendInvoiceError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2.5 py-1.5">
                    {sendInvoiceError}
                  </p>
                )}
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
                                  Send
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
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <button
                  onClick={() => onUpdate({ ...reservation!, invoiceStatus: "Not Issued" })}
                  className="w-full py-1.5 px-3 border border-gray-200 text-gray-500 text-xs font-medium rounded-md hover:border-red-300 hover:text-red-600 hover:bg-red-50 transition-colors"
                >
                  Re-issue with new details
                </button>
                </>)}
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
