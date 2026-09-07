/**
 * The reporting → cleaning publish channel for rate perks.
 *
 * Reporting owns the rate → perk mapping and the operator overrides; the
 * cleaning app only reflects the EFFECTIVE result, which it reads straight
 * from these shared Redis maps (keyed by reservationNumber, "BH-<bookId>").
 *
 * Two writers, deliberately:
 *   - `persistRateTypeMap` (app/api/bookings) rewrites BOTH maps wholesale on
 *     every sync — the authoritative pass, so a cancelled / re-rated / modified
 *     reservation self-corrects.
 *   - `publishRatePerksEntry` (here) patches a SINGLE reservation's perk entry
 *     the moment the operator saves an override, so an ad-hoc special treatment
 *     reaches the cleaner without waiting for the next sync.
 *
 * Both derive the value from the same stored override, so they converge; the
 * wholesale pass wins any race and remains the source of truth.
 *
 * NOTE: these maps stay on Redis on purpose — they're the cross-app channel,
 * not a reporting-owned storage domain. The cleaning app reads the same keys
 * directly (see baker-house-cleaning src/lib/storage.ts).
 */
import { getRedis } from "@/utils/beds24Reservations";
import { autoRatePerks, effectiveRatePerks, hasAnyPerk } from "@/utils/ratePerks";
import type { PerkOverrides, RatePerks } from "@/utils/ratePerks";
import type { RateType } from "@/types/reservation";

export const RATE_TYPES_KEY = "baker:reservation-rate-types";
export const RATE_PERKS_KEY = "baker:reservation-rate-perks";

/**
 * Compute one reservation's effective perks and patch it into the shared map.
 * `perkOverrides` comes from the caller's already-read override entry, so the
 * note text is the stored one — never a client-supplied string.
 *
 * A reservation with no perks at all is REMOVED from the map (mirrors the
 * wholesale pass, which only publishes entries that carry a perk).
 * Best-effort: a Redis failure throws to the caller, which treats it as
 * non-fatal — the next sync republishes anyway.
 */
export async function publishRatePerksEntry(
  reservationNumber: string,
  rate: RateType | null,
  reservationDate: string | null | undefined,
  perkOverrides: PerkOverrides | undefined,
): Promise<RatePerks | null> {
  const redis = getRedis();
  if (!redis) return null;

  const perks = effectiveRatePerks(autoRatePerks(rate, reservationDate), perkOverrides);
  const map = (await redis.get<Record<string, RatePerks>>(RATE_PERKS_KEY)) ?? {};

  if (hasAnyPerk(perks)) map[reservationNumber] = perks;
  else delete map[reservationNumber];

  // The rate map is keyed the same way; keep it in step so the cleaning app's
  // rate lookups don't lag a manual rate-type override.
  const rateMap = (await redis.get<Record<string, RateType>>(RATE_TYPES_KEY)) ?? {};
  if (rate) rateMap[reservationNumber] = rate;
  else delete rateMap[reservationNumber];

  await Promise.all([redis.set(RATE_PERKS_KEY, map), redis.set(RATE_TYPES_KEY, rateMap)]);
  return perks;
}

/**
 * Drop a reservation from both maps — for a cancellation, which the
 * authoritative pass skips entirely (so it would otherwise leave a stale
 * entry behind until the next sync).
 */
export async function removeRatePerksEntry(reservationNumber: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const [map, rateMap] = await Promise.all([
    redis.get<Record<string, RatePerks>>(RATE_PERKS_KEY),
    redis.get<Record<string, RateType>>(RATE_TYPES_KEY),
  ]);
  const perks = map ?? {};
  const rates = rateMap ?? {};
  delete perks[reservationNumber];
  delete rates[reservationNumber];
  await Promise.all([redis.set(RATE_PERKS_KEY, perks), redis.set(RATE_TYPES_KEY, rates)]);
}
