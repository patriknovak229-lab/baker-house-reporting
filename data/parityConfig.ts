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
export const PARITY_CONFIG_VERSION = 5;

/** Display order everywhere (boards, radar): Urban, 1KK Deluxe, O.308, K.201. */
export const PARITY_UNITS: ParityUnitConfig[] = [
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
  {
    id: 'deluxe-1kk',
    label: '1KK Deluxe',
    beds24RoomId: 648816,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267401' },
    airbnb: { listingId: '1560149310755564258' },
  },
  {
    id: 'o308',
    label: '2BR Deluxe (O.308)',
    beds24RoomId: 674672,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267405' },
    airbnb: { listingId: '1703448722265968124' },
  },
  {
    id: 'k201',
    label: '2KK Deluxe (K.201)',
    beds24RoomId: 656437,
    booking: { pagePath: BOOKING_PAGE_MAIN, roomTypeId: '1541267403' },
    airbnb: { listingId: '1635011413648373253' },
  },
];

/**
 * The daily sweep — focused on the next ~60 days, where most bookings happen.
 *
 * Three intensity zones per run (the server plans concrete slots from the
 * PriceLabs availability snapshot; the runner just executes):
 *
 *  · Web + availability: EVERY 2-night check-in for the whole window, every
 *    day, straight from the Beds24 offers API at ingest time — no scraping,
 *    so it is effectively free and keeps the occupancy board complete.
 *  · Channel scrapes, 2 nights: every check-in inside DENSE_DAYS daily, then
 *    a rotating 1-in-FAR_STRIDE beyond it — every far date is re-scraped once
 *    per FAR_STRIDE days without tripling the run time.
 *  · Channel scrapes, 7 nights: rotating 1-in-WEEKLY_STRIDE across the whole
 *    window — full coverage once per week, matching how fast weekly rates move.
 */
export const PARITY_SWEEP = {
  /** How far ahead the sweep looks, in days. */
  windowDays: 60,
  /** Check-ins closer than this get scraped every single day (2-night). */
  denseDays: 21,
  /** Beyond denseDays, scrape every Nth date, rotating daily. */
  farStride: 3,
  /** 7-night check-ins: every Nth date, rotating daily. */
  weeklyStride: 7,
  /** Earliest check-in worth sampling (tomorrow is lead 1). */
  minLeadDays: 2,
  /** Hard cap on scrape slots per run — planner degrades stride, never blows this. */
  maxSlots: 60,
} as const;

/**
 * Fallback grid for a runner talking to a server that did not send a slot
 * plan (older deployment). Same shape as the original fixed grid.
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
 * Competitor listings to price-shop alongside our own units.
 *
 * Fill with the actual competitor identities: for Airbnb the numeric id from
 * the listing URL (airbnb.com/rooms/<id>), for Booking the property page path
 * plus the room_type id if a specific room matters (omit roomTypeId to take
 * the cheapest room on the page). `bedrooms` is only a display hint.
 *
 * The runner prices each competitor at COMPETITOR_LEADS for 2 and 7 nights.
 * Empty list = the whole feature is dormant and costs nothing.
 */
export interface CompetitorConfig {
  id: string; // short slug, e.g. 'comp-riverside'
  label: string;
  bedrooms: number;
  airbnb?: { listingId: string };
  booking?: { pagePath: string; roomTypeId?: string };
}

export const COMPETITORS: CompetitorConfig[] = [
  // { id: 'example', label: 'Riverside Apts 2BR', bedrooms: 2,
  //   airbnb: { listingId: '123456789' },
  //   booking: { pagePath: '/hotel/cz/example.en-gb.html' } },
];

/** Lead times (days) at which competitors are priced, per stay length. */
export const COMPETITOR_LEADS: { leadDays: number; nights: number }[] = [
  { leadDays: 7, nights: 2 },
  { leadDays: 30, nights: 2 },
  { leadDays: 14, nights: 7 },
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

/**
 * PARITY RULES — Booking.com is the baseline (the biggest channel).
 *
 * 1. Airbnb should equal Booking or sit slightly above it: alert when the
 *    anonymous Airbnb price deviates from Booking by more than this, in
 *    either direction.
 * 2. The direct site must never be the expensive option: alert when the Web
 *    price exceeds the anonymous Booking OR Airbnb price.
 */
export const AIRBNB_VS_BOOKING_TOLERANCE_PCT = 5;

/**
 * Always-on member discounts configured on Booking.com. These never expire,
 * so the price members/app users pay is DERIVED here rather than scraped.
 *
 * MECHANICS — confirmed against a live Genius/mobile reservation screenshot
 * (2026-08-30, Sept 4–6 1KK Deluxe): discounts are ADDITIVE percentage
 * points of the ORIGINAL (pre-deal) price, not multiplicative on the
 * discounted one. That reservation: base 7,762.99, Getaway −2,096.01,
 * Genius −776.30 = exactly 10% OF THE BASE.
 *
 *  · Genius 10% — applies always, including alongside special deals.
 *  · Mobile 10% — DISPLACED by any special deal (Getaway/Early Booker/…);
 *    only applies on undiscounted stays. A deal is visible to the scraper as
 *    a strikethrough. (No-deal mobile math still provisional until the
 *    second reference screenshot arrives.)
 *  · "Booking.com pays" — Booking sometimes discounts further out of its own
 *    commission. Out of host control, not configured anywhere, and it can
 *    push Booking below the direct site on its own. The derived floor
 *    deliberately EXCLUDES it; where the scraper sees the label, the alert
 *    says so.
 *
 * The floor is shown on the board for context; it does NOT feed the
 * web-vs-OTA alert (a direct site priced between the member floor and the
 * anonymous price is a pricing decision, not a data error).
 */
export const BOOKING_MEMBER_DISCOUNTS = {
  geniusPct: 10,
  mobilePct: 10,
} as const;

/** What a Genius app customer pays: anonymous price − member pp × original base. */
export function bookingMemberFloor(anonymousPrice: number, originalPrice: number | null): number {
  const base = originalPrice ?? anonymousPrice;
  const hasDeal = originalPrice !== null && originalPrice > anonymousPrice;
  const memberPct =
    BOOKING_MEMBER_DISCOUNTS.geniusPct + (hasDeal ? 0 : BOOKING_MEMBER_DISCOUNTS.mobilePct);
  return Math.round(anonymousPrice - (base * memberPct) / 100);
}
