/**
 * SERVER ONLY. Beds24 price lookups, shared by /api/price-check and
 * /api/stay-request/quote.
 *
 * TWO ENDPOINTS, TWO DIFFERENT ANSWERS — the distinction matters:
 *
 *   `/inventory/rooms/offers` returns BOOKABLE offers. Beds24 evaluates rate
 *   plans, length-of-stay pricing and restrictions, so this is the real quote —
 *   but only for a stay it can actually sell. Nothing available, no price.
 *
 *   `/inventory/rooms/calendar` returns the STORED daily rate (`price1`). It
 *   answers regardless of availability, but it is a nominal number: no rate-plan
 *   evaluation, no LOS discount, no restriction check. Summing it across nights
 *   is an estimate, and on long stays it reads HIGH versus a real offer.
 *
 * So prefer offers and fall back to the calendar, labelling which one answered —
 * a quote the operator might send a guest must never silently mix the two.
 *
 * WHAT THE CALENDAR SUM NOW INCLUDES (2026-09-03). Beds24 builds a sellable
 * price out of layers, and `price1` is only the first of them:
 *   price1 (stored daily rate)
 *     × calendar multiplier   — per date, default 1, needs includeMultiplier
 *     × bookingPageMultiplier — per property, the direct/web adjustment
 *     … then rate plans (`/inventory/fixedPrices`) can REPLACE the nightly
 *       price outright (roomPrice / 1PersonPrice / 2PersonPrice / extraPerson)
 *       and apply length-of-stay `discounts[]`, and individual rates can opt
 *       out of the multiplier via `allowMultiplier`.
 * We apply the two multipliers, read live from Beds24 rather than hardcoded.
 * We do NOT evaluate rate plans, so on a long span the nominal number still
 * reads HIGH — that is the remaining gap, and it is measured, not guessed:
 * `comparePrice()` computes both numbers for spans Beds24 will actually quote.
 */
import { getAccessToken } from '@/utils/beds24Auth';

const BEDS24_API_BASE = 'https://beds24.com/api/v2';

/** All Baker House rooms live under one Beds24 property. */
export const BEDS24_PROPERTY_ID = 311322;

/** Where a price came from — surfaced in the UI, never hidden. */
export type PriceSource = 'offers' | 'calendar-nominal' | 'none';

export interface SegmentPrice {
  price: number | null;
  source: PriceSource;
  /** How many offers Beds24 returned (0 when the span isn't sellable). */
  offersCount: number;
}

/**
 * Read a Beds24 multiplier defensively. The property setting is typed as a
 * string with no documented format, so accept both a factor ("0.75") and a
 * percentage ("75"), and refuse anything implausible rather than silently
 * scaling a guest-facing price by a junk value.
 * Returns null when there is no usable value — callers then apply no adjustment.
 */
export function parseMultiplier(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  // A factor above 3 is not a factor — Beds24 UIs also express these as percent.
  const factor = n > 3 ? n / 100 : n;
  return factor > 0 && factor <= 3 ? factor : null;
}

/**
 * Property settings change about never, and every price check would otherwise
 * spend a Beds24 credit on them (there is a rolling 5-minute limit), so cache.
 */
let multiplierCache: { value: number | null; raw: unknown; at: number } | null = null;
const MULTIPLIER_TTL_MS = 60 * 60 * 1000;

/**
 * The property's booking-page (direct/web) multiplier.
 *
 * `value: null` is ambiguous on its own — the setting may be unset, the field
 * may not be returned, or the call may have failed — so `error` distinguishes
 * them. An earlier version swallowed the failure into a bare null, which made a
 * live check read "no multiplier configured" when the truth was "we never got an
 * answer". Never collapse those two again.
 */
