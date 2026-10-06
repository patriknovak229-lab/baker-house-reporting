/**
 * Request parsing for the Corporate API — pure, so the rules are testable
 * without a server. Every function returns a ParseResult instead of throwing:
 * the route turns `error` into a 400 the operator can act on.
 */
import { isValidCountryCode } from './countries';
import { SELLABLE_UNITS } from './stayRequest';
import { computeStayPrice, validateSchedule, type StayOccurrence } from './corporateSchedule';
import type { BillingCadence, PricingMode, StayPriceSource, StayStatus } from './corporateShared';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

export const BILLING_CADENCES: BillingCadence[] = ['per_stay', 'monthly', 'upfront', 'manual'];
export const PRICING_MODES: PricingMode[] = ['flat', 'dynamic'];
export const PRICE_SOURCES: StayPriceSource[] = ['flat', 'offers', 'calendar-nominal', 'manual'];

export const SELLABLE_ROOM_IDS = new Set(SELLABLE_UNITS.map((u) => u.roomId));

/** Trimmed string or null for blank/missing; capped so a pasted novel can't land in a column. */
export function optStr(v: unknown, max = 500): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/** Finite number from a number or numeric string; null otherwise. */
export function optNum(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function intList(v: unknown): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = optNum(x);
    if (n === null || !Number.isInteger(n)) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

// ─── Agreement ───────────────────────────────────────────────────────────────

export interface AgreementInput {
  companyName: string;
  companyAddress: string | null;
  ico: string | null;
  vatNumber: string | null;
  billingEmail: string | null;
  billingCadence: BillingCadence;
  repName: string | null;
  repPhone: string | null;
  repEmail: string | null;
  guestFirstName: string | null;
  guestLastName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  adults: number;
  children: number;
  nationality: string;
  roomIds: number[];
  preferredRoomId: number | null;
  startDate: string;
  endDate: string;
  nightWeekdays: number[];
  pricingMode: PricingMode;
  flatNightPriceCzk: number | null;
  discountPercent: number;
  notes: string | null;
}

export function parseAgreementInput(body: unknown): ParseResult<AgreementInput> {
  if (!body || typeof body !== 'object') return fail('Request body must be an object');
  const b = body as Record<string, unknown>;

  const companyName = optStr(b.companyName, 200);
  if (!companyName) return fail('Company name is required');

  const cadence = (optStr(b.billingCadence) ?? 'per_stay') as BillingCadence;
  if (!BILLING_CADENCES.includes(cadence)) return fail(`Unknown billing cadence "${cadence}"`);

  const adults = optNum(b.adults) ?? 1;
  const children = optNum(b.children) ?? 0;
  if (!Number.isInteger(adults) || adults < 1 || adults > 10) return fail('Adults must be a whole number from 1 to 10');
  if (!Number.isInteger(children) || children < 0 || children > 10) return fail('Children must be a whole number from 0 to 10');

  // Not truncated: "Czechia" must fail, not be clipped into a valid "CZ".
  const nationality = (optStr(b.nationality, 10) ?? 'CZ').toUpperCase();
  if (nationality.length !== 2 || !isValidCountryCode(nationality)) {
    return fail('Nationality must be a 2-letter ISO country code');
  }

  const roomIds = intList(b.roomIds);
  if (!roomIds || roomIds.length === 0) return fail('Pick at least one suitable room type');
  const unknownRoom = roomIds.find((id) => !SELLABLE_ROOM_IDS.has(id));
  if (unknownRoom !== undefined) return fail(`Room id ${unknownRoom} is not a sellable room type`);

  const preferredRaw = optNum(b.preferredRoomId);
  const preferredRoomId = preferredRaw === null ? null : preferredRaw;
  if (preferredRoomId !== null && !roomIds.includes(preferredRoomId)) {
    return fail('The preferred room type must be one of the suitable room types');
  }

  const startDate = optStr(b.startDate, 10) ?? '';
  const endDate = optStr(b.endDate, 10) ?? '';
  const nightWeekdays = intList(b.nightWeekdays) ?? [];
  const scheduleProblem = validateSchedule({ startDate, endDate, nightWeekdays });
  if (scheduleProblem) return fail(scheduleProblem);

  const pricingMode = optStr(b.pricingMode) as PricingMode | null;
  if (!pricingMode || !PRICING_MODES.includes(pricingMode)) return fail('Pricing must be "flat" or "dynamic"');

  const flatNightPriceCzk = optNum(b.flatNightPriceCzk);
  if (pricingMode === 'flat' && (flatNightPriceCzk === null || flatNightPriceCzk <= 0)) {
    return fail('Flat pricing needs a nightly price above 0');
  }

  const discountPercent = optNum(b.discountPercent) ?? 0;
  if (discountPercent < 0 || discountPercent > 100) return fail('Discount must be between 0 and 100 percent');

  return {
    ok: true,
    value: {
      companyName,
      companyAddress: optStr(b.companyAddress),
      ico: optStr(b.ico, 32),
      vatNumber: optStr(b.vatNumber, 32),
      billingEmail: optStr(b.billingEmail, 200),
      billingCadence: cadence,
      repName: optStr(b.repName, 200),
      repPhone: optStr(b.repPhone, 50),
      repEmail: optStr(b.repEmail, 200),
      guestFirstName: optStr(b.guestFirstName, 100),
      guestLastName: optStr(b.guestLastName, 100),
      guestPhone: optStr(b.guestPhone, 50),
      guestEmail: optStr(b.guestEmail, 200),
      adults,
      children,
      nationality,
      roomIds,
      preferredRoomId,
      startDate,
      endDate,
      nightWeekdays: [...nightWeekdays].sort((a, b) => a - b),
      pricingMode,
      flatNightPriceCzk: pricingMode === 'flat' ? flatNightPriceCzk : null,
      discountPercent: pricingMode === 'dynamic' ? discountPercent : 0,
      notes: optStr(b.notes, 2000),
    },
  };
}

/** Fields the operator may change after saving. Schedule, rooms and pricing are fixed — a new agreement instead. */
export type AgreementPatch = Partial<
  Pick<
    AgreementInput,
    | 'companyName'
    | 'companyAddress'
    | 'ico'
    | 'vatNumber'
    | 'billingEmail'
    | 'billingCadence'
    | 'repName'
    | 'repPhone'
    | 'repEmail'
    | 'guestFirstName'
    | 'guestLastName'
    | 'guestPhone'
    | 'guestEmail'
    | 'notes'
  >
> & { status?: 'draft' | 'active' | 'completed' | 'cancelled' };

export function parseAgreementPatch(body: unknown): ParseResult<AgreementPatch> {
  if (!body || typeof body !== 'object') return fail('Request body must be an object');
  const b = body as Record<string, unknown>;
  const patch: AgreementPatch = {};

  if ('companyName' in b) {
    const v = optStr(b.companyName, 200);
    if (!v) return fail('Company name cannot be empty');
    patch.companyName = v;
  }
  const textFields = [
    ['companyAddress', 500],
    ['ico', 32],
    ['vatNumber', 32],
    ['billingEmail', 200],
    ['repName', 200],
    ['repPhone', 50],
    ['repEmail', 200],
    ['guestFirstName', 100],
    ['guestLastName', 100],
    ['guestPhone', 50],
    ['guestEmail', 200],
    ['notes', 2000],
  ] as const;
  for (const [field, max] of textFields) {
    if (field in b) patch[field] = optStr(b[field], max);
  }
  if ('billingCadence' in b) {
    const v = optStr(b.billingCadence) as BillingCadence | null;
    if (!v || !BILLING_CADENCES.includes(v)) return fail('Unknown billing cadence');
    patch.billingCadence = v;
  }
  if ('status' in b) {
    const v = optStr(b.status);
    if (v !== 'draft' && v !== 'active' && v !== 'completed' && v !== 'cancelled') return fail('Unknown agreement status');
    patch.status = v;
  }
  if (Object.keys(patch).length === 0) return fail('Nothing to update');
  return { ok: true, value: patch };
}

// ─── Stays ───────────────────────────────────────────────────────────────────

/** The operator's per-row choices from the preview, keyed by the generated seq. */
export interface StayInput {
  seq: number;
  roomId: number | null;
  priceCzk: number | null;
  listPriceCzk: number | null;
  priceSource: StayPriceSource | null;
  guestFirstName: string | null;
  guestLastName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  include: boolean;
}

export function parseStayInputs(raw: unknown, agreement: AgreementInput): ParseResult<StayInput[]> {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return fail('stays must be an array');
  const out: StayInput[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return fail('Each stay must be an object');
    const s = item as Record<string, unknown>;
    const seq = optNum(s.seq);
    if (seq === null || !Number.isInteger(seq) || seq < 1) return fail('Each stay needs a positive integer seq');
    if (seen.has(seq)) return fail(`Stay ${seq} is listed twice`);
    seen.add(seq);

    const roomId = optNum(s.roomId);
    if (roomId !== null && !agreement.roomIds.includes(roomId)) {
      return fail(`Stay ${seq}: room ${roomId} is not one of the agreement's room types`);
    }
    const priceCzk = optNum(s.priceCzk);
    if (priceCzk !== null && priceCzk < 0) return fail(`Stay ${seq}: price cannot be negative`);
    const listPriceCzk = optNum(s.listPriceCzk);
    const priceSource = optStr(s.priceSource) as StayPriceSource | null;
    if (priceSource !== null && !PRICE_SOURCES.includes(priceSource)) return fail(`Stay ${seq}: unknown price source`);

    out.push({
      seq,
      roomId,
      priceCzk,
      listPriceCzk,
      priceSource,
      guestFirstName: optStr(s.guestFirstName, 100),
      guestLastName: optStr(s.guestLastName, 100),
      guestPhone: optStr(s.guestPhone, 50),
      guestEmail: optStr(s.guestEmail, 200),
      include: s.include !== false,
    });
  }
  return { ok: true, value: out };
}

export interface MaterialisedStay {
  seq: number;
  arrival: string;
  departure: string;
  nights: number;
  roomId: number;
  guestFirstName: string | null;
  guestLastName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  listPriceCzk: number | null;
  priceCzk: number | null;
  priceSource: StayPriceSource | null;
  status: Extract<StayStatus, 'planned' | 'skipped'>;
}

/**
 * Combine the stays the pattern generates with the operator's per-row choices.
 * The server regenerates the occurrences itself, so a row can only ever refer
 * to a seq the pattern really produces — the client cannot invent dates.
 */
export function materialiseStays(
  agreement: AgreementInput,
  occurrences: StayOccurrence[],
  rows: StayInput[],
): ParseResult<MaterialisedStay[]> {
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  const known = new Set(occurrences.map((o) => o.seq));
  const stray = rows.find((r) => !known.has(r.seq));
  if (stray) return fail(`Stay ${stray.seq} does not exist in this schedule — reload the preview`);

  const defaultRoom = agreement.preferredRoomId ?? agreement.roomIds[0];
  const value = occurrences.map((o): MaterialisedStay => {
    const row = bySeq.get(o.seq);
    const roomId = row?.roomId ?? defaultRoom;
    const computed = computeStayPrice({
      mode: agreement.pricingMode,
      nights: o.nights,
      flatNightPriceCzk: agreement.flatNightPriceCzk,
      listPriceCzk: row?.listPriceCzk ?? null,
      discountPercent: agreement.discountPercent,
    });
    const priceCzk = row?.priceCzk ?? computed;
    let priceSource: StayPriceSource | null = row?.priceSource ?? null;
    if (priceCzk !== null && priceSource === null) {
      priceSource = agreement.pricingMode === 'flat' ? 'flat' : 'manual';
    }
    // An operator-typed number that differs from what the rule gives is manual.
    if (priceCzk !== null && computed !== null && priceCzk !== computed && priceSource !== 'manual') {
      priceSource = 'manual';
    }
    return {
      seq: o.seq,
      arrival: o.arrival,
      departure: o.departure,
      nights: o.nights,
      roomId,
      guestFirstName: row?.guestFirstName ?? null,
      guestLastName: row?.guestLastName ?? null,
      guestPhone: row?.guestPhone ?? null,
      guestEmail: row?.guestEmail ?? null,
      listPriceCzk: row?.listPriceCzk ?? null,
      priceCzk,
      priceSource,
      status: row && !row.include ? 'skipped' : 'planned',
    };
  });
  return { ok: true, value };
}

/** Per-stay edits from the detail view. `null` clears a guest override; absent = untouched. */
export interface StayPatch {
  guestFirstName?: string | null;
  guestLastName?: string | null;
  guestPhone?: string | null;
  guestEmail?: string | null;
  priceCzk?: number;
  roomId?: number;
  status?: 'planned' | 'skipped';
}

export function parseStayPatch(body: unknown): ParseResult<StayPatch> {
  if (!body || typeof body !== 'object') return fail('Request body must be an object');
  const b = body as Record<string, unknown>;
  const patch: StayPatch = {};
  if ('guestFirstName' in b) patch.guestFirstName = optStr(b.guestFirstName, 100);
  if ('guestLastName' in b) patch.guestLastName = optStr(b.guestLastName, 100);
  if ('guestPhone' in b) patch.guestPhone = optStr(b.guestPhone, 50);
  if ('guestEmail' in b) patch.guestEmail = optStr(b.guestEmail, 200);
  if ('priceCzk' in b) {
    const n = optNum(b.priceCzk);
    if (n === null || n < 0) return fail('Price must be a number of 0 or more');
    patch.priceCzk = Math.round(n);
  }
  if ('roomId' in b) {
    const n = optNum(b.roomId);
    if (n === null || !SELLABLE_ROOM_IDS.has(n)) return fail('Room must be a sellable room type');
    patch.roomId = n;
  }
  if ('status' in b) {
    const v = optStr(b.status);
    if (v !== 'planned' && v !== 'skipped') return fail('A stay can only be set to planned or skipped here');
    patch.status = v;
  }
  if (Object.keys(patch).length === 0) return fail('Nothing to update');
  return { ok: true, value: patch };
}

export function hasGuestChange(patch: StayPatch): boolean {
  return 'guestFirstName' in patch || 'guestLastName' in patch || 'guestPhone' in patch || 'guestEmail' in patch;
}
