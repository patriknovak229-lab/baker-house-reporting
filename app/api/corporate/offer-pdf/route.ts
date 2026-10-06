/**
 * POST /api/corporate/offer-pdf — render an accommodation offer to PDF.
 *
 * Body: { agreementId?: string; validUntil?: 'YYYY-MM-DD'; offer: {
 *   companyName, companyAddress?, ico?, vatNumber?, contactName?, contactPhone?,
 *   contactEmail?, startDate, endDate, nightWeekdays, roomIds, adults, children,
 *   pricingMode, flatNightPriceCzk?, discountPercent, billingCadence, notes?,
 *   stays: [{ seq, arrival, departure, nights, roomId, priceCzk | null }]
 * } }
 *
 * Stateless on purpose: the preview can produce an offer BEFORE the agreement
 * is saved (the company asked for a quote on the phone), and the detail view
 * produces the same document from a saved one. Nothing is stored.
 *
 * Listed in CHROMIUM_ROUTES (next.config.ts) — any route that launches
 * Chromium must be, or it deploys without a browser. utils/pdfTracing.test.ts
 * enforces that.
 *
 * Auth: admin.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { generatePDF } from '@/utils/pdfGenerate';
import { buildOfferHTML, type OfferInput, type OfferStay } from '@/utils/corporateOfferHtml';
import { addDays, isYmd, nightsBetween } from '@/utils/corporateSchedule';
import { BILLING_CADENCES, PRICING_MODES, SELLABLE_ROOM_IDS, optNum, optStr } from '@/utils/corporateInput';
import { pragueToday } from '@/utils/periodUtils';
import type { BillingCadence, PricingMode } from '@/utils/corporateShared';

export const maxDuration = 60;

const MAX_STAYS = 120;
const DEFAULT_VALID_DAYS = 14;

export async function POST(req: NextRequest) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let body: { agreementId?: unknown; validUntil?: unknown; offer?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const o = (body.offer ?? {}) as Record<string, unknown>;

  const companyName = optStr(o.companyName, 200);
  if (!companyName) return NextResponse.json({ error: 'Company name is required' }, { status: 400 });

  const startDate = optStr(o.startDate, 10);
  const endDate = optStr(o.endDate, 10);
  if (!isYmd(startDate) || !isYmd(endDate)) return NextResponse.json({ error: 'startDate and endDate must be YYYY-MM-DD' }, { status: 400 });

  const pricingMode = optStr(o.pricingMode) as PricingMode | null;
  if (!pricingMode || !PRICING_MODES.includes(pricingMode)) return NextResponse.json({ error: 'pricingMode must be flat or dynamic' }, { status: 400 });

  const billingCadence = (optStr(o.billingCadence) ?? 'per_stay') as BillingCadence;
  if (!BILLING_CADENCES.includes(billingCadence)) return NextResponse.json({ error: 'Unknown billing cadence' }, { status: 400 });

  if (!Array.isArray(o.stays) || o.stays.length === 0) return NextResponse.json({ error: 'At least one stay is required' }, { status: 400 });
  if (o.stays.length > MAX_STAYS) return NextResponse.json({ error: `At most ${MAX_STAYS} stays` }, { status: 400 });

  const stays: OfferStay[] = [];
  for (const raw of o.stays) {
    const s = (raw ?? {}) as Record<string, unknown>;
    const arrival = optStr(s.arrival, 10);
    const departure = optStr(s.departure, 10);
    const roomId = optNum(s.roomId);
    if (!isYmd(arrival) || !isYmd(departure) || nightsBetween(arrival, departure) <= 0) {
      return NextResponse.json({ error: 'Each stay needs arrival < departure as YYYY-MM-DD' }, { status: 400 });
    }
    if (roomId === null || !SELLABLE_ROOM_IDS.has(roomId)) {
      return NextResponse.json({ error: `Stay ${s.seq ?? '?'}: unknown room type` }, { status: 400 });
    }
    const price = optNum(s.priceCzk);
    stays.push({
      seq: optNum(s.seq) ?? stays.length + 1,
      arrival,
      departure,
      nights: nightsBetween(arrival, departure),
      roomId,
      priceCzk: price === null || price < 0 ? null : Math.round(price),
    });
  }

  const roomIds = Array.isArray(o.roomIds) ? o.roomIds.map((v) => optNum(v)).filter((n): n is number => n !== null && SELLABLE_ROOM_IDS.has(n)) : [];
  const nightWeekdays = Array.isArray(o.nightWeekdays) ? o.nightWeekdays.map((v) => optNum(v)).filter((n): n is number => n !== null && n >= 1 && n <= 7) : [];

  const today = pragueToday();
  const validUntilRaw = optStr(body.validUntil, 10);
  const validUntil = isYmd(validUntilRaw) && validUntilRaw >= today ? validUntilRaw : addDays(today, DEFAULT_VALID_DAYS);
  const agreementId = optStr(body.agreementId, 40);
  const suffix = agreementId ? agreementId.replace(/^CA-/, '') : Math.random().toString(36).slice(2, 6);
  const offerNumber = `OFF-${today.replace(/-/g, '')}-${suffix}`;

  const input: OfferInput = {
    offerNumber,
    issuedOn: today,
    validUntil,
    companyName,
    companyAddress: optStr(o.companyAddress),
    ico: optStr(o.ico, 32),
    vatNumber: optStr(o.vatNumber, 32),
    contactName: optStr(o.contactName, 200),
    contactPhone: optStr(o.contactPhone, 50),
    contactEmail: optStr(o.contactEmail, 200),
    startDate,
    endDate,
    nightWeekdays,
    roomIds,
    adults: Math.max(1, Math.round(optNum(o.adults) ?? 1)),
    children: Math.max(0, Math.round(optNum(o.children) ?? 0)),
    pricingMode,
    flatNightPriceCzk: optNum(o.flatNightPriceCzk),
    discountPercent: Math.min(100, Math.max(0, optNum(o.discountPercent) ?? 0)),
    billingCadence,
    notes: optStr(o.notes, 2000),
    stays,
  };

  try {
    const pdf = await generatePDF(buildOfferHTML(input));
    const slug = companyName.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'offer';
    const filename = `Offer_${slug}_${startDate}.pdf`;
    return new NextResponse(pdf as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'X-Offer-Number': offerNumber,
      },
    });
  } catch (err) {
    console.error('[corporate] offer PDF failed:', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'PDF generation failed' }, { status: 500 });
  }
}
