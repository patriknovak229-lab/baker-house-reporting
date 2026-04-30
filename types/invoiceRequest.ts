/**
 * Auto-detected invoice request from a guest's Beds24 message.
 *
 * Booking.com guests can click "I need an invoice" in their app, which sends
 * an automated message to the host. We parse those (Czech + Slovak) and store
 * a pending row that the operator can Accept or Reject in the drawer:
 *
 *  - Accept  → pre-fills invoiceData (company name, IČO/DIČ, email if found)
 *              and creates an Issue (category="invoice") on the reservation
 *              with actionableDate = checkout. status flips to "accepted".
 *  - Reject  → just dismisses the banner. status flips to "rejected".
 *
 * The raw message is preserved so the operator can re-read what was actually
 * sent, even if our parser missed something.
 */

export type InvoiceRequestStatus = "pending" | "accepted" | "rejected";

export interface InvoiceRequest {
  id: string;                  // generated UUID
  reservationNumber: string;   // BH-12345678
  beds24MessageId: number;     // de-dup key — never store the same Beds24 msg twice
  rawMessage: string;          // full message text as-received

  // Extracted fields — null when the parser couldn't pull them out.
  // Operator can fill missing pieces during the Accept flow.
  companyName: string | null;
  ico: string | null;          // Czech/Slovak company ID — 8 digits
  dic: string | null;          // Tax ID — "CZ12345678" / "SK12345678" or just digits
  email: string | null;        // Real (non-OTA-conduit) guest email if mentioned

  detectedAt: string;          // ISO timestamp the parser ran
  status: InvoiceRequestStatus;
  processedAt?: string;        // ISO when accepted/rejected
}
