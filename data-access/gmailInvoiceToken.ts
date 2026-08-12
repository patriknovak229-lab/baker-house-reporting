/**
 * Postgres repository for the single Gmail-invoice OAuth credential
 * (Redis→Postgres cutover). Stored as ONE app_settings row keyed
 * 'gmail-invoice-token', value = the GmailInvoiceToken object as jsonb.
 * read/write/delete mirror the routes' redis.get / redis.set / redis.del on the
 * single key. writeGmailInvoiceTokenPg mirrors scripts/backfill/gmail-token.ts
 * (updatedAt derived from connectedAt; updated_at is metadata only — parity
 * compares the jsonb value).
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { GmailInvoiceToken } from '@/app/api/accounting/connect-gmail/callback/route';

const SETTING = 'gmail-invoice-token';

export async function readGmailInvoiceTokenPg(): Promise<GmailInvoiceToken | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  return (row?.value as GmailInvoiceToken | undefined) ?? null;
}

export async function writeGmailInvoiceTokenPg(token: GmailInvoiceToken): Promise<void> {
  const updatedAt = token.connectedAt ? new Date(token.connectedAt) : new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTING, value: token, updatedAt })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: token, updatedAt } });
}

export async function deleteGmailInvoiceTokenPg(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, SETTING));
}
