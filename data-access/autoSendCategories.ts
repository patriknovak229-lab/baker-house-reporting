/**
 * Which auto-reply categories the operator has flipped to AUTO-SEND (skip the
 * operator review queue — the composed reply goes straight to the guest).
 *
 * Stored as ONE app_settings row keyed 'auto-reply-autosend-categories',
 * value = string[] of category names. No row / empty array = everything stays
 * in review (the safe default). Mirrors the app_settings key-value pattern used
 * by gmailInvoiceToken.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';

const SETTING = 'auto-reply-autosend-categories';

/**
 * Categories that can NEVER auto-send, filtered out on write so they can't be
 * enabled by mistake: 'other' is a heterogeneous catch-all; 'invoice-request'
 * is handled by the deterministic invoice flow (it never reaches the composer
 * gate), so enabling it here would do nothing.
 */
const NON_TOGGLEABLE = new Set(['other', 'invoice-request']);

export async function readAutoSendCategories(): Promise<string[]> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTING)).limit(1);
  const v = row?.value;
  return Array.isArray(v)
    ? (v as unknown[]).filter((c): c is string => typeof c === 'string')
    : [];
}

export async function writeAutoSendCategories(categories: string[]): Promise<string[]> {
  const value = [
    ...new Set(categories.filter((c) => typeof c === 'string' && !NON_TOGGLEABLE.has(c))),
  ];
  const now = new Date();
  await db
    .insert(appSettings)
    .values({ key: SETTING, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
  return value;
}
