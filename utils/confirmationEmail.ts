/**
 * Reservation-confirmation email builder.
 *
 * Mirrors the visual vocabulary of buildInvoiceHTML (gold + brown palette,
 * Great Vibes script for the brand line, Patrik & Zuzana sign-off, same
 * footer link to bakerhouseapartments.cz) so a guest receiving both messages
 * sees a consistent brand.
 *
 * Stays bilingual Czech / English to match the invoice; the operator can
 * forward this to any guest regardless of their language.
 */

import type { Reservation } from "@/types/reservation";
import { formatDate, formatCurrency } from "./formatters";
import {
  PAYMENT_IBAN,
  PAYMENT_SWIFT,
  PAYMENT_ACCOUNT_DISPLAY,
} from "./invoiceUtils";

const GOLD = "#B08D57";
const DARK_BROWN = "#3B2F2F";
const MID_BROWN = "#6b5b4e";

/**
 * Decide what to put in the Payment block of the confirmation:
 *  - OTA bookings (Booking.com / Airbnb)  → "Pre-paid via {channel}"
 *  - Stripe-paid (Direct-Web / Direct-Phone) when paymentStatus === Paid → "Paid in full · thank you"
 *  - Partially paid → show received vs outstanding + bank info
 *  - Unpaid (Direct) → bank info + total to transfer
 */
function buildPaymentBlock(res: Reservation): string {
  const isOTA = res.channel === "Booking.com" || res.channel === "Airbnb";
  if (isOTA) {
    return `
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platba / Payment</div>
      <div style="font-size:13px;color:${DARK_BROWN};font-weight:600">Pre-paid via ${res.channel}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-top:2px">No further action needed — payment was handled by ${res.channel}.</div>
    `;
  }

  if (res.paymentStatus === "Paid") {
    return `
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platba / Payment</div>
      <div style="font-size:14px;color:#0f7c4a;font-weight:600">✓ Paid in full</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-top:2px">Thank you — your reservation is fully paid.</div>
    `;
  }

  if (res.paymentStatus === "Partially Paid") {
    const outstanding = Math.max(0, res.price - res.amountPaid);
    return `
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platba / Payment</div>
      <div style="font-size:13px;color:${DARK_BROWN};font-weight:600">Partially paid</div>
      <div style="font-size:12px;color:${MID_BROWN};margin-top:4px">Received: <strong>${formatCurrency(res.amountPaid)}</strong></div>
      <div style="font-size:12px;color:${MID_BROWN};margin-bottom:8px">Outstanding: <strong>${formatCurrency(outstanding)}</strong></div>
      <div style="font-size:11px;color:${MID_BROWN};line-height:1.5">
        Please transfer the outstanding balance to:<br/>
        <strong>Account:</strong> ${PAYMENT_ACCOUNT_DISPLAY}<br/>
        <strong>IBAN:</strong> ${PAYMENT_IBAN.replace(/(.{4})/g, "$1 ").trim()}<br/>
        <strong>SWIFT:</strong> ${PAYMENT_SWIFT}
      </div>
    `;
  }

  // Unpaid direct booking
  return `
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platba / Payment</div>
    <div style="font-size:13px;color:${DARK_BROWN};font-weight:600">Awaiting payment</div>
    <div style="font-size:12px;color:${MID_BROWN};margin-top:4px;margin-bottom:8px">Total: <strong>${formatCurrency(res.price)}</strong></div>
    <div style="font-size:11px;color:${MID_BROWN};line-height:1.5">
      Please transfer to:<br/>
      <strong>Account:</strong> ${PAYMENT_ACCOUNT_DISPLAY}<br/>
      <strong>IBAN:</strong> ${PAYMENT_IBAN.replace(/(.{4})/g, "$1 ").trim()}<br/>
      <strong>SWIFT:</strong> ${PAYMENT_SWIFT}
    </div>
  `;
}

/** Bilingual cell for the booking-details grid. */
function detailCell(label: string, value: string): string {
  return `
    <div>
      <div style="color:${GOLD};font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${label}</div>
      <div style="color:${DARK_BROWN};font-weight:500;font-size:13px">${value}</div>
    </div>`;
}

