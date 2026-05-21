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

/**
 * State machine for an invoice request:
 *   pending        — detected via keyword path, awaiting operator click
 *                    (legacy flow: every request used to start here)
 *   awaiting-info  — multi-turn flow asked the guest for missing mandatory
 *                    fields; we're waiting for their reply
 *   accepted       — operator manually accepted
 *   rejected       — operator manually rejected
 *   auto-completed — multi-turn flow received all mandatory fields and
 *                    populated invoiceData + created the Send-invoice task
 *                    without operator intervention
 */
export type InvoiceRequestStatus =
  | "pending"
  | "awaiting-info"
  | "accepted"
  | "rejected"
  | "auto-completed";

export interface InvoiceRequest {
  id: string;                  // generated UUID
  reservationNumber: string;   // BH-12345678
  beds24MessageId: number;     // de-dup key — never store the same Beds24 msg twice
  rawMessage: string;          // full message text as-received

  // Extracted fields — null when the parser couldn't pull them out.
  // Operator can fill missing pieces during the Accept flow. Auto-flow
  // merges new extractions from subsequent guest messages into these
  // same fields (existing non-null values are never overwritten).
  companyName: string | null;
  /** Optional per operator policy — never asked for, but stored if provided.
   *  Optional in the type so legacy entries that pre-date the multi-turn
   *  flow (created via /api/messages without this field) still parse. */
  companyAddress?: string | null;
  /** Czech/Slovak company ID — 8 digits — MANDATORY for auto-complete. */
  ico: string | null;
  /** Tax ID — "CZ12345678" / "SK12345678" — optional; cross-fallback to ICO. */
  dic: string | null;
  /** Real (non-OTA-conduit) guest email — MANDATORY for auto-complete. */
  email: string | null;

  detectedAt: string;          // ISO timestamp the parser ran
  status: InvoiceRequestStatus;
  processedAt?: string;        // ISO when accepted/rejected/auto-completed

  // ── Multi-turn auto-flow tracking ──
  // Only set on requests managed by the multi-turn pipeline. Manually-
  // created legacy requests leave these undefined.
  /** ISO when we last asked the guest for missing fields. */
  lastAskedAt?: string;
  /** How many times we've asked. Capped at 2 (initial ask + one 24h reminder). */
  asksCount?: number;
  /** ISO of the most recent guest message we extracted fields from — so a
   *  re-poll on the same message doesn't re-extract. */
  lastExtractedFromAt?: string;
}
