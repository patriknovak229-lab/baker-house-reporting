/**
 * How a PriceLabs market refresh is judged — the pure half (no I/O), shared by
 * the refresh route and its tests.
 *
 * Two kinds of listing problem, deliberately told apart:
 *   - 'error'        → our pull broke (network, timeout, database). The run
 *                      FAILED: the watchdog alerts and the 12:00 UTC catch-up
 *                      retries it, like any other job.
 *   - 'upstream-gap' → PriceLabs answered, but with no usable prices for the
 *                      listing (LISTING_NO_DATA and friends). The job did its
 *                      work; the source had a hole. The run COMPLETES with
 *                      `degraded` set: the catch-up retries it quietly (the gap
 *                      often fills within hours) and nobody is paged unless the
 *                      listing stays stale — see planGapAlerts.
 *
 * Why: until 2026-11-09 a gap counted as a failed run. LISTING_NO_DATA moves
 * between listings from day to day (3 of 4 on 8 Nov, Urban only on 9 Nov), so
 * that meant a red "job failed" alert most days for a job that was fine — the
 * noise that makes every cron alert look unreliable.
 */

export type ListingErrorKind = 'upstream-gap' | 'error';

export interface RefreshedListing {
  unitId: string;
  error: string | null;
  errorKind?: ListingErrorKind | null;
}

const isGap = (l: RefreshedListing) => !!l.error && l.errorKind === 'upstream-gap';
const isBroken = (l: RefreshedListing) => !!l.error && l.errorKind !== 'upstream-gap';

/** "3 of 4 listings failed — deluxe-1kk, k201, o308: <distinct errors>". */
function problemSummary(total: number, items: RefreshedListing[], verb: string): string {
  const errors = [...new Set(items.map((l) => l.error ?? 'unknown error'))].join('; ');
  const text = `${items.length} of ${total} listings ${verb} — ${items.map((l) => l.unitId).join(', ')}: ${errors}`;
  return text.length > 400 ? `${text.slice(0, 397)}…` : text;
}

/**
 * The heartbeat summary for a finished refresh. Only a broken pull makes the
 * run 'failed'; gaps alone complete it with `degraded` (utils/cronCatchUp reads
 * that to retry quietly).
 */
export function refreshSummary(listings: RefreshedListing[]): Record<string, unknown> {
  const broken = listings.filter(isBroken);
  const gaps = listings.filter(isGap);
  const degraded =
    gaps.length > 0
      ? { degraded: gaps.map((l) => l.unitId), degradedDetail: problemSummary(listings.length, gaps, 'had no PriceLabs data') }
      : {};
  if (broken.length > 0) {
    return {
      phase: 'failed',
      listings: listings.length,
      failedListings: broken.length,
      error: problemSummary(listings.length, broken, 'failed'),
      ...degraded,
    };
  }
  return { phase: 'completed', listings: listings.length, failedListings: 0, ...degraded };
}

/**
 * Age of the STALEST listing's last good pull, in hours. Null when any listing
 * has never had one — callers treat that as stale.
 *
 * The cron's "fresh, skip" guard used the newest row across all listings, so
 * one good listing made the whole snapshot look fresh: on 8 Nov the 12:00
 * catch-up re-ran the refresh, it skipped as "fresh" with three listings still
 * a day old, and the catch-up reported it recovered.
 */
export function stalestListingAge(agesByUnit: Record<string, number | null>): number | null {
  const ages = Object.values(agesByUnit);
  if (ages.length === 0 || ages.some((a) => a === null)) return null;
  return Math.max(...(ages as number[]));
}

/** One weekly cycle plus a day of retries. */
export const GAP_ALERT_AFTER_HOURS = 8 * 24;

/**
 * Should a listing whose PriceLabs data is missing page the operator yet?
 *
 * `hoursSinceGoodPull` = hours since this listing last got usable prices from
 * PriceLabs (null = never). Called only for listings with a gap in this run,
 * and at most once per gap: after it returns true, the listing stays quiet
 * until a good pull ends the gap (planGapAlerts).
 */
export function gapAlertDue(hoursSinceGoodPull: number | null): boolean {
  // Never pulled = a mapping/config problem, not a passing gap: say so at once.
  if (hoursSinceGoodPull === null) return true;
  // The refresh is weekly (Monday) and the catch-up retries a gap daily, so a
  // listing more than a day past its weekly pull has missed the Monday run and
  // at least two retries. Gaps seen 8–24 Nov all filled within a day.
  return hoursSinceGoodPull >= GAP_ALERT_AFTER_HOURS;
}

/** unitId → when we alerted about its current gap. Cleared by the next good pull. */
export type GapAlertState = Record<string, string>;

export interface GapAlert {
  unitId: string;
  hoursSinceGoodPull: number | null;
  error: string;
}

/**
 * Which gaps to announce now, and the state to save. One alert per gap: a
 * listing is announced once when `due` first says so, then stays quiet until a
 * clean pull clears it. A listing whose pull BROKE keeps its state — that is
 * not a good pull, and the failed run has its own alert.
 */
export function planGapAlerts(
  state: GapAlertState,
  listings: RefreshedListing[],
  agesByUnit: Record<string, number | null>,
  now: Date,
  due: (hoursSinceGoodPull: number | null) => boolean = gapAlertDue,
): { alerts: GapAlert[]; next: GapAlertState } {
  const next: GapAlertState = { ...state };
  const alerts: GapAlert[] = [];
  for (const l of listings) {
    if (!l.error) {
      delete next[l.unitId];
      continue;
    }
    if (!isGap(l) || next[l.unitId]) continue;
    const hours = agesByUnit[l.unitId] ?? null;
    if (!due(hours)) continue;
    alerts.push({ unitId: l.unitId, hoursSinceGoodPull: hours, error: l.error });
    next[l.unitId] = now.toISOString();
  }
  return { alerts, next };
}

/** Telegram body (HTML parse mode); null when there is nothing to announce. */
export function gapAlertText(alerts: GapAlert[], escape: (s: string) => string): string | null {
  if (alerts.length === 0) return null;
  return [
    '⚠️ <b>PriceLabs has no usable data</b> for:',
    ...alerts.map(
      (a) =>
        `• ${escape(a.unitId)} — ${a.hoursSinceGoodPull === null ? 'never pulled' : `last good pull ${Math.round(a.hoursSinceGoodPull)}h ago`}: ${escape(a.error)}`,
    ),
    '',
    'The radar keeps showing the last good prices for these. The catch-up keeps retrying daily; ' +
      'this is not repeated until the data comes back. If it persists, check the listing in PriceLabs.',
  ].join('\n');
}
