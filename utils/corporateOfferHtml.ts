/**
 * Accommodation offer for a corporate agreement — the document the company
 * gets BEFORE anything is booked (or afterwards, as the written summary of
 * what was agreed). Pure HTML builder; the route renders it to PDF.
 *
 * Same visual language as the guest invoice (utils/invoiceUtils.ts): gold on
 * warm brown, bilingual Czech / English labels, Truthseeker s.r.o. as the
 * provider. Everything operator-entered is HTML-escaped — company names
 * routinely contain "&".
 */
import { describeNights } from './corporateSchedule';
import {
  BILLING_CADENCE_LABELS,
  type BillingCadence,
  type PricingMode,
} from './corporateShared';
import { SELLABLE_UNITS } from './stayRequest';

export interface OfferStay {
  seq: number;
  arrival: string;
  departure: string;
  nights: number;
  roomId: number;
  priceCzk: number | null;
}

export interface OfferInput {
  offerNumber: string;
  /** YYYY-MM-DD */
  issuedOn: string;
  /** YYYY-MM-DD */
  validUntil: string;
  companyName: string;
  companyAddress: string | null;
  ico: string | null;
  vatNumber: string | null;
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  startDate: string;
  endDate: string;
  nightWeekdays: number[];
  roomIds: number[];
  adults: number;
  children: number;
  pricingMode: PricingMode;
  flatNightPriceCzk: number | null;
  discountPercent: number;
  billingCadence: BillingCadence;
  notes: string | null;
  stays: OfferStay[];
}

export interface OfferTotals {
  stays: number;
  nights: number;
  priceCzk: number;
  unpriced: number;
  /** priceCzk ÷ nights over the PRICED stays only; null when nothing is priced. */
  avgNightCzk: number | null;
}

export function offerTotals(stays: OfferStay[]): OfferTotals {
  let nights = 0;
  let pricedNights = 0;
  let priceCzk = 0;
  let unpriced = 0;
  for (const s of stays) {
    nights += s.nights;
    if (s.priceCzk === null) unpriced += 1;
    else {
      priceCzk += s.priceCzk;
      pricedNights += s.nights;
    }
  }
  return {
    stays: stays.length,
    nights,
    priceCzk,
    unpriced,
    avgNightCzk: pricedNights > 0 ? Math.round(priceCzk / pricedNights) : null,
  };
}

