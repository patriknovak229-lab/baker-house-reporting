import QRCodeLib from "qrcode";
import type { Reservation, InvoiceData, InvoiceModification, PaymentStatus } from "@/types/reservation";
import { formatDate, formatCurrency } from "./formatters";

/** Count calendar nights between two ISO date strings (exclusive end, same as reservations). */
function nightsBetween(from: string, to: string): number {
  const a = new Date(from + "T00:00:00");
  const b = new Date(to + "T00:00:00");
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

/** Short date label, e.g. "3 Apr". */
function shortDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

const GOLD = "#B08D57";
const DARK_BROWN = "#3B2F2F";
const MID_BROWN = "#6b5b4e";
const GREEN = "#2F7A4D";
const AMBER = "#8A6414";
const RED = "#A1452F";

/** Bilingual chip copy + colours per payment status. */
const PAYMENT_STATUS_LABELS: Record<string, { text: string; color: string; bg: string }> = {
  "Paid":           { text: "UHRAZENO / PAID",                    color: GREEN,     bg: "#EDF6F0" },
  "Partially Paid": { text: "ČÁSTEČNĚ UHRAZENO / PARTIALLY PAID", color: AMBER,     bg: "#FBF4E4" },
  "Unpaid":         { text: "NEUHRAZENO / UNPAID",                color: RED,       bg: "#FBF0ED" },
  "Refunded":       { text: "VRÁCENO / REFUNDED",                 color: MID_BROWN, bg: "#F4F1ED" },
};

export const PAYMENT_IBAN = "CZ2001000001311073630227";
export const PAYMENT_SWIFT = "KOMBCZPP";
export const PAYMENT_ACCOUNT_DISPLAY = "131-1073630227/0100";

export interface PaymentQRInfo {
  spdString: string;
  vs: string;
  amountCZK: number;
}

export function generateInvoiceNumber(reservationNumber: string): string {
  return `INV-${reservationNumber.slice(3)}`;
}

/**
 * Payment status as the drawer shows it: a manual override always wins over the
 * Beds24/Stripe-derived value. Read-only — this never changes payment state.
 */
export function effectivePaymentStatus(res: Reservation): PaymentStatus | null {
  return res.paymentStatusOverride ?? res.paymentStatus ?? null;
}

/**
 * How the guest's money reached us, for the invoice status band.
 *
 *  - Booking.com / Airbnb collect from the guest themselves.
 *  - Direct-Web is the rental site, whose checkout is Stripe-only (it writes
 *    deposit = price into Beds24 straight from the Stripe webhook).
 *  - Direct-Phone goes through Stripe whenever a payment link was actually
 *    paid, which is exactly what a settled AdditionalPayment records.
 *
 * Returns null when we genuinely cannot tell — legacy `Direct` bookings typed
 * straight into the Beds24 UI carry no instrument at all, and guessing one on
 * an accounting document is worse than saying nothing.
 */
export function resolvePaymentChannel(res: Reservation): { cs: string; en: string } | null {
  if (res.channel === "Booking.com") return { cs: "Booking.com", en: "Booking.com" };
  if (res.channel === "Airbnb") return { cs: "Airbnb", en: "Airbnb" };

  const settledStripePayment = (res.additionalPayments ?? []).some(
    p => p.status === "paid" || p.status === "partially-refunded" || p.status === "refunded"
  );
  if (res.channel === "Direct-Web" || settledStripePayment) {
    return { cs: "platební bránu Stripe", en: "Stripe payment gateway" };
  }
  return null;
}

/**
 * Status band: payment status, how it was paid, and the confirmed-and-valid
 * statement. Purely derived from the reservation — nothing here writes back.
 */
function buildStatusBandHTML(res: Reservation, modification?: InvoiceModification): string {
  const status = effectivePaymentStatus(res);
  const chip = status ? PAYMENT_STATUS_LABELS[status] : undefined;
  const paidChannel = resolvePaymentChannel(res);
  const isPaidish = status === "Paid" || status === "Partially Paid";

  const methodLine = isPaidish && paidChannel
    ? `Uhrazeno přes ${paidChannel.cs} / Paid via ${paidChannel.en}`
    : "";

  // Outstanding balance only makes sense against the booking's own price, so
  // it is suppressed on invoice variants that carry their own total.
  const outstandingLine =
    status === "Partially Paid" && modification?.amount == null && typeof res.amountPaid === "number"
      ? `Uhrazeno / Paid: ${formatCurrency(res.amountPaid)} · Zbývá uhradit / Outstanding: ${formatCurrency(Math.max(0, res.price - res.amountPaid))}`
      : "";

  const cancelled = res.isCancelled === true || (res.status ?? "").toLowerCase().startsWith("cancel");
  const bookingStateLine = cancelled
    ? "Rezervace byla zrušena. / This reservation has been cancelled."
    : "Rezervace je potvrzená a platná. / This reservation is confirmed and valid.";

  return `
  <!-- Payment + booking status -->
  <div style="padding:10px 20px 12px;border-top:1px solid #EFEAE4">
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Stav / Status</div>
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      ${chip ? `<span style="display:inline-block;border:1px solid ${chip.color};background:${chip.bg};color:${chip.color};font-size:11px;font-weight:bold;letter-spacing:0.4px;padding:3px 10px;border-radius:11px">${chip.text}</span>` : ""}
      ${methodLine ? `<span style="font-size:12px;color:${DARK_BROWN};font-weight:500">${methodLine}</span>` : ""}
    </div>
    ${outstandingLine ? `<div style="font-size:11px;color:${MID_BROWN};margin-top:5px">${outstandingLine}</div>` : ""}
    <div style="font-size:12px;color:${cancelled ? RED : MID_BROWN};margin-top:6px">${bookingStateLine}</div>
  </div>`;
}

export function buildInvoiceHTML(
  res: Reservation,
  invoiceData: InvoiceData,
  invoiceNum: string,
  payment?: { qrDataUrl: string; info: PaymentQRInfo },
  forEmail = false,
  modification?: InvoiceModification
): string {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });

  // ── Details grid cells ──────────────────────────────────────────────────────
  const cell = (label: string, value: string) => `
    <div>
      <div style="color:${GOLD};font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${label}</div>
      <div style="color:${DARK_BROWN};font-weight:500;font-size:13px">${value}</div>
    </div>`;

  let detailCells: string;
  if (modification) {
    const datesHtml = modification.dateRanges
      .map(r => `${shortDate(r.from)} – ${shortDate(r.to)}`)
      .join("<br/>");
    detailCells = [
      cell("Pokoj / Room", modification.room || res.room),
      cell("Datum / Dates", datesHtml),
      cell("Nocí / Nights", String(modification.numberOfNights)),
      cell("Hostů / Guests", String(modification.numberOfGuests)),
      cell("Rezervace / Booking", res.reservationNumber),
    ].join("");
  } else {
    detailCells = [
      cell("Pokoj / Room", res.room),
      cell("Příjezd / Check-in", formatDate(res.checkInDate)),
      cell("Odjezd / Check-out", formatDate(res.checkOutDate)),
      cell("Nocí / Nights", String(res.numberOfNights)),
      cell("Hostů / Guests", String(res.numberOfGuests)),
      cell("Rezervace / Booking", res.reservationNumber),
    ].join("");
  }

  // Resolve overridable line-item bits (defaults to Beds24-derived values).
  const guestNameLine = modification?.guestName?.trim()
    || `${res.firstName} ${res.lastName}`.trim();
  const lineDescription = modification?.lineDescription?.trim()
    || "Ubytování / Accommodation";

  // Invoice total: a modification may override the amount (self-contained to
  // this invoice — never touches res.price / the booking). Falls back to the
  // booking price when no override is set.
  const invoiceTotal = modification?.amount != null ? modification.amount : res.price;

  // ── Line items ──────────────────────────────────────────────────────────────
  let lineItemsHtml: string;
  if (modification && modification.dateRanges.length > 0) {
    const totalNights = modification.numberOfNights > 0 ? modification.numberOfNights : 1;
    const avgPPN = invoiceTotal / totalNights; // price per night (average)

    // Distribute the invoice total across ranges; last range absorbs rounding
    const ranges = modification.dateRanges;
    const nightsList = ranges.map(r => nightsBetween(r.from, r.to));
    const linePrices: number[] = [];
    for (let i = 0; i < ranges.length; i++) {
      if (i === ranges.length - 1) {
        const sumSoFar = linePrices.reduce((s, v) => s + v, 0);
        linePrices.push(invoiceTotal - sumSoFar);
      } else {
        linePrices.push(Math.round(nightsList[i] * avgPPN));
      }
    }

    lineItemsHtml = ranges.map((r, i) => {
      const isLast = i === ranges.length - 1;
      const borderStyle = isLast ? "border-bottom:1px solid #EFEAE4" : "border-bottom:1px solid #f0ebe4";
      return `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;padding-bottom:6px;margin-bottom:${isLast ? "0" : "4px"};${borderStyle};font-size:13px">
      <span>${lineDescription}<br/><span style="font-size:11px;color:${MID_BROWN}">${guestNameLine} · ${shortDate(r.from)} – ${shortDate(r.to)}</span></span>
      <span style="text-align:right;min-width:40px">${nightsList[i]}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(avgPPN)}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(linePrices[i])}</span>
    </div>`;
    }).join("");
  } else {
    const unitPrice = res.numberOfNights > 0 ? res.price / res.numberOfNights : res.price;
    lineItemsHtml = `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;padding-bottom:8px;border-bottom:1px solid #EFEAE4;font-size:13px">
      <span>${lineDescription}<br/><span style="font-size:11px;color:${MID_BROWN}">${guestNameLine}</span></span>
      <span style="text-align:right;min-width:40px">${res.numberOfNights}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(unitPrice)}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(res.price)}</span>
    </div>`;
  }

  // ── Payment + booking status band ──────────────────────────────────────────
  const statusBandHtml = buildStatusBandHTML(res, modification);

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>${invoiceNum}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #fff; color: ${DARK_BROWN}; }
    .invoice { max-width: 720px; margin: 0 auto; padding: 0; }
    @media print {
      body { margin: 0; }
      .invoice { max-width: 100%; }
    }
    @page { size: A4; margin: 14mm 18mm; }
  </style>
  ${!forEmail ? `<script>
    document.fonts.ready.then(function() {
      window.print();
      window.addEventListener('afterprint', function() { window.close(); });
    });
  </script>` : ''}