export async function fetchBookingPageMultiplier(
  token: string,
): Promise<{ value: number | null; raw: unknown; error?: string }> {
  if (multiplierCache && Date.now() - multiplierCache.at < MULTIPLIER_TTL_MS) {
    return { value: multiplierCache.value, raw: multiplierCache.raw };
  }

  try {
    // includePriceRules is cheap and is the documented home of price-related
    // property settings, so ask for it in case the field is gated behind it.
    const res = await fetch(
      `${BEDS24_API_BASE}/properties?id=${BEDS24_PROPERTY_ID}&includePriceRules=true`,
      { headers: { token }, cache: 'no-store' },
    );
    if (!res.ok) {
      const text = await res.text();
      return { value: null, raw: undefined, error: `Beds24 properties ${res.status}: ${text.slice(0, 300)}` };
    }

    const json = (await res.json()) as { data?: { bookingPageMultiplier?: unknown }[] };
    const raw = Array.isArray(json?.data) ? json.data[0]?.bookingPageMultiplier : undefined;
    const value = parseMultiplier(raw);
    multiplierCache = { value, raw, at: Date.now() };
    return { value, raw };
  } catch (err) {
    return { value: null, raw: undefined, error: err instanceof Error ? err.message : 'properties fetch failed' };
  }
}

/**
 * One-shot diagnostics for "where does the web price actually come from?".
 *
 * Live comparison proved the model is exactly
 *   offer = calendarSum × 0.75 × rateDiscount(room, nights)
 * to the cent, but `bookingPageMultiplier` read back empty — so this returns
 * what Beds24 actually says about the property AND the rate plans, trimmed to
 * the fields that set a price. Read-only; it changes nothing.
 */
export async function inspectPricingConfig(): Promise<{
  property: { keys: string[]; bookingPageMultiplier: unknown; error?: string };
  rates: unknown[];
  ratesError?: string;
}> {
  const token = await getAccessToken();

  let propertyInfo: { keys: string[]; bookingPageMultiplier: unknown; error?: string } = {
    keys: [], bookingPageMultiplier: undefined,
  };
  try {
    const res = await fetch(
      `${BEDS24_API_BASE}/properties?id=${BEDS24_PROPERTY_ID}&includePriceRules=true`,
      { headers: { token }, cache: 'no-store' },
    );
    if (!res.ok) {
      propertyInfo.error = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    } else {
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      const prop = Array.isArray(json?.data) ? json.data[0] ?? {} : {};
      // Field names only — property config is not something to dump wholesale.
      propertyInfo = { keys: Object.keys(prop), bookingPageMultiplier: prop.bookingPageMultiplier };
    }
  } catch (err) {
    propertyInfo.error = err instanceof Error ? err.message : 'properties fetch failed';
  }

  let rates: unknown[] = [];
  let ratesError: string | undefined;
  try {
    const res = await fetch(`${BEDS24_API_BASE}/inventory/fixedPrices?propertyId=${BEDS24_PROPERTY_ID}`, {
      headers: { token },
      cache: 'no-store',
    });
    if (!res.ok) {
      ratesError = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    } else {
      const json = (await res.json()) as { data?: Record<string, unknown>[] };
      rates = (Array.isArray(json?.data) ? json.data : []).map((r) => ({
        id: r.id, roomId: r.roomId, name: r.name,
        firstNight: r.firstNight, lastNight: r.lastNight,
        minNights: r.minNights, maxNights: r.maxNights,
        roomPrice: r.roomPrice, roomPriceEnable: r.roomPriceEnable,
        allowMultiplier: r.allowMultiplier, strategy: r.strategy,
        discounts: r.discounts,
      }));
    }
  } catch (err) {
    ratesError = err instanceof Error ? err.message : 'fixedPrices fetch failed';
  }

  return { property: propertyInfo, rates, ratesError };
}

/** Test seam — drops the cached property multiplier. */
export function resetMultiplierCache(): void {
  multiplierCache = null;
}

/**
 * THE DAILY PRICE RULES, as configured in Beds24 (operator screenshots,
 * 2026-09-03) and verified to the cent against six live offers via `?compare=1`.
 *
 *   price = Σ(price1 × date multiplier) × cheapest applicable Direct rule
 *                                       × bookingPageMultiplier
 *
 * THE THING THAT IS EASY TO GET WRONG: a rule only affects the web price if it
 * is published to the **Direct** channel. K.201 and 1KK Deluxe both have a
 * non-refundable rate (−10% and −7%), but neither is sold direct — they go to
 * Booking.com and Agent only — which is exactly why both quoted at the plain
 * multiplier for a 3-night stay while Urban and O.308 came back 7% lower.
 * O.308 is the mirror image: its STANDARD rate is Booking.com-only, so the
 * cheapest thing a direct guest can get for 2–6 nights is the non-refundable one.
 *
 * Beds24 sells the cheapest applicable offer, so we take the minimum over the
 * rules that are (a) published to Direct and (b) valid for this stay length.
 * Stay-length windows matter as much as the offsets: the non-refundable rules
 * stop at 6 nights, the weekly ones start at 7, and a ONE-NIGHT stay gets a
 * fixed surcharge rather than any discount at all.
 */
