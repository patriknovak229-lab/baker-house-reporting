'use client';
import { useState, useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Reservation, CustomerFlag, InvoiceData, RatingStatus } from "@/types/reservation";
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
          <span>Ubytování / Accommodation</span>
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
        <div style={{ fontSize: 10, color: "#aaa", marginTop: 2 }}>
          www.bakerhouseapartments.cz
        </div>
        {invoiceData.billingEmail && (
          <div style={{ fontSize: 10, color: "#aaa", marginTop: 1 }}>
            Billing: {invoiceData.billingEmail}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main drawer ───────────────────────────────────────────────────────────────
export default function ReservationDrawer({
  reservation,
  allReservations,
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

  function handleSendInvoice() {
    onUpdate({ ...reservation!, invoiceStatus: "Sent" });
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
    "High Value Customer",
    "Repeat Customer",
    "Problematic Customer",
  ];

  const flagConfig: Record<
    CustomerFlag,
    { label: string; activeClass: string; inactiveClass: string }
  > = {
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
              <ReadOnlyField label="Email" value={reservation.email} />
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

          {/* 3. Payment */}
          <section>
            <SectionTitle source={isOTAChannel ? reservation.channel : isDirectPhone ? "Direct" : "Stripe"}>
              Payment
            </SectionTitle>

            {isOTAChannel ? (
              <div className="space-y-2">
                <div className="flex items-center gap-3">
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1">Status</p>
                    <Badge
                      variant={
                        reservation.paymentStatus === "Paid"
                          ? "green"
                          : reservation.paymentStatus === "Unpaid"
                            ? "red"
                            : reservation.paymentStatus === "Partially Paid"
                              ? "amber"
                              : "gray"
                      }
                    >
                      {reservation.paymentStatus}
                    </Badge>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1">Total</p>
                    <p className="text-sm font-medium text-gray-800">
                      {formatCurrency(reservation.price)}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-blue-700 bg-blue-50 border border-blue-200 rounded px-2.5 py-1.5">
                  Paid through {reservation.channel} — collected by channel.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1">Status</p>
                    <Badge
                      variant={
                        reservation.paymentStatus === "Paid"
                          ? "green"
                          : reservation.paymentStatus === "Unpaid"
                            ? "red"
                            : reservation.paymentStatus === "Partially Paid"
                              ? "amber"
                              : "gray"
                      }
                    >
                      {reservation.paymentStatus}
                    </Badge>
                  </div>
                  <ReadOnlyField label="Total Price" value={formatCurrency(reservation.price)} />
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

          {/* 4. Cleaning */}
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

          {/* 5. Rating */}
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

          {/* 6. Customer Flags */}
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

          {/* 7. Notes */}
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

          {/* 8. Invoice */}
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
                      className="flex-1 py-2 px-3 bg-indigo-600 text-white text-sm font-medium rounded-md hover:bg-indigo-700 transition-colors flex items-center justify-center gap-1.5"
                      title="SMTP configuration coming soon"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                        />
                      </svg>
                      Send Invoice
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
