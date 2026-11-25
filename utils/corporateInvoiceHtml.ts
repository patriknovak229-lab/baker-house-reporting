/**
 * The corporate invoice document — one invoice covering several stays (a
 * month of a long stay, or a whole agreement). Pure HTML builder; the server
 * renders it to PDF, the detail panel previews it as HTML.
 *
 * Same visual language as the guest invoice (utils/invoiceUtils.ts) and the
 * offer (utils/corporateOfferHtml.ts): gold on warm brown, bilingual labels,
 * Truthseeker s.r.o. as the provider, non-VAT payer. Unlike the guest invoice
 * it is paid by bank transfer AFTER it arrives, so it states the issue and due
 * dates and, by default, the payment block (account, VS, QR).
 *
 * Everything that comes from an operator or a company is HTML-escaped.
 */
import { escapeHtml, offerDate, offerRoomLabel } from './corporateOfferHtml';
import { formatCurrencyExact } from './formatters';
import { PAYMENT_ACCOUNT_DISPLAY, PAYMENT_IBAN, PAYMENT_SWIFT } from './invoiceUtils';
import { monthLabelBilingual, variableSymbol, type CorporateBillTo, type CorporateInvoiceLine } from './corporateInvoice';

const GOLD = '#B08D57';
const DARK_BROWN = '#3B2F2F';
const MID_BROWN = '#6b5b4e';

export interface CorporateInvoiceDoc {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  periodFrom: string;
  /** Last night, inclusive. */
  periodTo: string;
  billedMonth: string | null;
  agreementId: string;
  billTo: CorporateBillTo;
  lines: CorporateInvoiceLine[];
  totalCzk: number;
  /** Bank details + QR. `qrDataUrl` is rendered by the caller (qrcode lib). */
  payment: { qrDataUrl: string | null } | null;
  /** Watermark for an HTML preview of an invoice that isn't issued yet. */
  draft?: boolean;
}

/** "SPD*1.0*…" — the Czech QR payment string banking apps read. */
export function corporateSpdString(invoiceNumber: string, amountCzk: number): string {
  return `SPD*1.0*ACC:${PAYMENT_IBAN}*AM:${amountCzk.toFixed(2)}*CC:CZK*VS:${variableSymbol(invoiceNumber)}*MSG:Baker House Apartments`;
}

