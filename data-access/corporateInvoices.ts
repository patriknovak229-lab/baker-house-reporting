/**
 * Postgres repository for corporate invoices (lib/db/schema/corporate.ts →
 * corporate_invoices). Postgres-only, like the agreements themselves.
 *
 * Converts between the row shape (numeric → string, timestamps → Date) and the
 * CorporateInvoice DTO in utils/corporateInvoice.ts.
 */
import { and, asc, eq, inArray, isNull, like, lte, sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { corporateInvoices } from '@/lib/db/schema';
import type { CorporateInvoiceInsert, CorporateInvoiceRow } from '@/lib/db/schema/corporate';
import {
  CORPORATE_INVOICE_NUMBER_RE,
  corporateInvoiceNumber,
  type CorporateInvoice,
  type CorporateInvoiceStatus,
} from '@/utils/corporateInvoice';

export function newInvoiceId(at = Date.now()): string {
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `CI-${at.toString(36)}-${rand}`;
}

const toNum = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

/** numeric(12,2) takes strings; keep the haléře. */
export const amountToDb = (n: number | null | undefined): string | null =>
  n === null || n === undefined || !Number.isFinite(n) ? null : (Math.round(n * 100) / 100).toFixed(2);

export function invoiceRowToDto(r: CorporateInvoiceRow): CorporateInvoice {
  return {
    id: r.id,
    agreementId: r.agreementId,
    kind: r.kind,
    status: r.status,
    periodFrom: r.periodFrom,
    periodTo: r.periodTo,
    billedMonth: r.billedMonth,
    issueDate: r.issueDate,
    dueDate: r.dueDate,
    dueRule: r.dueRule ?? null,
    includePaymentDetails: r.includePaymentDetails,
    invoiceNumber: r.invoiceNumber,
    amountCzk: toNum(r.amountCzk),
    lines: r.lines ?? null,
    billTo: r.billTo ?? null,
    sentAt: r.sentAt ? r.sentAt.toISOString() : null,
    sentTo: r.sentTo,
    sendCount: r.sendCount,
    paidAt: r.paidAt,
    paidSource: r.paidSource ?? null,
    paymentCheckSnoozedUntil: r.paymentCheckSnoozedUntil,
    error: r.error,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function insertInvoices(rows: CorporateInvoiceInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(corporateInvoices).values(rows);
}

export async function listInvoicesForAgreement(agreementId: string): Promise<CorporateInvoice[]> {
  const rows = await db
    .select()
    .from(corporateInvoices)
    .where(eq(corporateInvoices.agreementId, agreementId))
    .orderBy(asc(corporateInvoices.periodFrom), asc(corporateInvoices.createdAt));
  return rows.map(invoiceRowToDto);
}

export async function getInvoice(id: string): Promise<CorporateInvoice | null> {
  const rows = await db.select().from(corporateInvoices).where(eq(corporateInvoices.id, id)).limit(1);
  return rows[0] ? invoiceRowToDto(rows[0]) : null;
}

export async function listInvoicesByStatus(statuses: CorporateInvoiceStatus[]): Promise<CorporateInvoice[]> {
  const rows = await db
    .select()
    .from(corporateInvoices)
    .where(inArray(corporateInvoices.status, statuses))
    .orderBy(asc(corporateInvoices.dueDate));
  return rows.map(invoiceRowToDto);
}

/** Scheduled invoices whose issue date has come. */
export async function listDueScheduledInvoices(today: string): Promise<CorporateInvoice[]> {
  const rows = await db
    .select()
    .from(corporateInvoices)
    .where(and(eq(corporateInvoices.status, 'scheduled'), lte(corporateInvoices.issueDate, today)))
    .orderBy(asc(corporateInvoices.issueDate));
  return rows.map(invoiceRowToDto);
}

/** Any invoice of this agreement that has a number — blocks deleting the agreement. */
export async function agreementHasIssuedInvoices(agreementId: string): Promise<boolean> {
  const rows = await db
    .select({ id: corporateInvoices.id })
    .from(corporateInvoices)
    .where(and(eq(corporateInvoices.agreementId, agreementId), sql`${corporateInvoices.invoiceNumber} IS NOT NULL`))
    .limit(1);
  return rows.length > 0;
}

export async function updateInvoice(
  id: string,
  patch: Partial<CorporateInvoiceInsert>,
): Promise<CorporateInvoice | null> {
  const rows = await db
    .update(corporateInvoices)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(corporateInvoices.id, id))
    .returning();
  return rows[0] ? invoiceRowToDto(rows[0]) : null;
}

/** Hard delete — only for a scheduled invoice that never got a number. */
export async function deleteScheduledInvoice(id: string): Promise<boolean> {
  const rows = await db
    .delete(corporateInvoices)
    .where(and(eq(corporateInvoices.id, id), isNull(corporateInvoices.invoiceNumber)))
    .returning({ id: corporateInvoices.id });
  return rows.length > 0;
}

/** Highest sequence used this year (0 when none). */
async function maxSequence(year: number): Promise<number> {
  const rows = await db
    .select({ n: corporateInvoices.invoiceNumber })
    .from(corporateInvoices)
    .where(like(corporateInvoices.invoiceNumber, `INV-C${year}-%`));
  let max = 0;
  for (const r of rows) {
    const m = r.n?.match(CORPORATE_INVOICE_NUMBER_RE);
    if (m && Number(m[1]) === year) max = Math.max(max, Number(m[2]));
  }
  return max;
}

/**
 * Give an un-numbered invoice the next number of `year` and freeze what it
 * bills, in ONE conditional UPDATE (`… AND invoice_number IS NULL`). Returns
 * the issued invoice, or null when someone else numbered it first — the caller
 * must then stop, not retry: the other sender owns it.
 *
 * A unique-index collision (two different invoices taking the same next
 * number) is retried with a fresh maximum.
 */
export async function numberAndFreezeInvoice(
  id: string,
  year: number,
  freeze: Partial<CorporateInvoiceInsert>,
): Promise<CorporateInvoice | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const invoiceNumber = corporateInvoiceNumber(year, (await maxSequence(year)) + 1);
    try {
      const rows = await db
        .update(corporateInvoices)
        .set({ ...freeze, invoiceNumber, status: 'issued', error: null, updatedAt: sql`now()` })
        .where(and(eq(corporateInvoices.id, id), isNull(corporateInvoices.invoiceNumber)))
        .returning();
      return rows[0] ? invoiceRowToDto(rows[0]) : null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/corporate_invoices_number_idx|duplicate key/i.test(msg)) throw err;
    }
  }
  throw new Error('Could not allocate an invoice number after 5 attempts');
}
