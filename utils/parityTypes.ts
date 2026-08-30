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
  /**
   * 'restricted' (web rows only): every night of the stay is open, but a
   * min-stay rule blocks this stay length — open calendar, not a booked room.
   */
  availability: 'available' | 'not_available' | 'restricted' | 'error';
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

/**
 * One slot the server wants scraped. `units` lists the unit ids believed
 * sellable for the stay (from the availability snapshot) — the runner uses it
 * to skip pointless Airbnb page loads; Booking is one page load either way.
 */
export interface PlannedSlot {
  checkIn: string;
  nights: number;
  units: string[];
}

/** GET /api/pricing/ingest response — the runner's work order. */
export interface ParityWorkOrder {
  /** Prague calendar date on the server. */
  today: string;
  /** PARITY_CONFIG_VERSION the server was deployed with. */
  configVersion?: number;
  /** Date of the newest grid run, or null if none yet. */
  lastGridDate: string | null;
  /** True when the server wants a full grid run from the runner. */
  gridDue: boolean;
  /** The concrete scrape plan for today's grid (present when gridDue). */
  slots?: PlannedSlot[];
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

// ── The 60-day boards ─────────────────────────────────────────────────────────

/** A channel observation with its capture time — boards mix vintages. */
export interface BoardObservation extends ParityOffer {
  capturedAt: string;
}

export interface BoardUnitCell {
  unitId: string;
  unitLabel: string;
  /**
   * Whether Beds24 would sell this stay online, from the freshest web row:
   * true = offer exists, false = no offer (booked/blocked/min-stay), null =
   * no observation yet.
   */
  sellable: boolean | null;
  web: BoardObservation | null;
  airbnb: BoardObservation | null;
  booking: BoardObservation | null;
}

export interface BoardRow {
  checkIn: string;
  checkOut: string;
  nights: number;
  units: BoardUnitCell[];
}

export interface CompetitorObservation {
  compId: string;
  label: string;
  bedrooms: number;
  channel: ParityChannel;
  checkIn: string;
  nights: number;
  price: number | null;
  originalPrice: number | null;
  labels: string[];
  capturedAt: string;
}

export interface ParityResponse {
  /** 1-night stays, all units, next 14 days (daily; gap-filler pricing). */
  board1n: BoardRow[];
  /** 2-night stays — the studio units (urban + deluxe 1KK). */
  board2n: BoardRow[];
  /** 3-night stays — the 2BR units (O.308 + K.201, seasonal min-stay 3). */
  board3n: BoardRow[];
  /** 7-night stays, all units (scraped on a weekly rotation). */
  board7n: BoardRow[];
  competitors: CompetitorObservation[];
  requests: ParityRequestView[];
  /** When the newest grid run landed — the staleness signal. */
  latestGridAt: string | null;
}