export function buildCorporateInvoiceHTML(doc: CorporateInvoiceDoc): string {
  const nights = doc.lines.reduce((n, l) => n + l.nights, 0);
  const vs = variableSymbol(doc.invoiceNumber);
  // The period is stated in NIGHTS (first – last night); the lines below use
  // arrival – departure like any stay, which is what "part of stay" refers to.
  const nightsRange = `${offerDate(doc.periodFrom)} – ${offerDate(doc.periodTo)} <span style="font-size:10px;color:${MID_BROWN}">(noci / nights)</span>`;
  const periodLabel = doc.billedMonth
    ? `${monthLabelBilingual(doc.billedMonth)}<br/><span style="font-size:11px;color:${MID_BROWN}">${nightsRange}</span>`
    : nightsRange;

  const cell = (label: string, value: string) => `
    <div>
      <div style="color:${GOLD};font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${label}</div>
      <div style="color:${DARK_BROWN};font-weight:500;font-size:13px">${value}</div>
    </div>`;

  const detailCells = [
    cell('Období / Period', periodLabel),
    cell('Nocí / Nights', String(nights)),
    cell('Pobytů / Stays', String(doc.lines.length)),
    cell('Datum vystavení / Issued', offerDate(doc.issueDate)),
    cell('Datum splatnosti / Due', `<span style="color:${GOLD};font-weight:bold">${offerDate(doc.dueDate)}</span>`),
    cell('Forma úhrady / Payment', 'Bankovní převod / Bank transfer'),
  ].join('');

  const lineRows = doc.lines
    .map((l, i) => {
      const last = i === doc.lines.length - 1;
      const perNight = l.nights > 0 ? l.amountCzk / l.nights : l.amountCzk;
      const partial = l.nights !== l.stayNights;
      const sub = [
        l.guestName ? escapeHtml(l.guestName) : '',
        `${offerDate(l.from)} – ${offerDate(l.until)}`,
        l.reservationNumber ? escapeHtml(l.reservationNumber) : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const partOf = partial
        ? `<br/><span style="font-size:10px;color:#a3968a">část pobytu / part of stay ${offerDate(l.stayArrival)} – ${offerDate(l.stayDeparture)} (${l.stayNights} nocí / nights)</span>`
        : '';
      return `<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;padding:6px 0;border-bottom:1px solid ${last ? '#EFEAE4' : '#f0ebe4'};font-size:13px">
      <span>Ubytování / Accommodation — ${escapeHtml(offerRoomLabel(l.roomId))}<br/><span style="font-size:11px;color:${MID_BROWN}">${sub}</span>${partOf}</span>
      <span style="text-align:right;min-width:40px">${l.nights}</span>
      <span style="text-align:right;min-width:90px">${formatCurrencyExact(perNight)}</span>
      <span style="text-align:right;min-width:90px">${formatCurrencyExact(l.amountCzk)}</span>
    </div>`;
    })
    .join('');

  const b = doc.billTo;
  const paymentBlock = doc.payment
    ? `
  <div style="padding:12px 20px;border-top:1px solid #EFEAE4;display:flex;align-items:center;gap:16px;background:#fdfaf7">
    ${
      doc.payment.qrDataUrl
        ? `<div style="flex-shrink:0;background:#fff;padding:6px;border:1px solid #e8e0d6;border-radius:6px"><img src="${doc.payment.qrDataUrl}" width="100" height="100" style="display:block" /></div>`
        : ''
    }
    <div>
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Platební údaje / Payment details</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">Číslo účtu / Account: ${PAYMENT_ACCOUNT_DISPLAY}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">IBAN: ${PAYMENT_IBAN.replace(/(.{4})/g, '$1 ').trim()} · SWIFT: ${PAYMENT_SWIFT}</div>
      <div style="font-size:11px;color:${MID_BROWN};margin-bottom:2px">Variabilní symbol / Variable symbol: <b style="color:${DARK_BROWN}">${vs}</b></div>
      <div style="font-size:12px;color:${DARK_BROWN};font-weight:bold;margin-top:4px">
        Částka / Amount: ${formatCurrencyExact(doc.totalCzk)} · splatnost / due ${offerDate(doc.dueDate)}
      </div>
    </div>
  </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(doc.invoiceNumber)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #fff; color: ${DARK_BROWN}; }
    .invoice { max-width: 720px; margin: 0 auto; position: relative; }
    @page { size: A4; margin: 14mm 18mm; }
  </style>
</head>
<body>
<div class="invoice">
  ${
    doc.draft
      ? `<div style="position:absolute;top:220px;left:0;right:0;text-align:center;font-size:72px;font-weight:bold;color:rgba(176,141,87,0.13);transform:rotate(-18deg);pointer-events:none">NÁHLED / PREVIEW</div>`
      : ''
  }

  <div style="font-family:'Great Vibes',cursive;font-size:52px;color:${GOLD};text-align:center;padding:18px 24px 4px;line-height:1.1">
    Baker House Apartments
  </div>

  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${GOLD};padding:10px 20px 14px;gap:16px">
    <div style="flex:1">
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Dodavatel / Provider</div>
      <div style="font-weight:bold;font-size:13px">Truthseeker s.r.o.</div>
      <div style="color:${MID_BROWN};font-size:12px">Šumavská 493/10, 602 00 Brno</div>
      <div style="color:${MID_BROWN};font-size:12px">IČ: 19876106</div>
      <div style="font-style:italic;color:${GOLD};font-size:11px;margin-top:2px">Nejsme plátci DPH / Non-VAT payer</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:16px;font-weight:bold;margin-bottom:4px">FAKTURA č. / INVOICE No. ${escapeHtml(doc.invoiceNumber)}</div>
      <div style="color:${MID_BROWN};font-size:12px">Datum vystavení / Issue date: ${offerDate(doc.issueDate)}</div>
      <div style="color:${MID_BROWN};font-size:12px">Datum splatnosti / Due date: ${offerDate(doc.dueDate)}</div>
      <div style="color:${MID_BROWN};font-size:12px">VS: ${vs}</div>
    </div>
  </div>

  <div style="padding:12px 20px;border-bottom:1px solid #EFEAE4">
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Odběratel / Customer</div>
    <div style="font-weight:bold;font-size:13px">${escapeHtml(b.companyName)}</div>
    ${b.companyAddress ? `<div style="color:${MID_BROWN};font-size:12px">${escapeHtml(b.companyAddress)}</div>` : ''}
    ${b.ico ? `<div style="color:${MID_BROWN};font-size:12px">IČO: ${escapeHtml(b.ico)}</div>` : ''}
    ${b.vatNumber ? `<div style="color:${MID_BROWN};font-size:12px">DIČ: ${escapeHtml(b.vatNumber)}</div>` : ''}
  </div>

  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px 8px;padding:12px 20px;border-bottom:1px solid #EFEAE4;background:#fdfaf7">
    ${detailCells}
  </div>

  <div style="padding:12px 20px">
    <div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;border-bottom:1px solid #d4c4b0;padding-bottom:5px;margin-bottom:4px;color:${GOLD};font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">
      <span>Popis / Description</span>
      <span style="text-align:right;min-width:40px">Nocí</span>
      <span style="text-align:right;min-width:90px">Cena / night</span>
      <span style="text-align:right;min-width:90px">Celkem</span>
    </div>
    ${lineRows}
    <div style="display:flex;justify-content:space-between;margin-top:10px;font-weight:bold;font-size:15px">
      <span>Celkem k úhradě / Total due</span>
      <span style="color:${GOLD}">${formatCurrencyExact(doc.totalCzk)}</span>
    </div>
  </div>
${paymentBlock}
  <div style="padding:10px 20px 12px;border-top:1px solid #EFEAE4;font-size:11px;color:${MID_BROWN};line-height:1.5">
    <div>Dodavatel není plátcem DPH. / The provider is not a VAT payer.</div>
    <div>Ref.: ${escapeHtml(doc.agreementId)}</div>
  </div>

  <div style="border-top:1px solid #EFEAE4;padding:14px 20px 16px;text-align:center;background:#fdfaf7">
    <div style="color:${MID_BROWN};margin-bottom:2px;font-size:11px">Děkujeme za spolupráci! / Thank you for your business!</div>
    <div style="font-family:'Great Vibes',cursive;font-size:34px;color:${GOLD};line-height:1.2">Patrik &amp; Zuzana</div>
    <a href="https://www.bakerhouseapartments.cz" style="font-size:13px;color:${GOLD};font-weight:600;text-decoration:none;display:block;margin-top:4px">www.bakerhouseapartments.cz</a>
    ${b.billingEmail ? `<div style="font-size:10px;color:#aaa;margin-top:1px">Billing: ${escapeHtml(b.billingEmail)}</div>` : ''}
  </div>

</div>
</body>
</html>`;
}
