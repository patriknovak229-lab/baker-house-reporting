/**
 * Flag-aware store for the reservation-override overlay — the single read/write
 * boundary the local-state CRUD, the per-field mutators (ratings, non-arrival,
 * invoice-data, post-stay, parking, issues), the payment reconciliation engine
 * (utils/paymentReconcile) and the bookings merge use instead of touching Redis
 * directly. `STORE_RESERVATION_OVERRIDES` (redis|dual|postgres, default redis)
 * selects the backend; the Postgres repository is imported lazily.
 *
 * The value is the WHOLE map `Record<reservationNumber, fields>`. readAll/writeAll
 * are generic over the caller's local override shape (e.g. LocalFields) so each
 * call site keeps its type with no cast. Preserves the routes' whole-map
 * read-modify-write semantics (and its inherent last-writer-wins race) exactly.
 *
 * HARD-RULE domain — storage swap only; no merge/booking/payment logic changes.
 */
import { Redis } from '@upstash/redis';
import { readsFromPostgres, writesToPostgres, writesToRedis } from '@/lib/dataStore';

const KEY = 'baker:reservation-overrides';
const DOMAIN = 'reservationOverrides' as const;

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function pg() {
  return import('@/data-access/reservationOverrides');
}

export async function readAllReservationOverrides<T = unknown>(): Promise<Record<string, T>> {
  if (readsFromPostgres(DOMAIN)) return (await pg()).listReservationOverridesPg<T>();
  const redis = getRedis();
  if (!redis) return {};
  return (await redis.get<Record<string, T>>(KEY)) ?? {};
}

export async function writeAllReservationOverrides<T = unknown>(map: Record<string, T>): Promise<void> {
  if (writesToRedis(DOMAIN)) {
    const redis = getRedis();
    if (!redis) throw new Error('Redis not configured');
    await redis.set(KEY, map);
  }
  if (writesToPostgres(DOMAIN)) {
    await (await pg()).replaceAllReservationOverridesPg(map);
  }
}
