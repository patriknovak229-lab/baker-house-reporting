/**
 * Postgres repository for corporate agreements + stays (lib/db/schema/corporate.ts).
 *
 * Postgres-only — a new domain, so no `STORE_*` flag and no Redis path.
 * Converts between the row shape (numeric → string, timestamps → Date) and the
 * DTOs in utils/corporateShared.ts that the API and the client speak.
 */
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { corporateAgreements, corporateStays } from '@/lib/db/schema';
import type {
  CorporateAgreementInsert,
  CorporateAgreementRow,
  CorporateStayInsert,
  CorporateStayRow,
} from '@/lib/db/schema/corporate';
import {
  summariseStays,
  type AgreementDetail,
  type AgreementListItem,
  type CorporateAgreement,
  type CorporateStay,
} from '@/utils/corporateShared';

// ─── Ids ─────────────────────────────────────────────────────────────────────

export function newAgreementId(at = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `CA-${at.toString(36)}-${rand}`;
}

/** `CS-<agreement suffix>-<seq, 3 digits>` — unique because (agreement, seq) is. */
export function stayIdFor(agreementId: string, seq: number): string {
  return `CS-${agreementId.replace(/^CA-/, '')}-${String(seq).padStart(3, '0')}`;
}

// ─── Row ↔ DTO ───────────────────────────────────────────────────────────────

const toNum = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Drizzle's numeric columns take strings; round to whole CZK on the way in. */
export const czkToDb = (n: number | null | undefined): string | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : String(Math.round(n));

