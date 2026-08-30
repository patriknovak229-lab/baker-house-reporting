/**
 * Daily scrape plan — which stays the runner should price today.
 *
 * Planning is availability-aware so the runner never burns page loads on
 * stays nothing could sell. The availability source is the PriceLabs snapshot
 * (`market_daily.live_price` per unit-night: null = booked/blocked, plus
 * `min_stay`), which is at most a day stale — good enough for planning; the
 * scrape itself records ground truth either way.
 *
 * Zones (see PARITY_SWEEP): 2-night stays are scraped daily inside denseDays
 * and on a rotating 1-in-farStride beyond it; 7-night stays rotate
 * 1-in-weeklyStride across the whole window. Rotation is keyed to the day of
 * year, so consecutive days sample different residues and every date gets
 * covered within one stride period.
 */
import { and, gte, inArray, lte } from 'drizzle-orm';
import { db } from '@/lib/db';
import { marketDaily } from '@/lib/db/schema';
import { PARITY_SWEEP, PARITY_UNITS } from '@/data/parityConfig';
import type { PlannedSlot } from '@/utils/parityTypes';

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayOfYear(iso: string): number {
  const d = new Date(`${iso}T00:00:00Z`);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  return Math.floor((d.getTime() - start) / 86_400_000);
}

export interface NightInfo {
  sellable: boolean;
  minStay: number;
}

/** unitId → stay date → night info, from the PriceLabs snapshot. */
export type NightMap = Map<string, Map<string, NightInfo>>;

export async function loadNightMap(fromIso: string, toIso: string): Promise<NightMap> {
  const listingIds = PARITY_UNITS.map((u) => `311322___${u.beds24RoomId}`);

  const rows = await db
    .select({
      listingId: marketDaily.listingId,
      stayDate: marketDaily.stayDate,
      livePrice: marketDaily.livePrice,
      minStay: marketDaily.minStay,
    })
    .from(marketDaily)
    .where(
      and(
        inArray(marketDaily.listingId, listingIds),
        gte(marketDaily.stayDate, fromIso),
        lte(marketDaily.stayDate, toIso),
      ),
    );

  const nights: NightMap = new Map();
  const unitByListing = new Map(PARITY_UNITS.map((u) => [`311322___${u.beds24RoomId}`, u.id]));
  for (const r of rows) {
    const unitId = unitByListing.get(r.listingId);
    if (!unitId) continue;
    let m = nights.get(unitId);
    if (!m) {
      m = new Map();
      nights.set(unitId, m);
    }
    m.set(r.stayDate, { sellable: r.livePrice !== null, minStay: r.minStay ?? 1 });
  }
  return nights;
}

/**
 * Why a stay produced no web offer: 'restricted' = every night is OPEN but the
 * check-in's min-stay exceeds the stay length (K.201 carries min-stay 3 for
 * whole months — that is a rate rule, not an occupied room and the calendar
 * must not paint it as booked); 'not_available' = at least one night is
 * genuinely closed/booked (or we have no snapshot data to say otherwise).
 */
export function classifyUnsoldStay(
  map: NightMap,
  unitId: string,
  checkIn: string,
  stayNights: number,
): 'restricted' | 'not_available' {
  const m = map.get(unitId);
  if (!m) return 'not_available';
  for (let n = 0; n < stayNights; n++) {
    const night = m.get(addDays(checkIn, n));
    if (!night || !night.sellable) return 'not_available';
  }
  return (m.get(checkIn)?.minStay ?? 1) > stayNights ? 'restricted' : 'not_available';
}

export function minStayAt(map: NightMap, unitId: string, checkIn: string): number | null {
  return map.get(unitId)?.get(checkIn)?.minStay ?? null;
}

/** True when the snapshot says the unit could sell this stay (all nights open, min-stay OK). */
export function staySellablePerMarket(
  map: NightMap,
  unitId: string,
  checkIn: string,
  stayNights: number,
): boolean {
  const m = map.get(unitId);
  if (!m) return false;
  for (let n = 0; n < stayNights; n++) {
    const night = m.get(addDays(checkIn, n));
    if (!night || !night.sellable) return false;
  }
  return (m.get(checkIn)?.minStay ?? 1) <= stayNights;
}

export async function planSweepSlots(
  todayIso: string,
  opts?: { full?: boolean },
): Promise<PlannedSlot[]> {
  const cfg = PARITY_SWEEP;
  const full = opts?.full === true;
  const nights = await loadNightMap(
    addDays(todayIso, cfg.minLeadDays),
    addDays(todayIso, cfg.windowDays + 7), // 7-night tails past the window
  );

  /** Units that could sell a stay: every night open and check-in min-stay ≤ nights. */
  const sellableUnits = (checkIn: string, stayNights: number): string[] => {
    const out: string[] = [];
    for (const unit of PARITY_UNITS) {
      const m = nights.get(unit.id);
      if (!m) continue;
      const first = m.get(checkIn);
      if (!first || !first.sellable || first.minStay > stayNights) continue;
      let open = true;
      for (let n = 1; n < stayNights; n++) {
        const night = m.get(addDays(checkIn, n));
        if (!night || !night.sellable) {
          open = false;
          break;
        }
      }
      if (open) out.push(unit.id);
    }
    return out;
  };

  const rotation = dayOfYear(todayIso);
  const dense: PlannedSlot[] = [];
  const far: PlannedSlot[] = [];

  // 1-night stays, all units: daily, near window only, and only where a
  // 1-night stay actually sells (min-stay 1 gap fillers) — from TOMORROW,
  // because that is where gap-filler pricing matters most.
  for (let lead = 1; lead <= cfg.oneNightDays; lead++) {
    const checkIn = addDays(todayIso, lead);
    const units = sellableUnits(checkIn, 1);
    if (units.length > 0) dense.push({ checkIn, nights: 1, units });
  }

  for (let lead = cfg.minLeadDays; lead <= cfg.windowDays; lead++) {
    const checkIn = addDays(todayIso, lead);

    // Short stays — 2-night for the studios, 3-night for the 2BR units (their
    // seasonal min-stay 3 makes 2-night stays unsellable for whole months).
    // Dense zone daily, far zone on rotation. A full sweep (?plan=1&full=1 —
    // one-off backfills) scrapes every sellable check-in in the window; the
    // maxSlots cap never trims the dense list.
    const farDue = lead > cfg.denseDays && lead % cfg.farStride === rotation % cfg.farStride;
    if (full || lead <= cfg.denseDays || farDue) {
      for (const stayNights of [2, 3] as const) {
        const groupIds = PARITY_UNITS.filter((u) => u.shortStayNights === stayNights).map((u) => u.id);
        const units = sellableUnits(checkIn, stayNights).filter((id) => groupIds.includes(id));
        if (units.length > 0) {
          (full || lead <= cfg.denseDays ? dense : far).push({ checkIn, nights: stayNights, units });
        }
      }
    }

    // 7-night: rotating stride across the whole window, all units.
    if (lead % cfg.weeklyStride === rotation % cfg.weeklyStride) {
      const units = sellableUnits(checkIn, 7);
      if (units.length > 0) far.push({ checkIn, nights: 7, units });
    }
  }

  // Cap: the dense zone is the value core and always survives; rotation
  // slots are trimmed from the far end first. A full sweep is a deliberate
  // one-off backfill — nothing is trimmed.
  const cap = full ? dense.length + far.length : Math.max(dense.length, cfg.maxSlots);
  return [...dense, ...far].slice(0, cap);
}
