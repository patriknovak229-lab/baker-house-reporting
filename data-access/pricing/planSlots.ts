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

interface NightInfo {
  sellable: boolean;
  minStay: number;
}

export async function planSweepSlots(todayIso: string): Promise<PlannedSlot[]> {
  const cfg = PARITY_SWEEP;
  const from = addDays(todayIso, cfg.minLeadDays);
  const to = addDays(todayIso, cfg.windowDays + 7); // 7-night tails past the window

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
        gte(marketDaily.stayDate, from),
        lte(marketDaily.stayDate, to),
      ),
    );

  // unitId → date → night info
  const nights = new Map<string, Map<string, NightInfo>>();
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

  for (let lead = cfg.minLeadDays; lead <= cfg.windowDays; lead++) {
    const checkIn = addDays(todayIso, lead);

    // 2-night: dense zone daily, far zone on rotation.
    const farDue = lead > cfg.denseDays && lead % cfg.farStride === rotation % cfg.farStride;
    if (lead <= cfg.denseDays || farDue) {
      const units = sellableUnits(checkIn, 2);
      if (units.length > 0) (lead <= cfg.denseDays ? dense : far).push({ checkIn, nights: 2, units });
    }

    // 7-night: rotating stride across the whole window.
    if (lead % cfg.weeklyStride === rotation % cfg.weeklyStride) {
      const units = sellableUnits(checkIn, 7);
      if (units.length > 0) far.push({ checkIn, nights: 7, units });
    }
  }

  // Cap: the dense zone is the value core and always survives; rotation
  // slots are trimmed from the far end first.
  return [...dense, ...far].slice(0, Math.max(dense.length, cfg.maxSlots));
}
