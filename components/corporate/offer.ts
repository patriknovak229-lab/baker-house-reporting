/**
 * Client side of the offer PDF: build the request from either the unsaved
 * preview or a saved agreement, POST it, and hand the browser the file.
 */
import type { OfferInput } from '@/utils/corporateOfferHtml';
import { countsTowardsAgreement, type AgreementDetail } from '@/utils/corporateShared';

/** What the client sends — the server adds number, dates and validity. */
export type OfferPayload = Omit<OfferInput, 'offerNumber' | 'issuedOn' | 'validUntil'>;

export function offerFromAgreement(a: AgreementDetail): OfferPayload {
  return {
    companyName: a.companyName,
    companyAddress: a.companyAddress,
    ico: a.ico,
    vatNumber: a.vatNumber,
    contactName: a.repName,
    contactPhone: a.repPhone,
    contactEmail: a.repEmail ?? a.billingEmail,
    startDate: a.startDate,
    endDate: a.endDate,
    nightWeekdays: a.nightWeekdays,
    roomIds: a.roomIds,
    adults: a.adults,
    children: a.children,
    pricingMode: a.pricingMode,
    flatNightPriceCzk: a.flatNightPriceCzk,
    discountPercent: a.discountPercent,
    billingCadence: a.billingCadence,
    notes: a.notes,
    stays: a.stays
      .filter((s) => countsTowardsAgreement(s.status))
      .map((s) => ({ seq: s.seq, arrival: s.arrival, departure: s.departure, nights: s.nights, roomId: s.roomId, priceCzk: s.priceCzk })),
  };
}

/** POST the offer and trigger a download. Throws with the server's message on failure. */
export async function downloadOfferPdf(offer: OfferPayload, agreementId?: string): Promise<void> {
  const res = await fetch('/api/corporate/offer-pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agreementId, offer }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error ?? `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') ?? '';
  const match = disposition.match(/filename="([^"]+)"/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match?.[1] ?? `Offer_${offer.startDate}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