export function escapeHtml(s: string | null | undefined): string {
  return (s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const GOLD = '#B08D57';
const DARK_BROWN = '#3B2F2F';
const MID_BROWN = '#6b5b4e';

const czk = (n: number) => `${Math.round(n).toLocaleString('cs-CZ')} Kč`;

/** "Mon 12 Oct 2026" — readable in both languages, no locale drift (UTC). */
export function offerDate(ymd: string): string {
  return new Date(`${ymd}T00:00:00Z`)
    .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .replace(',', '');
}

export function offerRoomLabel(roomId: number): string {
  return SELLABLE_UNITS.find((u) => u.roomId === roomId)?.label ?? `room ${roomId}`;
}

export function buildOfferHTML(input: OfferInput): string {
  const totals = offerTotals(input.stays);
  const types = Array.from(new Set([...input.roomIds, ...input.stays.map((s) => s.roomId)]));

  const rateLine =
    input.pricingMode === 'flat' && input.flatNightPriceCzk !== null
      ? `${czk(input.flatNightPriceCzk)} / noc · per night`
      : totals.avgNightCzk !== null
        ? `${czk(totals.avgNightCzk)} / noc · per night <span style="font-size:10px;color:${MID_BROWN}">(průměr / average${
            input.discountPercent > 0 ? `, −${input.discountPercent} % z webové ceny / off the web price` : ''
          })</span>`
        : 'na vyžádání / on request';

  const cell = (label: string, value: string) => `
    <div>
      <div style="color:${GOLD};font-size:9px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px">${label}</div>
      <div style="color:${DARK_BROWN};font-weight:500;font-size:13px">${value}</div>
    </div>`;

  const guests = `${input.adults} ${input.adults === 1 ? 'dospělý / adult' : 'dospělí / adults'}${
    input.children > 0 ? `, ${input.children} ${input.children === 1 ? 'dítě / child' : 'děti / children'}` : ''
  }`;

  const summaryCells = [
    cell('Období / Period', `${offerDate(input.startDate)} – ${offerDate(input.endDate)}`),
    cell('Noci v týdnu / Nights', escapeHtml(describeNights(input.nightWeekdays))),
    cell('Typ apartmánu / Apartment type', types.map((id) => escapeHtml(offerRoomLabel(id))).join('<br/>')),
    cell('Počet pobytů / Stays', String(totals.stays)),
    cell('Nocí celkem / Total nights', String(totals.nights)),
    cell('Cena za noc / Rate per night', rateLine),
    cell('Hostů / Guests', guests),
    cell('Fakturace / Invoicing', escapeHtml(BILLING_CADENCE_LABELS[input.billingCadence])),
  ].join('');

  const rows = input.stays
    .map((s, i) => {
      const last = i === input.stays.length - 1;
      return `<div style="display:grid;grid-template-columns:28px 1fr 1fr 48px 1.2fr 90px;gap:8px;padding:5px 0;border-bottom:1px solid ${last ? '#EFEAE4' : '#f0ebe4'};font-size:12px">
      <span style="color:${MID_BROWN}">${s.seq}</span>
      <span>${offerDate(s.arrival)}</span>
      <span>${offerDate(s.departure)}</span>
      <span style="text-align:right">${s.nights}</span>
      <span style="color:${MID_BROWN}">${escapeHtml(offerRoomLabel(s.roomId))}</span>
      <span style="text-align:right;font-weight:500">${s.priceCzk === null ? '<span style="color:#aaa">na vyžádání</span>' : czk(s.priceCzk)}</span>
    </div>`;
    })
    .join('');

  const contactBits = [input.contactName, input.contactPhone, input.contactEmail].filter(Boolean).map((v) => escapeHtml(v));

  return `<!DOCTYPE html>
<html lang="cs">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(input.offerNumber)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Great+Vibes&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: sans-serif; background: #fff; color: ${DARK_BROWN}; }
    .doc { max-width: 720px; margin: 0 auto; }
    @page { size: A4; margin: 14mm 18mm; }
  </style>
</head>
<body>
<div class="doc">

  <div style="font-family:'Great Vibes',cursive;font-size:52px;color:${GOLD};text-align:center;padding:18px 24px 4px;line-height:1.1">
    Baker House Apartments
  </div>

  <div style="display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid ${GOLD};padding:10px 20px 14px;gap:16px">
    <div style="flex:1">
      <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">Poskytovatel / Provider</div>
      <div style="font-weight:bold;font-size:13px">Truthseeker s.r.o.</div>
      <div style="color:${MID_BROWN};font-size:12px">Šumavská 493/10, 602 00 Brno</div>
      <div style="color:${MID_BROWN};font-size:12px">IČ: 19876106</div>
      <div style="font-style:italic;color:${GOLD};font-size:11px;margin-top:2px">Nejsme plátci DPH / Non-VAT payer</div>
    </div>
    <div style="text-align:right;flex-shrink:0">
      <div style="font-size:16px;font-weight:bold;margin-bottom:4px">NABÍDKA UBYTOVÁNÍ / ACCOMMODATION OFFER</div>
      <div style="color:${MID_BROWN};font-size:12px">č. / No. ${escapeHtml(input.offerNumber)}</div>
      <div style="color:${MID_BROWN};font-size:12px">Datum / Date: ${offerDate(input.issuedOn)}</div>
      <div style="color:${MID_BROWN};font-size:12px">Platnost do / Valid until: ${offerDate(input.validUntil)}</div>
    </div>
  </div>

  <div style="padding:12px 20px;border-bottom:1px solid #EFEAE4">
    <div style="color:${GOLD};font-weight:bold;font-size:10px;text-transform:uppercase;letter-spacing:1px;margin-bottom:5px">Odběratel / Customer</div>
    <div style="font-weight:bold;font-size:13px">${escapeHtml(input.companyName)}</div>
    ${input.companyAddress ? `<div style="color:${MID_BROWN};font-size:12px">${escapeHtml(input.companyAddress)}</div>` : ''}
    ${input.ico ? `<div style="color:${MID_BROWN};font-size:12px">IČO: ${escapeHtml(input.ico)}</div>` : ''}
    ${input.vatNumber ? `<div style="color:${MID_BROWN};font-size:12px">DIČ: ${escapeHtml(input.vatNumber)}</div>` : ''}
    ${contactBits.length > 0 ? `<div style="color:${MID_BROWN};font-size:12px;margin-top:3px">Kontakt / Contact: ${contactBits.join(' · ')}</div>` : ''}
  </div>

  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px 8px;padding:12px 20px;border-bottom:1px solid #EFEAE4;background:#fdfaf7">
    ${summaryCells}
  </div>

  <div style="padding:12px 20px">
    <div style="display:grid;grid-template-columns:28px 1fr 1fr 48px 1.2fr 90px;gap:8px;border-bottom:1px solid #d4c4b0;padding-bottom:5px;margin-bottom:4px;color:${GOLD};font-size:10px;font-weight:bold;text-transform:uppercase;letter-spacing:0.5px">
      <span>#</span>
      <span>Příjezd / Check-in</span>
      <span>Odjezd / Check-out</span>
      <span style="text-align:right">Nocí</span>
      <span>Apartmán / Apartment</span>
      <span style="text-align:right">Cena / Price</span>
    </div>
    ${rows}
    <div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:${MID_BROWN}">
      <span>${totals.stays} ${totals.stays === 1 ? 'pobyt / stay' : 'pobytů / stays'} · ${totals.nights} ${totals.nights === 1 ? 'noc / night' : 'nocí / nights'}${
        totals.avgNightCzk !== null ? ` · průměrně / average ${czk(totals.avgNightCzk)} / noc` : ''
      }</span>
      ${totals.unpriced > 0 ? `<span style="color:#aaa">${totals.unpriced} bez ceny / unpriced</span>` : ''}
    </div>
    <div style="display:flex;justify-content:space-between;margin-top:6px;font-weight:bold;font-size:15px">
      <span>Celkem / Total</span>
      <span style="color:${GOLD}">${czk(totals.priceCzk)}</span>
    </div>
  </div>

  <div style="padding:10px 20px 12px;border-top:1px solid #EFEAE4;font-size:11px;color:${MID_BROWN};line-height:1.5">
    <div>Platba na základě faktury / Payment by invoice — ${escapeHtml(BILLING_CADENCE_LABELS[input.billingCadence])}.</div>
    <div>Ceny jsou konečné; nejsme plátci DPH. / Prices are final; we are not VAT payers.</div>
    <div>Nabídka platí do ${offerDate(input.validUntil)} a podléhá dostupnosti v okamžiku potvrzení. / Offer valid until ${offerDate(input.validUntil)}, subject to availability at confirmation.</div>
    ${input.notes ? `<div style="margin-top:4px">${escapeHtml(input.notes)}</div>` : ''}
  </div>

  <div style="border-top:1px solid #EFEAE4;padding:14px 20px 16px;text-align:center;background:#fdfaf7">
    <div style="color:${MID_BROWN};margin-bottom:2px;font-size:11px">Těšíme se na Vaši návštěvu! / We look forward to welcoming you!</div>
    <div style="font-family:'Great Vibes',cursive;font-size:34px;color:${GOLD};line-height:1.2">Patrik &amp; Zuzana</div>
    <a href="https://www.bakerhouseapartments.cz" style="font-size:13px;color:${GOLD};font-weight:600;text-decoration:none;display:block;margin-top:4px">www.bakerhouseapartments.cz</a>
  </div>

</div>
</body>
</html>`;
}
