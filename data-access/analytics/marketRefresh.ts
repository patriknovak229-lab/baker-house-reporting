/**
 * Pull the PriceLabs market benchmark into Postgres.
 *
 * This is the ONLY place in the app that calls PriceLabs. It runs from a cron or
 * an operator pressing Refresh — never from a page load. The analytics endpoints
 * read the tables this writes and nothing else, so the slowest external
 * dependency in the system can never sit on the critical path of a dashboard.
 *
 * Failure policy: per-listing, and non-fatal. If one listing's neighborhood call
 * times out, its older rows stay exactly as they were and the response says which
 * listing failed. A market benchmark that is a day stale is useful; one that
 * half-wrote and half-failed silently is worse than none, so `capturedAt` is
 * per-row and the UI reports the oldest vintage it is showing.
 *
 * Idempotent by construction — every write is an upsert on a natural key, so
 * re-running it is always safe and the tables never grow.
 */
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { marketDaily, marketHorizon, marketMonthly } from '@/lib/db/schema';
import { SELLABLE_UNITS } from '@/data/analyticsConfig';
import {
  fetchListingMetrics,
  fetchListingPrices,
  fetchNeighborhoodData,
  monthLabelToIso,
  plNumber,
  plRatio,
  priceLabsConfigured,
  series,
  type MarketDailyDraft,
} from './marketTypes';

export interface RefreshResult {
  configured: boolean;
  listings: {
    unitId: string;
    listingId: string;
    dailyRows: number;
    monthlyRows: number;
    horizonRows: number;
    compSetListings: number | null;
    error: string | null;
  }[];
  startedAt: string;
  finishedAt: string;
}

/** Horizons worth storing. PriceLabs returns more; these are the ones plotted. */
const HORIZONS = [7, 30, 60, 90, 180, 360];

/** Neon's HTTP driver takes one statement per round trip — keep them well under any limit. */
const CHUNK = 150;

async function chunked<T>(rows: T[], write: (batch: T[]) => Promise<unknown>): Promise<number> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await write(rows.slice(i, i + CHUNK));
  }
  return rows.length;
}

/**
 * How far forward to pull per-night prices.
 *
 * A year: beyond that the operator cannot price and PriceLabs' own comp data
 * thins out to a handful of listings per night.
 */