export interface DailyPriceRule {
  name: string;
  minNights: number;
  maxNights: number;
  /** Percentage offset from the standard rate: -7 = 7% cheaper, +5 = dearer. */
  percent?: number;
  /** Flat CZK added per night (the one-night-stay surcharge). */
  fixedPerNight?: number;
  /** false = not sold on the direct booking page, so irrelevant to a web price. */
  direct: boolean;
}

export const DAILY_PRICE_RULES: Record<number, DailyPriceRule[]> = {
  // 1KK Urban Studios
  679714: [
    { name: 'Standard Rate Urban', minNights: 2, maxNights: 365, percent: 0, direct: true },
    { name: 'Non Refundable Rate', minNights: 2, maxNights: 6, percent: -7, direct: true },
    { name: 'Flexible Rate', minNights: 2, maxNights: 365, percent: 5, direct: true },
    { name: 'Weekly Rate Urban', minNights: 7, maxNights: 365, percent: -20, direct: true },
    { name: 'One Night Stays', minNights: 1, maxNights: 1, fixedPerNight: 1000, direct: true },
  ],
  // Deluxe Apartments 1KK — non-refundable is NOT sold direct
  648816: [
    { name: 'Standard rate', minNights: 2, maxNights: 365, percent: 0, direct: true },
    { name: 'Non Refundable Rate', minNights: 2, maxNights: 6, percent: -7, direct: false },
    { name: 'Flexible Rate', minNights: 2, maxNights: 365, percent: 5, direct: true },
    { name: '7 days + Discount', minNights: 7, maxNights: 365, percent: -20, direct: true },
    { name: 'One Night Stays', minNights: 1, maxNights: 1, fixedPerNight: 1200, direct: true },
  ],
  // K.201 — non-refundable is −10% here, and also NOT sold direct
  656437: [
    { name: 'Standard rate', minNights: 2, maxNights: 365, percent: 0, direct: true },
    { name: 'Non Refundable Rate', minNights: 2, maxNights: 6, percent: -10, direct: false },
    { name: 'Flexible 3 day', minNights: 2, maxNights: 365, percent: 5, direct: true },
    { name: 'Weekly 2BR rate', minNights: 7, maxNights: 365, percent: -20, direct: true },
    { name: 'One Night Stays K201', minNights: 1, maxNights: 1, fixedPerNight: 2000, direct: true },
  ],
  // O.308 — the STANDARD rate is Booking.com-only, so direct guests start from
  // the non-refundable one for short stays.
  674672: [
    { name: 'Standard rate O308', minNights: 2, maxNights: 365, percent: 0, direct: false },
    { name: 'Non Refundable Rate', minNights: 2, maxNights: 6, percent: -7, direct: true },
    { name: 'Flexible Rate O308', minNights: 2, maxNights: 365, percent: 10, direct: true },
    { name: 'Weekly Rate O308', minNights: 7, maxNights: 365, percent: -20, direct: true },
    { name: 'One Night O308', minNights: 1, maxNights: 1, fixedPerNight: 1800, direct: true },
  ],
};

/** The property-level booking-page multiplier, used when Beds24 will not report it. */
export const WEB_MULTIPLIER = 0.75;

export interface RateChoice {
  /** Price for the whole stay before the booking-page multiplier. */
  price: number;
  /** Which rule won, for the operator to check against Beds24. */
  rule: string;
  /** Human-readable offset, e.g. "-20%" or "+1 000 Kč/night". */
  offset: string;
}

