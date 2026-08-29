/**
 * Server-side re-export seam for the PriceLabs client.
 *
 * `utils/priceLabs.ts` reads `process.env`, so it must never end up in a client
 * bundle. Routing every analytics import through this one module makes the
 * server-only boundary a single grep away instead of a convention people remember,
 * and gives the refresh writer somewhere to keep its own working types.
 */
export {
  fetchListingMetrics,
  fetchListingPrices,
  fetchListings,
  fetchNeighborhoodData,
  monthLabelToIso,
  plNumber,
  plPercentString,
  plRatio,
  priceLabsConfigured,
  series,
  PriceLabsError,
} from '@/utils/priceLabs';

/** One day's worth of market + own-price facts, assembled before the upsert. */
export interface MarketDailyDraft {
  stayDate: string;
  marketOccupancy?: number | null;
  marketOccupancyStly?: number | null;
  marketPickup7?: number | null;
  marketCancellations7?: number | null;
  marketSupply?: number | null;
  marketSupplyStly?: number | null;
  p25?: number | null;
  p50?: number | null;
  p75?: number | null;
  p90?: number | null;
  medianBookedPrice?: number | null;
  recommendedPrice?: number | null;
  livePrice?: number | null;
  demandDesc?: string | null;
  demandColor?: string | null;
  minStay?: number | null;
  nBookings?: number | null;
}
