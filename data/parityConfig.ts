/**
 * Parity monitor configuration — which units to watch, where they live on each
 * channel, what stays to sample, and what the channel economics are SUPPOSED
 * to be.
 *
 * Unit ids must match SELLABLE_UNITS in analyticsConfig — the radar and the
 * parity monitor describe the same four sellable things.
 */

export interface ParityUnitConfig {
  id: string;
  label: string;
  /** Beds24 sellable room id — the offers API key for the Web column. */
  beds24RoomId: number;
  /**
   * Booking.com identity: the property page plus this unit's room_type id on
   * it (the numeric suffix of `room_type_id_*` anchors in the room table).
   *
   * Identity was established EMPIRICALLY (2026-08-29) by matching each room
   * type's availability against Beds24's per-room calendar on discriminating
   * dates — e.g. a night where only O.308 was free in Beds24 and Booking sold
   * exactly one room type. Do NOT re-derive these from m²/bed descriptions on
   * the Booking page; that reasoning produced a swapped mapping once already.
   */
  booking: { pagePath: string; roomTypeId: string } | null;
  /** Airbnb listing id, when the unit has its own listing. */
  airbnb: { listingId: string } | null;
}

export const BOOKING_PAGE_MAIN =
  '/hotel/cz/baker-house-apartments-brno-mesto.en-gb.html';

/**
 * Bump on any change to unit↔channel identities or the grid. Echoed in the
 * ingest work order so it is observable which config a deployment carries —
 * and so a runner log can be read against the mapping that produced it.
 */
export const PARITY_CONFIG_VERSION = 2;

export const PARITY_UNITS: ParityUnitConfig[] = [
  {
    id: 'deluxe-1kk',
    label: '1KK Deluxe',
    beds24RoomId: 648816,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267401' },
    airbnb: { listingId: '1560149310755564258' },
  },
  {
    id: 'k201',
    label: '2KK Deluxe (K.201)',
    beds24RoomId: 656437,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267403' },
    airbnb: { listingId: '1635011413648373253' },
  },
  {
    id: 'o308',
    label: '2BR Deluxe (O.308)',
    beds24RoomId: 674672,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267405' },
    airbnb: { listingId: '1703448722265968124' },
  },
  {
    id: 'urban-1kk',
    label: '1KK Urban',
    beds24RoomId: 679714,
    // The Urban studios are NOT on the main Booking.com property page
    // (verified 2026-08-29 — no room type matches). If they sell on Booking
    // under their own property, put its page path + room type id here.
    booking: null,
    airbnb: null,
  },
];

/**
 * The scheduled sampling grid: same relative windows every day, so the series
 * is comparable day over day. lead 3 = "what does a guest booking 3 days out
 * see", and the 2/7-night pair covers the transient and weekly rate shapes.
 * 8 slots → 8 Booking page loads + 16 Airbnb loads ≈ 4–5 min on the Mac.
 */
export const PARITY_GRID: { leadDays: number; nights: number }[] = [
  { leadDays: 3, nights: 2 },
  { leadDays: 7, nights: 2 },
  { leadDays: 14, nights: 2 },
  { leadDays: 30, nights: 2 },
  { leadDays: 60, nights: 2 },
  { leadDays: 7, nights: 7 },
  { leadDays: 30, nights: 7 },
  { leadDays: 60, nights: 7 },
];

/**
 * Intended channel economics — the "expected price" side of the parity check.
 *
 * expected = webTotal × (1 + markupPct/100) × Π(1 − discountPct/100 for each
 * stack entry whose minNights the stay meets)
 *
 * ALL VALUES START NULL on purpose: they must be copied from the Beds24
 * channel markup settings and the live Booking.com / Airbnb promotion
 * configuration by the operator, not guessed from observations — the whole
 * point of the column is to catch the configuration drifting from intent.
 * While a channel's markup is null, no expected price is computed and no
 * drift alert can fire.
 */
export interface ChannelEconomics {
  /** Channel markup over the Beds24/web base, in percent. */
  markupPct: number | null;
  /** Always-on discount stack the anonymous desktop customer receives. */
  stack: { name: string; pct: number; minNights?: number }[];
}

export const PARITY_ECONOMICS: Record<string, { booking: ChannelEconomics; airbnb: ChannelEconomics }> = {
  'deluxe-1kk': {
    booking: { markupPct: null, stack: [] },
    airbnb: { markupPct: null, stack: [{ name: 'Weekly discount', pct: 20, minNights: 7 }] },
  },
  k201: {
    booking: { markupPct: null, stack: [] },
    airbnb: { markupPct: null, stack: [{ name: 'Weekly discount', pct: 20, minNights: 7 }] },
  },
  o308: {
    booking: { markupPct: null, stack: [] },
    airbnb: { markupPct: null, stack: [] },
  },
  'urban-1kk': {
    booking: { markupPct: null, stack: [] },
    airbnb: { markupPct: null, stack: [] },
  },
};

/** Alert when |observed − expected| / expected exceeds this, per channel. */
export const EXPECTED_DRIFT_ALERT_PCT = 2;

/** The B-vs-A healthy band, mirrored from the UI's traffic-light rule. */
export const BOOKING_OVER_AIRBNB_BAND = { min: 0, max: 30 };
