'use client';
import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Reservation, CustomerFlag, InvoiceData, RatingStatus } from "@/types/reservation";
import MessageThread from "./MessageThread";
import Badge from "@/components/shared/Badge";
import { formatDate, formatCurrency } from "@/utils/formatters";
import { computeAutoFlags, toggleFlagOverride, getEffectiveFlags } from "@/utils/flagUtils";
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

interface ReservationDrawerProps {
  reservation: Reservation | null;
  allReservations: Reservation[];
  unreadBookingIds: Set<number>;
  onClose: () => void;
  onUpdate: (updated: Reservation) => void;
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

function ReadOnlyField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] text-gray-400 mb-0.5">{label}</p>
      <p className="text-sm text-gray-800">{value}</p>
    </div>
  );
}

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
}: ReservationDrawerProps) {
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

  useEffect(() => {
    if (reservation) {
      setIncludePaymentQR(false);
      setNotes(reservation.notes);
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

  function handleGenerateInvoice() {
    onUpdate({
      ...reservation!,
      invoiceData: invoiceForm,
      invoiceStatus: "Issued",
    });
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
      onUpdate({ ...reservation!, invoiceStatus: "Sent" });
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
        className={`fixed top-0 right-0 h-full w-[480px] bg-white shadow-2xl z-50 flex flex-col transition-transform duration-300 ${
          isMounted ? "translate-x-0" : "translate-x-full"
        }`}
      >
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
              <ReadOnlyField label="Phone" value={reservation.phone} />
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
            <MessageThread
              beds24Id={parseInt(reservation.reservationNumber.slice(3))}
              hasUnread={unreadBookingIds.has(parseInt(reservation.reservationNumber.slice(3)))}
              guestName={`${reservation.firstName} ${reservation.lastName}`}
            />
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
          </section>

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

          {/* 9. Invoice */}
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
                <button
                  onClick={handleGenerateInvoice}
                  className="w-full py-2 px-4 bg-gray-900 text-white text-sm font-medium rounded-md hover:bg-gray-700 transition-colors"
                >
                  Generate Invoice
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* PDF Preview */}
                <InvoicePreview res={reservation} invoiceData={reservation.invoiceData!} />

                {/* Payment QR toggle */}
                <button
                  onClick={() => setIncludePaymentQR((v) => !v)}
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
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