</head>
<body>
<div class="invoice">

  <!-- Brand -->
  <div style="font-family:'Great Vibes',cursive;font-size:52px;color:${GOLD};text-align:center;padding:18px 24px 4px;line-height:1.1">
    Baker House Apartments
  </div>

  <!-- Provider + Invoice number -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${GOLD};padding:10px 20px 14px;gap:16px">
    <div style="flex:1">
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Dodavatel / Provider</div>
      <div style="font-weight:bold;font-size:13px">Truthseeker s.r.o.</div>
      <div style="color:${MID_BROWN};font-size:12px">Šumavská 493/10, 602 00 Brno</div>
      <div style="color:${MID_BROWN};font-size:12px">IČ: 19876106</div>
      <div style="font-style:italic;color:${GOLD};font-size:11px;margin-top:2px">Nejsme plátci DPH / Non-VAT payer</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:16px;font-weight:bold;margin-bottom:4px">FAKTURA č. / INVOICE No. ${invoiceNum}</div>
      <div style="color:${MID_BROWN};font-size:12px">Datum / Date: ${today}</div>
      <div style="color:${MID_BROWN};font-size:12px">Rezervace: #${res.reservationNumber}</div>
    </div>
  </div>

  <!-- Customer -->
  <div style="padding:12px 20px;border-bottom:1px solid #EFEAE4">
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Odběratel / Customer</div>
    <div style="font-weight:bold;font-size:13px">${invoiceData.companyName}</div>
    <div style="color:${MID_BROWN};font-size:12px">${invoiceData.companyAddress}</div>
    ${invoiceData.ico ? `<div style="color:${MID_BROWN};font-size:12px">IČO: ${invoiceData.ico}</div>` : ""}
    ${invoiceData.vatNumber ? `<div style="color:${MID_BROWN};font-size:12px">DIČ: ${invoiceData.vatNumber}</div>` : ""}
  </div>

  <!-- Booking details grid -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 20px;border-bottom:1px solid #EFEAE4;background:#fdfaf7">
    ${detailCells}
  </div>

  <!-- Line items -->
  <div style="padding:12px 20px">
    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;border-bottom:1px solid #d4c4b0;padding-bottom:5px;margin-bottom:6px;color:${GOLD};font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">
      <span>Popis / Description</span>
      <span style="text-align:right;min-width:40px">Nocí</span>
      <span style="text-align:right;min-width:80px">Cena / night</span>
      <span style="text-align:right;min-width:80px">Celkem</span>
    </div>
    ${lineItemsHtml}
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-weight:bold;font-size:15px">
      <span>Celkem / Total</span>
      <span style="color:${GOLD}">${formatCurrency(invoiceTotal)}</span>
    </div>
  </div>