export function buildConfirmationHTML(res: Reservation): string {
  const today = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
  const guestFullName = `${res.firstName} ${res.lastName}`.trim() || "Guest";
  const nightsLabel = `${res.numberOfNights} night${res.numberOfNights === 1 ? "" : "s"}`;
  const guestsLabel = `${res.numberOfGuests} guest${res.numberOfGuests === 1 ? "" : "s"}`;

  const detailCells = [
    detailCell("Pokoj / Room", res.room),
    detailCell("Příjezd / Check-in", formatDate(res.checkInDate)),
    detailCell("Odjezd / Check-out", formatDate(res.checkOutDate)),
    detailCell("Nocí / Nights", String(res.numberOfNights)),
    detailCell("Hostů / Guests", String(res.numberOfGuests)),
    detailCell("Rezervace / Booking", res.reservationNumber),
  ].join("");

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>Reservation Confirmation — ${res.reservationNumber}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #fff; color: ${DARK_BROWN}; }
    .confirmation { max-width: 720px; margin: 0 auto; padding: 0; }
  </style>
</head>
<body>
<div class="confirmation">

  <!-- Brand -->
  <div style="font-family:'Great Vibes',cursive;font-size:52px;color:${GOLD};text-align:center;padding:18px 24px 4px;line-height:1.1">
    Baker House Apartments
  </div>

  <!-- Heading -->
  <div style="border-bottom:2px solid ${GOLD};padding:10px 20px 14px;text-align:center">
    <div style="font-size:18px;font-weight:bold;letter-spacing:0.5px">Potvrzení Rezervace / Reservation Confirmation</div>
    <div style="color:${MID_BROWN};font-size:12px;margin-top:4px">Datum / Date: ${today}</div>
  </div>

  <!-- Greeting -->
  <div style="padding:14px 20px;border-bottom:1px solid #EFEAE4">
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Host / Guest</div>
    <div style="font-weight:bold;font-size:14px">${guestFullName}</div>
    <div style="color:${MID_BROWN};font-size:12px;margin-top:2px">${nightsLabel} · ${guestsLabel}</div>
    <div style="color:${MID_BROWN};font-size:12px;margin-top:8px;line-height:1.5">
      Děkujeme za Vaši rezervaci. Níže najdete shrnutí Vašeho pobytu.<br/>
      <span style="font-style:italic">Thank you for your reservation. Below is a summary of your stay.</span>
    </div>
  </div>

  <!-- Booking details grid -->
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 20px;border-bottom:1px solid #EFEAE4;background:#fdfaf7">
    ${detailCells}
  </div>

  <!-- Total price -->
  <div style="padding:14px 20px;border-bottom:1px solid #EFEAE4;display:flex;justify-content:space-between;align-items:center">
    <div>
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:3px">Celková cena / Total Price</div>
      <div style="color:${MID_BROWN};font-size:11px">${nightsLabel}, ${guestsLabel}, ${res.room}</div>
    </div>
    <div style="font-size:22px;font-weight:bold;color:${GOLD}">${formatCurrency(res.price)}</div>
  </div>

  <!-- Payment info -->
  <div style="padding:14px 20px;border-bottom:1px solid #EFEAE4;background:#fdfaf7">
    ${buildPaymentBlock(res)}
  </div>

  <!-- Closing -->
  <div style="padding:14px 20px;border-bottom:1px solid #EFEAE4">
    <div style="color:${MID_BROWN};font-size:12px;line-height:1.55">
      Těšíme se na Vaši návštěvu. V případě jakýchkoli dotazů nás neváhejte kontaktovat.<br/>
      <span style="font-style:italic">We look forward to your stay. Please don't hesitate to contact us with any questions.</span>
    </div>
  </div>

  <!-- Footer -->
  <div style="padding:14px 20px 16px;text-align:center;background:#fdfaf7">
    <div style="color:${MID_BROWN};margin-bottom:2px;font-size:11px">S pozdravem / Warm regards,</div>
    <div style="font-family:'Great Vibes',cursive;font-size:34px;color:${GOLD};line-height:1.2">Patrik &amp; Zuzana</div>
    <a href="https://www.bakerhouseapartments.cz" style="font-size:13px;color:${GOLD};font-weight:600;text-decoration:none;display:block;margin-top:4px">www.bakerhouseapartments.cz</a>
  </div>

</div>
</body>
</html>`;
}

/** Plaintext fallback for email clients that don't render HTML. */
export function buildConfirmationText(res: Reservation): string {
  const guestFullName = `${res.firstName} ${res.lastName}`.trim() || "Guest";
  const lines = [
    `Dear ${guestFullName},`,
    "",
    "Thank you for your reservation at Baker House Apartments. Here is your booking summary:",
    "",
    `Reservation:  ${res.reservationNumber}`,
    `Room:         ${res.room}`,
    `Check-in:     ${formatDate(res.checkInDate)}`,
    `Check-out:    ${formatDate(res.checkOutDate)}`,
    `Nights:       ${res.numberOfNights}`,
    `Guests:       ${res.numberOfGuests}`,
    `Total price:  ${formatCurrency(res.price)}`,
    "",
  ];

  const isOTA = res.channel === "Booking.com" || res.channel === "Airbnb";
  if (isOTA) {
    lines.push(`Payment: Pre-paid via ${res.channel}. No further action needed.`);
  } else if (res.paymentStatus === "Paid") {
    lines.push("Payment: Paid in full — thank you.");
  } else if (res.paymentStatus === "Partially Paid") {
    const outstanding = Math.max(0, res.price - res.amountPaid);
    lines.push(`Payment: Partially paid (received ${formatCurrency(res.amountPaid)} · outstanding ${formatCurrency(outstanding)}).`);
    lines.push(`         Please transfer the outstanding balance to: ${PAYMENT_ACCOUNT_DISPLAY} · IBAN ${PAYMENT_IBAN} · SWIFT ${PAYMENT_SWIFT}`);
  } else {
    lines.push(`Payment: Awaiting payment of ${formatCurrency(res.price)}.`);
    lines.push(`         Please transfer to: ${PAYMENT_ACCOUNT_DISPLAY} · IBAN ${PAYMENT_IBAN} · SWIFT ${PAYMENT_SWIFT}`);
  }

  lines.push(
    "",
    "We look forward to your stay.",
    "",
    "Patrik & Zuzana",
    "Baker House Apartments",
    "https://www.bakerhouseapartments.cz",
  );
  return lines.join("\n");
}