/**
 * The cheapest rate a DIRECT guest can book for this stay, given the standard
 * price for the span. Returns null when no direct rule covers the length — the
 * honest answer for a stay we do not sell, rather than a made-up number.
 */
export function bestDirectRate(roomId: number, nights: number, standardPrice: number): RateChoice | null {
  const rules = (DAILY_PRICE_RULES[roomId] ?? []).filter(
    (r) => r.direct && nights >= r.minNights && nights <= r.maxNights,
  );
  if (rules.length === 0) return null;

  const priced = rules.map((r) => ({
    rule: r.name,
    price:
      r.fixedPerNight !== undefined
        ? standardPrice + r.fixedPerNight * nights
        : standardPrice * (1 + (r.percent ?? 0) / 100),
    offset:
      r.fixedPerNight !== undefined
        ? `+${r.fixedPerNight.toLocaleString('cs-CZ')} Kč/night`
        : `${(r.percent ?? 0) > 0 ? '+' : ''}${r.percent ?? 0}%`,
  }));

  // Beds24 sells the cheapest applicable offer.
  return priced.reduce((best, cur) => (cur.price < best.price ? cur : best));
}

/** Subtract one day from a YYYY-MM-DD string (departure → last night). */
export function previousDay(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Price of a room's offer list. Beds24 orders its own offers, so the first one
 * is the one it would sell — no cheapest-of scan on our side (operator's call,
 * 2026-08-19).
 */
export function extractPrice(roomOffers: unknown): number | null {
  if (!Array.isArray(roomOffers) || roomOffers.length === 0) return null;
  const first = roomOffers[0] as { totalPrice?: unknown; price?: unknown };
  const raw = first.totalPrice ?? first.price ?? null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(',', '.')) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

/** How many offers came back for a room — 0 means "not sellable as asked". */
export function countOffers(roomOffers: unknown): number {
  return Array.isArray(roomOffers) ? roomOffers.length : 0;
}

/**
 * Walk an arbitrary value tree and sum daily price1 entries that fall inside
 * [arrival, departure). The Beds24 V2 calendar response shape is undocumented in
 * the consumer SDK and varies by version, so this is intentionally permissive:
 * any object that looks like a calendar day (has a price1 field plus either
 * { from, to } or { date }) is included.
 *
 * Each night is scaled by that date's `multiplier` (Beds24 default 1, present
 * only when the caller passed includeMultiplier). A date-level adjustment is
 * part of the stored price, so ignoring it understates or overstates the night.
 */
export function sumCalendarPrice(value: unknown, arrival: string, departure: string): number | null {
  const startMs = new Date(arrival + 'T00:00:00Z').getTime();
  const endMs = new Date(departure + 'T00:00:00Z').getTime(); // exclusive
  let total = 0;
  let coveredNights = 0;

  function visit(node: unknown) {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;

    // Heuristic: a calendar day entry has price1 + a date field
    const hasPrice = 'price1' in obj || 'price' in obj;
    const fromStr = typeof obj.from === 'string' ? obj.from
      : typeof obj.date === 'string' ? obj.date : null;
    const toStr = typeof obj.to === 'string' ? obj.to : fromStr;

    if (hasPrice && fromStr && toStr && /^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
      const rawPrice = obj.price1 ?? obj.price;
      const price = typeof rawPrice === 'string' ? parseFloat(rawPrice.replace(',', '.')) : Number(rawPrice);
      const dayMultiplier = parseMultiplier(obj.multiplier) ?? 1;
      if (Number.isFinite(price) && price > 0) {
        const entryStart = new Date(fromStr + 'T00:00:00Z').getTime();
        const entryEnd = new Date(toStr + 'T00:00:00Z').getTime();
        for (let t = entryStart; t <= entryEnd; t += 86_400_000) {
          if (t >= startMs && t < endMs) {
            total += price * dayMultiplier;
            coveredNights += 1;
          }
        }
      }
    }

    // Recurse into child objects/arrays — handles nested { calendar: [...] } shapes
    for (const key of Object.keys(obj)) visit(obj[key]);
  }

  visit(value);
  return coveredNights > 0 ? Math.round(total * 100) / 100 : null;
}

/**
 * Fetch the calendar for a single roomId.
 * Returns { price, raw } — raw is the parsed JSON response (used by debug mode).
 */
export async function fetchRoomCalendar(
  token: string,
  roomId: number,
  arrival: string,
  departure: string,
): Promise<{ price: number | null; raw: unknown }> {
  const endDateInclusive = previousDay(departure);
  // Per Beds24 V2 spec: calendar returns nothing unless at least one includeX flag is set.
  // includePrices gives price1; includeMultiplier gives the per-date factor that
  // scales it. Without the second flag the field is simply absent and every
  // night silently counts at multiplier 1.
  const params = new URLSearchParams({
    startDate: arrival,
    endDate: endDateInclusive,
    roomId: String(roomId),
    includePrices: 'true',
    includeMultiplier: 'true',
  });

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/calendar?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 calendar (room ${roomId}) returned ${res.status}: ${text}`);
  }

  const raw = await res.json();
  const price = sumCalendarPrice(raw, arrival, departure);
  return { price, raw };
}

/** Raw offers response for a whole property over one span. */
export async function fetchOffers(
  token: string,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<unknown> {
  const params = new URLSearchParams({
    propertyId: String(BEDS24_PROPERTY_ID),
    arrival,
    departure,
    numAdults: String(adults),
    numChildren: String(children),
  });

  const res = await fetch(`${BEDS24_API_BASE}/inventory/rooms/offers?${params.toString()}`, {
    headers: { token },
    cache: 'no-store',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Beds24 offers returned ${res.status}: ${text}`);
  }
  return res.json();
}

