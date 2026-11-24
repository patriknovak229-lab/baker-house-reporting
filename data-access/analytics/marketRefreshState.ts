/**
 * Small pieces of state the market refresh keeps between runs, so its messages
 * go out once rather than on every run:
 *
 *   - gap alerts: which PriceLabs data gaps the operator has already been told
 *     about (utils/marketRefreshHealth.planGapAlerts). A listing's entry is
 *     dropped by its next good pull, which re-arms the alert for the next gap.
 *     Value = GapAlertState (unitId → alerted-at ISO).
 *   - radar digest: the Prague date the Monday digest last went out. The 12:00
 *     catch-up can re-run a Monday refresh (a PriceLabs gap) and the operator
 *     can press Refresh, and neither should send a second digest.
 *
 * One app_settings row each.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { appSettings } from '@/lib/db/schema';
import type { GapAlertState } from '@/utils/marketRefreshHealth';

const GAP_ALERTS = 'market-refresh-gap-alerts';
const DIGEST_SENT = 'market-refresh-digest-sent';

async function read(key: string): Promise<unknown> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key)).limit(1);
  return row?.value;
}

async function write(key: string, value: unknown): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
}

export async function readGapAlertState(): Promise<GapAlertState> {
  const value = await read(GAP_ALERTS);
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as GapAlertState) : {};
}

export async function writeGapAlertState(state: GapAlertState): Promise<void> {
  await write(GAP_ALERTS, state);
}

/** Prague date (YYYY-MM-DD) the radar digest last went out, or null. */
export async function readDigestSentDate(): Promise<string | null> {
  const value = await read(DIGEST_SENT);
  return typeof value === 'string' ? value : null;
}

export async function writeDigestSentDate(date: string): Promise<void> {
  await write(DIGEST_SENT, date);
}
