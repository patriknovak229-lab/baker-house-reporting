/**
 * The real Beds24 behind the pay-later engine (io.ts → PayLaterBeds24).
 * Server-only (the refresh token lives on Vercel).
 *
 * Writes are verified by reading the rows back: Beds24 answers success:false
 * for rows saved WITH warnings (BH-95579179), so the answer alone is not proof
 * either way.
 */
import { getAccessToken } from '@/utils/beds24Auth';
import type { Beds24Row, PayLaterBeds24 } from './io';

const BASE = 'https://beds24.com/api/v2';
const ALL_STATUSES = ['confirmed', 'new', 'request', 'cancelled', 'black', 'inquiry'];

type Raw = Record<string, unknown>;

function asArray(json: unknown): Raw[] {
  if (Array.isArray(json)) return json as Raw[];
  const data = (json as { data?: unknown })?.data;
  return Array.isArray(data) ? (data as Raw[]) : [];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const strOrNull = (v: unknown) => (typeof v === 'string' && v ? v : null);

export function toRow(b: Raw): Beds24Row {
  const items = Array.isArray(b.infoItems) ? (b.infoItems as Raw[]) : [];
  return {
    id: num(b.id),
    masterId: b.masterId == null ? null : num(b.masterId),
    status: String(b.status ?? ''),
    subStatus: strOrNull(b.subStatus),
    arrival: String(b.arrival ?? ''),
    departure: String(b.departure ?? ''),
    price: num(b.price),
    deposit: num(b.deposit),
    referer: strOrNull(b.referer),
    notes: strOrNull(b.notes),
    bookingTime: strOrNull(b.bookingTime),
    infoCodes: items.map((i) => String(i.code ?? '')).filter(Boolean),
    infoItems: items.map((i) => ({ code: String(i.code ?? ''), text: String(i.text ?? '') })).filter((i) => i.code),
    firstName: strOrNull(b.firstName),
    lastName: strOrNull(b.lastName),
    email: strOrNull(b.email),
  };
}

async function get(token: string, params: URLSearchParams): Promise<{ rows: Raw[]; next: string | null }> {
  const res = await fetch(`${BASE}/bookings?${params}`, { headers: { token }, cache: 'no-store' });
  if (!res.ok) throw new Error(`Beds24 GET ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const json = (await res.json()) as { pages?: { nextPageExists?: boolean; nextPageLink?: string } };
  return { rows: asArray(json), next: json.pages?.nextPageExists ? (json.pages.nextPageLink ?? null) : null };
}

async function post(token: string, body: unknown[]): Promise<void> {
  const res = await fetch(`${BASE}/bookings`, {
    method: 'POST',
    headers: { token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Beds24 POST ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
}

async function fetchByIds(token: string, ids: number[]): Promise<Map<number, Beds24Row>> {
  const out = new Map<number, Beds24Row>();
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams();
    for (const id of ids.slice(i, i + 50)) params.append('id', String(id));
    for (const s of ALL_STATUSES) params.append('status', s);
    params.set('includeInfoItems', 'true');
    const { rows } = await get(token, params);
    for (const r of rows) {
      const row = toRow(r);
      if (row.id) out.set(row.id, row);
    }
  }
  return out;
}

export function realBeds24(): PayLaterBeds24 {
  return {
    async fetchBookings(ids) {
      if (ids.length === 0) return new Map();
      const rows = await fetchByIds(await getAccessToken(), ids);
      // Asked for bookings and got none back: a broken answer, not "all gone".
      if (rows.size === 0) throw new Error(`Beds24 returned no rows for ${ids.length} booking id(s)`);
      return rows;
    },

    async markPaid(updates, note) {
      const token = await getAccessToken();
      await post(
        token,
        updates.map((u) => ({ id: u.id, deposit: u.deposit, infoItems: [{ code: 'PAYLATER_PAID', text: note.slice(0, 250) }] })),
      );
      const after = await fetchByIds(token, updates.map((u) => u.id));
      const missed = updates.filter((u) => (after.get(u.id)?.deposit ?? -1) + 0.5 < u.deposit);
      if (missed.length > 0) throw new Error(`Beds24 deposit not updated on ${missed.map((m) => m.id).join(', ')}`);
    },

    async cancelNonPayment(ids, note) {
      const token = await getAccessToken();
      await post(
        token,
        ids.map((id) => ({
          id,
          status: 'cancelled',
          subStatus: 'nonPayment',
          // No Beds24 email next to ours (Patrik: web payment comms are ours).
          allowAutoAction: 'disable',
          infoItems: [{ code: 'CANCELLED_BY_OWNER_NO_PAYMENT', text: note.slice(0, 250) }],
        })),
      );
      const after = await fetchByIds(token, ids);
      const still = ids.filter((id) => after.get(id)?.status !== 'cancelled');
      if (still.length > 0) throw new Error(`Beds24 did not cancel ${still.join(', ')}`);
    },

    async recentPayLaterBookings(sinceIso) {
      const token = await getAccessToken();
      const params = new URLSearchParams();
      params.set('modifiedFrom', sinceIso);
      params.set('includeInfoItems', 'true');
      const out: Beds24Row[] = [];
      let page = await get(token, params);
      for (let i = 0; i < 5; i++) {
        out.push(...page.rows.map(toRow));
        if (!page.next) break;
        const res = await fetch(page.next, { headers: { token }, cache: 'no-store' });
        if (!res.ok) break;
        const json = (await res.json()) as { pages?: { nextPageExists?: boolean; nextPageLink?: string } };
        page = { rows: asArray(json), next: json.pages?.nextPageExists ? (json.pages.nextPageLink ?? null) : null };
      }
      return out.filter((r) => r.infoCodes.includes('PAYLATER'));
    },
  };
}