/** Pull one room's offer list out of an offers response. */
export function offersForRoom(data: unknown, roomId: number): unknown {
  const container = data as { data?: unknown } | null;
  const rows: unknown[] = Array.isArray(container?.data)
    ? (container!.data as unknown[])
    : Array.isArray(data)
      ? (data as unknown[])
      : [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue;
    if (Number((row as { roomId?: unknown }).roomId) === roomId) {
      return (row as { offers?: unknown }).offers;
    }
  }
  return null;
}

/**
 * Price ONE itinerary segment: a real Beds24 offer when the span is sellable,
 * otherwise the nominal calendar sum, always saying which it was. A segment that
 * looks free in our own occupancy data can still yield no offer — a min-stay or
 * max-stay restriction, or a guest count over capacity, is enough — so the
 * fallback keeps the operator informed instead of showing a blank.
 */
export async function priceSegment(
  roomId: number,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<SegmentPrice> {
  const token = await getAccessToken();

  const offersData = await fetchOffers(token, arrival, departure, adults, children);
  const roomOffers = offersForRoom(offersData, roomId);
  const offerPrice = extractPrice(roomOffers);
  if (offerPrice !== null) {
    return { price: offerPrice, source: 'offers', offersCount: countOffers(roomOffers) };
  }

  const { price } = await nominalWebPrice(token, roomId, arrival, departure);
  return {
    price,
    source: price === null ? 'none' : 'calendar-nominal',
    offersCount: countOffers(roomOffers),
  };
}

/**
 * What the web would charge for this span, whether or not Beds24 will sell it.
 *
 * This is the whole point of the "ignore availability" mode: before moving
 * anyone, the operator needs the price of a span that is currently booked, and
 * Beds24 refuses to quote those. So we rebuild it — stored daily rates, the
 * per-date multiplier, the web multiplier, and the best applicable discount.
 *
 * Every component is returned, not just the total, because an estimate the
 * operator cannot audit is one they cannot trust: `basePrice`, which multiplier
 * was used and whether it came from Beds24 or the model, and which discount won.
 */
export interface NominalWebPrice {
  /** Base × multiplier × discount — the number to show. */
  price: number | null;
  /** Sum of price1 × per-date multiplier, before anything else. */
  basePrice: number | null;
  /** The web multiplier actually applied. */
  webMultiplier: number;
  /** true = read live from Beds24; false = the model's constant. */
  webMultiplierFromBeds24: boolean;
  /** The factor Beds24 reported, or null when it did not report one. */
  bookingPageMultiplier: number | null;
  /** Exactly what Beds24 returned for the setting, for debugging. */
  bookingPageMultiplierRaw: unknown;
  /** Set when we could not READ the setting — distinct from it being unset. */
  multiplierError?: string;
  /** The single best discount applied, and why. */
  discountFactor: number;
  discountReason: string;
  raw?: unknown;
}

export async function nominalWebPrice(
  token: string,
  roomId: number,
  arrival: string,
  departure: string,
): Promise<NominalWebPrice> {
  const [{ price: basePrice, raw }, multiplier] = await Promise.all([
    fetchRoomCalendar(token, roomId, arrival, departure),
    fetchBookingPageMultiplier(token),
  ]);

  // Prefer what Beds24 says; fall back to the constant rather than to 1, since
  // "no multiplier" would overstate every price by a third.
  const webMultiplier = multiplier.value ?? WEB_MULTIPLIER;
  const nights = Math.round(
    (Date.parse(departure + 'T00:00:00Z') - Date.parse(arrival + 'T00:00:00Z')) / 86_400_000,
  );
  const rate = basePrice === null ? null : bestDirectRate(roomId, nights, basePrice);

  return {
    // The booking-page multiplier is applied to the rate Beds24 computed, so it
    // comes last. That ordering only matters for the flat one-night surcharge —
    // for percentage rules the two commute — and it is the one part of this
    // model not yet confirmed against a live offer.
    price: rate === null ? null : Math.round(rate.price * webMultiplier * 100) / 100,
    basePrice,
    webMultiplier,
    webMultiplierFromBeds24: multiplier.value !== null,
    bookingPageMultiplier: multiplier.value,
    bookingPageMultiplierRaw: multiplier.raw,
    multiplierError: multiplier.error,
    discountFactor: rate === null || basePrice === null || basePrice === 0
      ? 1
      : Math.round((rate.price / basePrice) * 10000) / 10000,
    discountReason: rate === null ? 'no direct rate covers this stay length' : `${rate.rule} (${rate.offset})`,
    raw,
  };
}

/**
 * Measure the gap instead of assuming it: for one span, the real Beds24 offer
 * next to our nominal estimate. Only spans Beds24 will actually quote produce
 * both numbers — which is the point, since that is where the estimate can be
 * checked. `ratio` is offer ÷ nominal: at 1.0 the estimate is exact, below 1.0
 * a rate plan (usually a length-of-stay discount) is doing something we do not
 * model yet.
 */
export interface PriceComparison {
  roomId: number;
  arrival: string;
  departure: string;
  nights: number;
  offerPrice: number | null;
  nominalPrice: number | null;
  basePrice: number | null;
  bookingPageMultiplier: number | null;
  /** Why the multiplier is null, when it is null for a reason we can name. */
  multiplierError?: string;
  webMultiplier: number;
  webMultiplierFromBeds24: boolean;
  discountFactor: number;
  discountReason: string;
  ratio: number | null;
}

export async function comparePrice(
  roomId: number,
  arrival: string,
  departure: string,
  adults: number,
  children: number,
): Promise<PriceComparison> {
  const token = await getAccessToken();
  const nights = Math.round(
    (Date.parse(departure + 'T00:00:00Z') - Date.parse(arrival + 'T00:00:00Z')) / 86_400_000,
  );

  const [offersData, nominal] = await Promise.all([
    fetchOffers(token, arrival, departure, adults, children),
    nominalWebPrice(token, roomId, arrival, departure),
  ]);
  const offerPrice = extractPrice(offersForRoom(offersData, roomId));

  return {
    roomId,
    arrival,
    departure,
    nights,
    offerPrice,
    nominalPrice: nominal.price,
    basePrice: nominal.basePrice,
    bookingPageMultiplier: nominal.bookingPageMultiplier,
    multiplierError: nominal.multiplierError,
    webMultiplier: nominal.webMultiplier,
    webMultiplierFromBeds24: nominal.webMultiplierFromBeds24,
    discountFactor: nominal.discountFactor,
    discountReason: nominal.discountReason,
    ratio:
      offerPrice !== null && nominal.price !== null && nominal.price > 0
        ? Math.round((offerPrice / nominal.price) * 1000) / 1000
        : null,
  };
}