function priceWindow(todayIso: string): { from: string; to: string } {
  const end = new Date(`${todayIso}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 365);
  return { from: todayIso, to: end.toISOString().slice(0, 10) };
}

export async function refreshMarketSnapshot(todayIso: string): Promise<RefreshResult> {
  const startedAt = new Date().toISOString();

  if (!priceLabsConfigured()) {
    return { configured: false, listings: [], startedAt, finishedAt: startedAt };
  }

  const results: RefreshResult['listings'] = [];

  for (const unit of SELLABLE_UNITS) {
    if (!unit.priceLabsListingId) continue;
    const listingId = unit.priceLabsListingId;
    const entry: RefreshResult['listings'][number] = {
      unitId: unit.id,
      listingId,
      dailyRows: 0,
      monthlyRows: 0,
      horizonRows: 0,
      compSetListings: null,
      error: null,
    };

    try {
      const [metrics, neighborhood, prices] = await Promise.all([
        fetchListingMetrics(listingId),
        fetchNeighborhoodData(listingId),
        (async () => {
          const w = priceWindow(todayIso);
          return fetchListingPrices(listingId, w.from, w.to);
        })(),
      ]);

      // ── Horizons (MPI numerator comes from our own archive, not from here) ──
      // Comp-set size first: the horizon upsert carries it, and it is read out of
      // the neighborhood payload, so both must be in hand before writing.
      const catForCompSet = String(unit.bedrooms);
      const compSetListings =
        neighborhood['Future Occ/New/Canc']?.Category?.[catForCompSet]?.['Listings Used'] ??
        neighborhood['Listings Used'] ??
        null;

      const marketOcc = metrics.market_level?.occupancy ?? {};
      const theirOcc = metrics.listing_level?.occupancy ?? {};
      const theirAdr = metrics.listing_level?.adr ?? {};
      const horizonRows = HORIZONS.map((h) => {
        const market = plRatio(marketOcc[String(h)]);
        const theirs = plRatio(theirOcc[String(h)]);
        return {
          listingId,
          horizonDays: h,
          marketOccupancy: market === null ? null : String(market),
          marketAdr: plNumber(theirAdr[String(h)]) === null ? null : String(plNumber(theirAdr[String(h)])),
          theirOwnOccupancy: theirs === null ? null : String(theirs),
          theirMpi: market && theirs !== null && market > 0 ? String(theirs / market) : null,
          compSetListings,
          capturedAt: new Date(),
        };
      });
      entry.horizonRows = await chunked(horizonRows, (batch) =>
        db
          .insert(marketHorizon)
          .values(batch)
          .onConflictDoUpdate({
            target: [marketHorizon.listingId, marketHorizon.horizonDays],
            set: {
              marketOccupancy: sql`excluded.market_occupancy`,
              marketAdr: sql`excluded.market_adr`,
              theirOwnOccupancy: sql`excluded.their_own_occupancy`,
              theirMpi: sql`excluded.their_mpi`,
              compSetListings: sql`excluded.comp_set_listings`,
              capturedAt: sql`excluded.captured_at`,
            },
          }),
      );

      // ── The bedroom category ────────────────────────────────────────────────
      // Picked by the unit's TRUE bedroom count, not by how PriceLabs registered
      // the listing. O.308 is registered there as 1-bedroom despite having two, so
      // its own pricing engine benchmarks it against the wrong comp set — but the
      // neighborhood payload carries every category, so reading '2' here gets the
      // right benchmark regardless. Fixing the listing in PriceLabs is still worth
      // doing; it is what drives their recommendation.
      const cat = catForCompSet;
      const occBlock = neighborhood['Future Occ/New/Canc'];
      const priceBlock = neighborhood['Future Percentile Prices'];
      const kpiBlock = neighborhood['Market KPI'];
      entry.compSetListings = compSetListings;

      // ── Daily: market occupancy + percentiles + our own prices ──────────────
      const draft = new Map<string, MarketDailyDraft>();
      const put = (date: string): MarketDailyDraft => {
        const existing = draft.get(date);
        if (existing) return existing;
        const fresh: MarketDailyDraft = { stayDate: date };
        draft.set(date, fresh);
        return fresh;
      };

      const occCat = occBlock?.Category?.[cat];
      if (occCat) {
        const labels = occBlock?.Labels;
        const occupancy = series(occCat, labels, 'Occupancy');
        const occupancyStly = series(occCat, labels, 'Occupancy_STLY');
        const pickup = series(occCat, labels, 'New Bookings');
        const cancels = series(occCat, labels, 'Canceled Bookings');
        const supply = series(occCat, labels, 'Total_Available_Listings');
        const supplyLy = series(occCat, labels, 'Total_Available_Listings_LY');
        occCat.X_values.forEach((date, i) => {
          const row = put(date);
          row.marketOccupancy = occupancy[i] == null ? null : occupancy[i]! / 100;
          row.marketOccupancyStly = occupancyStly[i] == null ? null : occupancyStly[i]! / 100;
          row.marketPickup7 = pickup[i] == null ? null : pickup[i]! / 100;
          row.marketCancellations7 = cancels[i] == null ? null : cancels[i]! / 100;
          row.marketSupply = supply[i] == null ? null : Math.round(supply[i]!);
          row.marketSupplyStly = supplyLy[i] == null ? null : Math.round(supplyLy[i]!);
        });
      }

      const priceCat = priceBlock?.Category?.[cat];
      if (priceCat) {
        const labels = priceBlock?.Labels;
        const p25 = series(priceCat, labels, '25th Percentile');
        const p50 = series(priceCat, labels, '50th Percentile');
        const p75 = series(priceCat, labels, '75th Percentile');
        const p90 = series(priceCat, labels, '90th Percentile');
        const booked = series(priceCat, labels, 'Median Booked Price');
        const nBookings = series(priceCat, labels, 'N_Bookings');
        priceCat.X_values.forEach((date, i) => {
          const row = put(date);
          row.p25 = p25[i] ?? null;
          row.p50 = p50[i] ?? null;
          row.p75 = p75[i] ?? null;
          row.p90 = p90[i] ?? null;
          row.medianBookedPrice = booked[i] ?? null;
          row.nBookings = nBookings[i] ?? null;
        });
      }

      for (const day of prices?.data ?? []) {
        const row = put(day.date);
        row.recommendedPrice = plNumber(day.price);
        // user_price is -1 when the night is already sold or closed, which is not
        // the same as "priced at zero" — plNumber maps their sentinel to null.
        row.livePrice = plNumber(day.user_price);
        // Demand classification. 'Unavailable' describes OUR calendar, not the
        // market — store it verbatim (the radar needs to distinguish "hot date
        // we can't sell" from "hot date we can"), but nothing downstream may
        // average over it as if it were a demand level.
        row.demandDesc = day.demand_desc ?? null;
        row.demandColor = day.demand_color ?? null;
        row.minStay = plNumber(day.min_stay) === null ? null : Math.round(plNumber(day.min_stay)!);
      }

      const dailyRows = [...draft.values()].map((d) => ({
        listingId,
        stayDate: d.stayDate,
        marketOccupancy: str(d.marketOccupancy),
        marketOccupancyStly: str(d.marketOccupancyStly),
        marketPickup7: str(d.marketPickup7),
        marketCancellations7: str(d.marketCancellations7),
        marketSupply: d.marketSupply ?? null,
        marketSupplyStly: d.marketSupplyStly ?? null,
        p25: str(d.p25),
        p50: str(d.p50),
        p75: str(d.p75),
        p90: str(d.p90),
        medianBookedPrice: str(d.medianBookedPrice),
        recommendedPrice: str(d.recommendedPrice),
        livePrice: str(d.livePrice),
        demandDesc: d.demandDesc ?? null,
        demandColor: d.demandColor ?? null,
        minStay: d.minStay ?? null,
        nBookings: str(d.nBookings),
        capturedAt: new Date(),
      }));

      entry.dailyRows = await chunked(dailyRows, (batch) =>
        db
          .insert(marketDaily)
          .values(batch)
          .onConflictDoUpdate({
            target: [marketDaily.listingId, marketDaily.stayDate],
            set: {
              marketOccupancy: sql`excluded.market_occupancy`,
              marketOccupancyStly: sql`excluded.market_occupancy_stly`,
              marketPickup7: sql`excluded.market_pickup_7`,
              marketCancellations7: sql`excluded.market_cancellations_7`,
              marketSupply: sql`excluded.market_supply`,
              marketSupplyStly: sql`excluded.market_supply_stly`,
              p25: sql`excluded.p25`,
              p50: sql`excluded.p50`,
              p75: sql`excluded.p75`,
              p90: sql`excluded.p90`,
              medianBookedPrice: sql`excluded.median_booked_price`,
              recommendedPrice: sql`excluded.recommended_price`,
              livePrice: sql`excluded.live_price`,
              demandDesc: sql`excluded.demand_desc`,
              demandColor: sql`excluded.demand_color`,
              minStay: sql`excluded.min_stay`,
              nBookings: sql`excluded.n_bookings`,
              capturedAt: sql`excluded.captured_at`,
            },
          }),
      );

      // ── Monthly market KPIs ────────────────────────────────────────────────
      const kpiCat = kpiBlock?.Category?.[cat];
      if (kpiCat) {
        const labels = kpiBlock?.Labels;
        const availDays = series(kpiCat, labels, 'Total Available Days');
        const bookedDays = series(kpiCat, labels, 'Total Booked Days');
        const window = series(kpiCat, labels, 'Booking Window');
        const los = series(kpiCat, labels, 'LOS');
        const revenue = series(kpiCat, labels, 'Revenue');
        const pickup = series(kpiCat, labels, '7 Day Pickup');
        const pickupStly = series(kpiCat, labels, '7 Day Pickup STLY');

        const monthlyRows = kpiCat.X_values.flatMap((label, i) => {
          // Their last two entries are aggregates ("Last 365 Days"), not months.
          const month = monthLabelToIso(label);
          if (!month) return [];
          const avail = availDays[i];
          const booked = bookedDays[i];
          const rev = revenue[i];
          return [
            {
              listingId,
              month,
              marketBookingWindow: str(window[i]),
              marketLos: str(los[i]),
              marketOccupancy: avail && booked != null && avail > 0 ? String(booked / avail) : null,
              marketAdr: rev != null && booked != null && booked > 0 ? String(rev / booked) : null,
              marketPickup7: pickup[i] == null ? null : Math.round(pickup[i]!),
              marketPickup7Stly: pickupStly[i] == null ? null : Math.round(pickupStly[i]!),
              capturedAt: new Date(),
            },
          ];
        });

        entry.monthlyRows = await chunked(monthlyRows, (batch) =>
          db
            .insert(marketMonthly)
            .values(batch)
            .onConflictDoUpdate({
              target: [marketMonthly.listingId, marketMonthly.month],
              set: {
                marketBookingWindow: sql`excluded.market_booking_window`,
                marketLos: sql`excluded.market_los`,
                marketOccupancy: sql`excluded.market_occupancy`,
                marketAdr: sql`excluded.market_adr`,
                marketPickup7: sql`excluded.market_pickup_7`,
                marketPickup7Stly: sql`excluded.market_pickup_7_stly`,
                capturedAt: sql`excluded.captured_at`,
              },
            }),
        );
      }
    } catch (err) {
      entry.error = err instanceof Error ? err.message : 'Unknown error';
      console.error('[market-refresh]', listingId, err);
    }

    results.push(entry);
  }

  return {
    configured: true,
    listings: results,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** Drizzle wants `numeric` as a string; null stays null. */
function str(value: number | null | undefined): string | null {
  return value === null || value === undefined || !Number.isFinite(value) ? null : String(value);
}