${statusBandHtml}
  ${payment ? `
  <!-- Payment QR -->
  <div style="padding:12px 20px;border-top:1px solid #EFEAE4;display:flex;align-items:center;gap:16px;background:#fdfaf7">
    <div style="flex-shrink:0;background:#fff;padding:6px;border:1px solid #e8e0d6;border-radius:6px">
      <img src="${payment.qrDataUrl}" width="100" height="100" style="display:block" />
    </div>
    <div>
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platba / Payment</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">Číslo účtu: ${PAYMENT_ACCOUNT_DISPLAY}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">IBAN: ${PAYMENT_IBAN.replace(/(.{4})/g, "$1 ").trim()}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">SWIFT: ${PAYMENT_SWIFT}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">VS: ${payment.info.vs}</div>
      <div style="font-size:12px;color:${DARK_BROWN};font-weight:bold;margin-top:4px">
        Částka / Amount: ${Math.round(payment.info.amountCZK).toLocaleString("cs-CZ")} Kč
      </div>
    </div>
  </div>` : ""}

  <!-- Footer -->
  <div style="border-top:1px solid #EFEAE4;padding:14px 20px 16px;text-align:center;background:#fdfaf7">
    <div style="color:${MID_BROWN};margin-bottom:2px;font-size:11px">Děkujeme za Vaši návštěvu! / Thank you for your stay!</div>
    <div style="font-family:'Great Vibes',cursive;font-size:34px;color:${GOLD};line-height:1.2">Patrik &amp; Zuzana</div>
    <a href="https://www.bakerhouseapartments.cz" style="font-size:13px;color:${GOLD};font-weight:600;text-decoration:none;display:block;margin-top:4px">www.bakerhouseapartments.cz</a>
    ${invoiceData.billingEmail ? `<div style="font-size:10px;color:#aaa;margin-top:1px">Billing: ${invoiceData.billingEmail}</div>` : ""}
  </div>

</div>
</body>
</html>`;
}

export async function printInvoice(
  res: Reservation,
  invoiceData: InvoiceData,
  paymentQRInfo?: PaymentQRInfo,
  modification?: InvoiceModification
): Promise<void> {
  const invoiceNum = generateInvoiceNumber(res.reservationNumber);

  let payment: { qrDataUrl: string; info: PaymentQRInfo } | undefined;
  if (paymentQRInfo) {
    const qrDataUrl = await QRCodeLib.toDataURL(paymentQRInfo.spdString, {
      width: 200,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    payment = { qrDataUrl, info: paymentQRInfo };
  }

  const html = buildInvoiceHTML(res, invoiceData, invoiceNum, payment, false, modification);
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    alert("Pop-up blocked — please allow pop-ups for this page to print invoices.");
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
}
