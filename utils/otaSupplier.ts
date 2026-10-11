/**
 * Booking.com and Airbnb are paid through their settlement reports: importing a
 * report (Revenue → OTA settlements) books the gross revenue AND the commission
 * as a settlement-owned cost record. Their monthly commission invoices
 * (Booking "FAKTURA", Airbnb fee invoices) must therefore never become supplier
 * invoices of their own — they would count the commission twice.
 */

/** Supplier names that belong to an OTA channel */
export const OTA_SUPPLIER_RE = /booking[\s.]?com|airbnb/i;

/** VAT ids printed on OTA invoices (Booking.com B.V.) — catches a mis-read name */
const OTA_VAT_IDS = new Set(['NL805734958B01']);

export function isOtaSupplier(name?: string | null, icoOrVatId?: string | null): boolean {
  if (name && OTA_SUPPLIER_RE.test(name)) return true;
  const id = (icoOrVatId ?? '').replace(/\s/g, '').toUpperCase();
  return id !== '' && OTA_VAT_IDS.has(id);
}

/** Sender domains of OTA mail (commission invoices, statements) */
const OTA_SENDER_DOMAINS = ['booking.com', 'airbnb.com'];
/** Gmail search fragments: match any OTA sender / exclude every OTA sender */
export const OTA_SENDERS_QUERY = `{${OTA_SENDER_DOMAINS.map((d) => `from:${d}`).join(' ')}}`;
export const NOT_OTA_SENDERS_QUERY = OTA_SENDER_DOMAINS.map((d) => `-from:${d}`).join(' ');

export const OTA_INVOICE_SKIP_MESSAGE =
  'Booking.com / Airbnb commission is booked from the settlement report (Revenue → OTA settlements), not as a supplier invoice.';
