/**
 * Corporate commission → Beds24 (server-side).
 *
 * Reads the agreement's created bookings straight from Beds24 by id (one GET
 * per 50 bookings — the cache could be minutes stale right after a price edit),
 * plans the change with `planCommissionSync`, and writes only the bookings
 * whose commission differs, in array POSTs.
 *
 * Writing a commission is idempotent: the same `{ id, commission }` sent twice
 * leaves the same booking. So unlike booking creation, an ambiguous Beds24
 * reply is simply reported as "check again" — a retry can never duplicate.
 *
 * Only the record the agreement created is written, never its sub-bookings:
 * for a direct booking group mergeGroupedBookings takes price AND commission
 * from that record, so writing the subs too would count the rebate twice.
 */
import { BEDS24_API_BASE } from './beds24Reservations';
import { getAccessToken } from './beds24Auth';
import { asArray, CREATE_CHUNK_SIZE, describeBeds24Failure, postBeds24Bookings } from './corporateBooking';
import { planCommissionSync, type CommissionSyncResult, type LiveBookingMoney } from './corporateCommission';
import type { CorporateStay } from './corporateShared';

const READ_CHUNK_SIZE = 50;

export type { CommissionSyncResult };

/** Money fields of the given Beds24 bookings, keyed by id. Throws on a non-2xx reply. */
export async function fetchLiveBookingMoney(token: string, ids: number[]): Promise<Map<number, LiveBookingMoney>> {
  const out = new Map<number, LiveBookingMoney>();
  for (let i = 0; i < ids.length; i += READ_CHUNK_SIZE) {
    const params = new URLSearchParams();
    for (const id of ids.slice(i, i + READ_CHUNK_SIZE)) params.append('id', String(id));
    // Cancelled too, so a booking cancelled in Beds24 reads as "cancelled", not "missing".
    for (const s of ['confirmed', 'new', 'request', 'cancelled']) params.append('status', s);
    const res = await fetch(`${BEDS24_API_BASE}/bookings?${params}`, { headers: { token }, cache: 'no-store' });
    if (!res.ok) throw new Error(`Beds24 ${res.status}: ${(await res.text()).slice(0, 300)}`);
    for (const row of asArray(await res.json()) as Record<string, unknown>[]) {
      const id = Number(row.id);
      if (!Number.isFinite(id)) continue;
      out.set(id, {
        id,
        price: Number(row.price ?? 0) || 0,
        commission: Number(row.commission ?? 0) || 0,
        status: String(row.status ?? ''),
      });
    }
  }
  return out;
}

/**
 * Compare (and with `apply`, fix) the Beds24 commission on every created stay.
 * Never throws: a Beds24 outage comes back as `error`, per-booking refusals as
 * `failed`, so the caller can save the agreement and still report the push.
 */
export async function syncAgreementCommission(
  percent: number,
  stays: Pick<CorporateStay, 'id' | 'seq' | 'status' | 'beds24BookingId' | 'reservationNumber'>[],
  options: { apply: boolean },
): Promise<CommissionSyncResult> {
  const result: CommissionSyncResult = { percent, items: [], updated: [], failed: [], error: null };
  const ids = stays.filter((s) => s.status === 'created' && s.beds24BookingId).map((s) => s.beds24BookingId as number);
  if (ids.length === 0) return result;

  let token: string;
  let live: Map<number, LiveBookingMoney>;
  try {
    token = await getAccessToken();
    live = await fetchLiveBookingMoney(token, ids);
  } catch (err) {
    result.error = `Beds24 could not be read: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  result.items = planCommissionSync(stays, live, percent);
  if (!options.apply) return result;

  const toWrite = result.items.filter((i) => i.action === 'update');
  for (let i = 0; i < toWrite.length; i += CREATE_CHUNK_SIZE) {
    const chunk = toWrite.slice(i, i + CREATE_CHUNK_SIZE);
    let replies: unknown[];
    try {
      replies = asArray(await postBeds24Bookings(token, chunk.map((c) => ({ id: c.bookingId, commission: c.targetCzk ?? 0 }))));
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const c of chunk) result.failed.push({ stayId: c.stayId, error });
      continue;
    }
    chunk.forEach((c, k) => {
      if (replies.length !== chunk.length) {
        result.failed.push({ stayId: c.stayId, error: 'Beds24 reply could not be matched — check again (safe to repeat).' });
        return;
      }
      const reply = replies[k];
      if ((reply as { success?: unknown } | null)?.success === false) {
        result.failed.push({ stayId: c.stayId, error: describeBeds24Failure(reply) });
        return;
      }
      c.currentCzk = c.targetCzk;
      c.action = 'in-sync';
      result.updated.push(c.stayId);
    });
  }
  return result;
}
