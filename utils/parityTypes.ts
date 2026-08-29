/**
 * Parity monitor shapes — client-safe module.
 *
 * Shared by three parties that must agree byte-for-byte: the local runner
 * (scripts/parity-runner) that produces observations, the ingest route that
 * stores them, and the Pricing tab that renders them. Nothing here may import
 * server-only code.
 */

export type ParityChannel = 'web' | 'airbnb' | 'booking';

export interface DiscountLine {
  name: string;
  /** Absolute deduction in CZK when the channel itemises it. */
  amountKc?: number;
  /** Percentage points of the original price. */
  pp?: number;
}

export interface ParityOffer {
  /** Total stay price in CZK, or null when not bookable. */
  price: number | null;
  /** Strikethrough original when a discount applies. */
  originalPrice: number | null;
  /** Loose deal/badge labels seen on the offer. */
  labels: string[];
  discountBreakdown?: DiscountLine[];
  /** A discount exists but the channel would not itemise it. */
  unparsedDiscount?: boolean;
  availability: 'available' | 'not_available' | 'error';
}

/** One sampled stay, as scraped by the runner (web is added server-side). */
export interface ParitySlotResult {
  checkIn: string;
  nights: number;
  /** Echoed back when this slot answers a queued custom check. */
  requestId?: number;
  /** Keyed by unit id; a unit is absent when no channel is configured for it. */
  offers: Record<string, Partial<Record<ParityChannel, ParityOffer>>>;
}

/** POST /api/pricing/ingest body. */
export interface ParityIngestPayload {
  runId: string;
  source: 'grid' | 'custom';
  capturedAt: string;
  /** Runner version string, for debugging drift between Mac and server. */
  runner: string;
  slots: ParitySlotResult[];
}

/** GET /api/pricing/ingest response — the runner's work order. */
export interface ParityWorkOrder {
  /** Prague calendar date on the server. */
  today: string;
  /** Date of the newest grid run, or null if none yet. */
  lastGridDate: string | null;
  /** True when the server wants a full grid run from the runner. */
  gridDue: boolean;
  pendingRequests: { id: number; checkIn: string; nights: number }[];
}

// ── Read-side shapes (Pricing tab) ────────────────────────────────────────────

export interface ParityCell {
  unitId: string;
  unitLabel: string;
  web: ParityOffer | null;
  airbnb: ParityOffer | null;
  booking: ParityOffer | null;
  expectedBooking: number | null;
}

export interface ParitySlotView {
  checkIn: string;
  checkOut: string;
  nights: number;
  leadDays: number;
  units: ParityCell[];
}

export interface ParityRunView {
  runId: string;
  source: 'grid' | 'custom';
  capturedAt: string;
  slots: ParitySlotView[];
}

export interface ParityRequestView {
  id: number;
  checkIn: string;
  nights: number;
  status: string;
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
  /** Populated when done — the slots captured for this request. */
  result: ParitySlotView[] | null;
}

export interface ParityResponse {
  latestGrid: ParityRunView | null;
  requests: ParityRequestView[];
}
