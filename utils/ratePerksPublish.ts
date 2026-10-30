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
 * A multi-apartment reservation is published under EVERY apartment's own
 * booking number — the cleaning app keys each cleaning by the Beds24 booking it
 * came from, so publishing under the master alone gave the Weekly wine to one
 * apartment of three (BH-93698209). The rate and its perks are the
 * reservation's, so every apartment gets the same entry.
 *
 * NOTE: these maps stay on Redis on purpose — they're the cross-app channel,
 * not a reporting-owned storage domain. The cleaning app reads the same keys
 * directly (see baker-house-cleaning src/lib/storage.ts).
 */
import { getRedis } from "@/utils/beds24Reservations";
import { autoRatePerks, effectiveRatePerks, hasAnyPerk } from "@/utils/ratePerks";
import { cleaningFeedNumbers } from "@/utils/reservationApartments";
import type { PerkOverrides, RatePerks } from "@/utils/ratePerks";
import type { RateType, Reservation } from "@/types/reservation";

type ReservationKey = Pick<Reservation, "reservationNumber" | "apartmentReservationNumbers">;

export const RATE_TYPES_KEY = "baker:reservation-rate-types";
export const RATE_PERKS_KEY = "baker:reservation-rate-perks";

/**
 * Compute one reservation's effective perks and patch it into the shared map,
 * under each of its booking numbers. `perkOverrides` comes from the caller's
 * already-read override entry, so the note text is the stored one — never a
 * client-supplied string.
 *
 * A reservation with no perks at all is REMOVED from the map (mirrors the
 * wholesale pass, which only publishes entries that carry a perk).
 * Best-effort: a Redis failure throws to the caller, which treats it as
 * non-fatal — the next sync republishes anyway.
 */
export async function publishRatePerksEntry(
  r: ReservationKey,
  rate: RateType | null,
  reservationDate: string | null | undefined,
  perkOverrides: PerkOverrides | undefined,
): Promise<RatePerks | null> {
  const redis = getRedis();
  if (!redis) return null;

  const perks = effectiveRatePerks(autoRatePerks(rate, reservationDate), perkOverrides);
  const map = (await redis.get<Record<string, RatePerks>>(RATE_PERKS_KEY)) ?? {};
  // The rate map is keyed the same way; keep it in step so the cleaning app's
  // rate lookups don't lag a manual rate-type override.
  const rateMap = (await redis.get<Record<string, RateType>>(RATE_TYPES_KEY)) ?? {};

  for (const n of cleaningFeedNumbers(r)) {
    if (hasAnyPerk(perks)) map[n] = perks;
    else delete map[n];
    if (rate) rateMap[n] = rate;
    else delete rateMap[n];
  }

  await Promise.all([redis.set(RATE_PERKS_KEY, map), redis.set(RATE_TYPES_KEY, rateMap)]);
  return perks;
}

/**
 * Drop a reservation from both maps — for a cancellation, which the
 * authoritative pass skips entirely (so it would otherwise leave a stale
 * entry behind until the next sync).
 */
export async function removeRatePerksEntry(r: ReservationKey): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const [map, rateMap] = await Promise.all([
    redis.get<Record<string, RatePerks>>(RATE_PERKS_KEY),
    redis.get<Record<string, RateType>>(RATE_TYPES_KEY),
  ]);
  const perks = map ?? {};
  const rates = rateMap ?? {};
  for (const n of cleaningFeedNumbers(r)) {
    delete perks[n];
    delete rates[n];
  }
  await Promise.all([redis.set(RATE_PERKS_KEY, perks), redis.set(RATE_TYPES_KEY, rates)]);
}
