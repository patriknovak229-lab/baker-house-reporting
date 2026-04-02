import QRCodeLib from "qrcode";
import type { Reservation, InvoiceData } from "@/types/reservation";
import { formatDate, formatCurrency } from "./formatters";

const GOLD = "#B08D57";
const DARK_BROWN = "#3B2F2F";
const MID_BROWN = "#6b5b4e";

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

export function buildInvoiceHTML(
  res: Reservation,
  invoiceData: InvoiceData,
  invoiceNum: string,
  payment?: { qrDataUrl: string; info: PaymentQRInfo },
  forEmail = false
): string {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
  });
  const unitPrice = res.numberOfNights > 0 ? res.price / res.numberOfNights : res.price;

  const detailCells = [
    ["Pokoj / Room", res.room],
    ["Příjezd / Check-in", formatDate(res.checkInDate)],
    ["Odjezd / Check-out", formatDate(res.checkOutDate)],
    ["Nocí / Nights", String(res.numberOfNights)],
    ["Hostů / Guests", String(res.numberOfGuests)],
    ["Rezervace / Booking", res.reservationNumber],
  ].map(([label, value]) => `
    <div>
      <div style="color:${GOLD};font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${label}</div>
      <div style="color:${DARK_BROWN};font-weight:500;font-size:13px">${value}</div>
    </div>`).join("");

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
      <div style="font-size:16px;font-weight:bold;margin-bottom:4px">FAKTURA č. ${invoiceNum}</div>
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
    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;padding-bottom:8px;border-bottom:1px solid #EFEAE4;font-size:13px">
      <span>Ubytování / Accommodation</span>
      <span style="text-align:right;min-width:40px">${res.numberOfNights}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(unitPrice)}</span>
      <span style="text-align:right;min-width:80px">${formatCurrency(res.price)}</span>
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;font-weight:bold;font-size:15px">
      <span>Celkem / Total</span>
      <span style="color:${GOLD}">${formatCurrency(res.price)}</span>
    </div>
  </div>

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
    <div style="font-size:10px;color:#aaa;margin-top:2px">www.bakerhouseapartments.cz</div>
    ${invoiceData.billingEmail ? `<div style="font-size:10px;color:#aaa;margin-top:1px">Billing: ${invoiceData.billingEmail}</div>` : ""}
  </div>

</div>
</body>
</html>`;
}

export async function printInvoice(
  res: Reservation,
  invoiceData: InvoiceData,
  paymentQRInfo?: PaymentQRInfo
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

  const html = buildInvoiceHTML(res, invoiceData, invoiceNum, payment);
  const printWindow = window.open("", "_blank", "width=900,height=700");
  if (!printWindow) {
    alert("Pop-up blocked — please allow pop-ups for this page to print invoices.");
    return;
  }
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
}
