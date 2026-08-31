/**
 * Parity alert-rule config persistence — one JSON document in app_settings.
 * The operator edits it in the Pricing tab; the board colours and the ingest
 * route's Telegram alerts both read it, so a save changes everything at once
 * (prospectively — history is never re-judged).
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import {
  defaultParityRules,
  sanitizeRuleConfig,
  type ParityRuleConfig,
} from '@/utils/parityRules';

const KEY = 'parity:alert-rules';

export async function readParityRuleConfig(): Promise<ParityRuleConfig> {
  try {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY)).limit(1);
    if (row) {
      const parsed = sanitizeRuleConfig((row.value as { config?: unknown })?.config ?? row.value);
      if (parsed) return parsed;
      console.error('[parity-rules] stored config failed validation — using defaults');
    }
  } catch (err) {
    console.error('[parity-rules] read failed — using defaults', err);
  }
  return defaultParityRules();
}

export async function saveParityRuleConfig(
  config: ParityRuleConfig,
  updatedBy: string | null,
): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key: KEY, value: { config, updatedBy }, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: { config, updatedBy }, updatedAt: new Date() },
    });
}