export function agreementRowToDto(r: CorporateAgreementRow): CorporateAgreement {
  return {
    id: r.id,
    companyName: r.companyName,
    companyAddress: r.companyAddress,
    ico: r.ico,
    vatNumber: r.vatNumber,
    billingEmail: r.billingEmail,
    billingCadence: r.billingCadence,
    repName: r.repName,
    repPhone: r.repPhone,
    repEmail: r.repEmail,
    guestFirstName: r.guestFirstName,
    guestLastName: r.guestLastName,
    guestPhone: r.guestPhone,
    guestEmail: r.guestEmail,
    adults: r.adults,
    children: r.children,
    nationality: r.nationality,
    roomIds: Array.isArray(r.roomIds) ? r.roomIds : [],
    preferredRoomId: r.preferredRoomId,
    startDate: r.startDate,
    endDate: r.endDate,
    nightWeekdays: Array.isArray(r.nightWeekdays) ? r.nightWeekdays : [],
    pricingMode: r.pricingMode,
    flatNightPriceCzk: toNum(r.flatNightPriceCzk),
    discountPercent: toNum(r.discountPercent) ?? 0,
    notes: r.notes,
    status: r.status,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function stayRowToDto(r: CorporateStayRow): CorporateStay {
  return {
    id: r.id,
    agreementId: r.agreementId,
    seq: r.seq,
    arrival: r.arrival,
    departure: r.departure,
    nights: r.nights,
    roomId: r.roomId,
    guestFirstName: r.guestFirstName,
    guestLastName: r.guestLastName,
    guestPhone: r.guestPhone,
    guestEmail: r.guestEmail,
    listPriceCzk: toNum(r.listPriceCzk),
    priceCzk: toNum(r.priceCzk),
    priceSource: r.priceSource,
    status: r.status,
    beds24BookingId: r.beds24BookingId,
    reservationNumber: r.reservationNumber,
    error: r.error,
    bookedAt: r.bookedAt ? r.bookedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// ─── Agreements ──────────────────────────────────────────────────────────────

/**
 * Save an agreement and its generated stays together. neon-http has no
 * session transactions, but `db.batch` runs its statements in one, so a
 * failure leaves neither half behind.
 */
export async function insertAgreementWithStays(
  agreement: CorporateAgreementInsert,
  stays: CorporateStayInsert[],
): Promise<void> {
  if (stays.length === 0) {
    await db.insert(corporateAgreements).values(agreement);
    return;
  }
  await db.batch([
    db.insert(corporateAgreements).values(agreement),
    db.insert(corporateStays).values(stays),
  ]);
}

/** Every agreement, newest first, each with its stay roll-up. */
export async function listAgreements(): Promise<AgreementListItem[]> {
  const [agreements, stays] = await Promise.all([
    db.select().from(corporateAgreements).orderBy(desc(corporateAgreements.createdAt)),
    db
      .select({
        agreementId: corporateStays.agreementId,
        status: corporateStays.status,
        nights: corporateStays.nights,
        priceCzk: corporateStays.priceCzk,
        arrival: corporateStays.arrival,
        departure: corporateStays.departure,
      })
      .from(corporateStays),
  ]);
  const byAgreement = new Map<string, typeof stays>();
  for (const s of stays) {
    const list = byAgreement.get(s.agreementId) ?? [];
    list.push(s);
    byAgreement.set(s.agreementId, list);
  }
  return agreements.map((a) => ({
    ...agreementRowToDto(a),
    summary: summariseStays(
      (byAgreement.get(a.id) ?? []).map((s) => ({ ...s, priceCzk: toNum(s.priceCzk) })),
    ),
  }));
}

export async function getAgreement(id: string): Promise<CorporateAgreement | null> {
  const rows = await db.select().from(corporateAgreements).where(eq(corporateAgreements.id, id)).limit(1);
  return rows[0] ? agreementRowToDto(rows[0]) : null;
}

export async function listStays(agreementId: string): Promise<CorporateStay[]> {
  const rows = await db
    .select()
    .from(corporateStays)
    .where(eq(corporateStays.agreementId, agreementId))
    .orderBy(asc(corporateStays.seq));
  return rows.map(stayRowToDto);
}

export async function getAgreementDetail(id: string): Promise<AgreementDetail | null> {
  const [agreement, stays] = await Promise.all([getAgreement(id), listStays(id)]);
  if (!agreement) return null;
  return { ...agreement, stays, summary: summariseStays(stays) };
}

export async function updateAgreement(
  id: string,
  patch: Partial<CorporateAgreementInsert>,
): Promise<CorporateAgreement | null> {
  const rows = await db
    .update(corporateAgreements)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(corporateAgreements.id, id))
    .returning();
  return rows[0] ? agreementRowToDto(rows[0]) : null;
}

/** Removes the agreement AND its stays (cascade). Caller checks nothing is live in Beds24. */
export async function deleteAgreement(id: string): Promise<boolean> {
  const rows = await db
    .delete(corporateAgreements)
    .where(eq(corporateAgreements.id, id))
    .returning({ id: corporateAgreements.id });
  return rows.length > 0;
}

// ─── Stays ───────────────────────────────────────────────────────────────────

export async function getStay(id: string): Promise<CorporateStay | null> {
  const rows = await db.select().from(corporateStays).where(eq(corporateStays.id, id)).limit(1);
  return rows[0] ? stayRowToDto(rows[0]) : null;
}

export async function getStays(ids: string[]): Promise<CorporateStay[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(corporateStays).where(inArray(corporateStays.id, ids));
  return rows.map(stayRowToDto);
}

export async function updateStay(
  id: string,
  patch: Partial<CorporateStayInsert>,
): Promise<CorporateStay | null> {
  const rows = await db
    .update(corporateStays)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(corporateStays.id, id))
    .returning();
  return rows[0] ? stayRowToDto(rows[0]) : null;
}

/**
 * Record what Beds24 said about each stay after a create batch. Sequential on
 * purpose: by the time this runs the bookings EXIST, so every row that can be
 * saved must be — one failed statement must not roll back the others' ids,
 * which is exactly what a batch would do. Returns the ids that could not be
 * written so the caller can shout about them.
 */
export async function recordStayOutcomes(
  outcomes: { id: string; patch: Partial<CorporateStayInsert> }[],
): Promise<string[]> {
  const unsaved: string[] = [];
  for (const o of outcomes) {
    try {
      await db
        .update(corporateStays)
        .set({ ...o.patch, updatedAt: sql`now()` })
        .where(eq(corporateStays.id, o.id));
    } catch (err) {
      console.error(`[corporate] failed to record outcome for ${o.id}:`, err);
      unsaved.push(o.id);
    }
  }
  return unsaved;
}
