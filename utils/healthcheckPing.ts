/**
 * Dead man's switch for the watchdog route (app/api/webhook/watchdog): every
 * run pings healthchecks.io, which emails the operator when the pings STOP —
 * cron-job.org stopped or disabled the job, the route broke, Vercel is down,
 * the secret is wrong. Our own code can never report its own absence; this is
 * the one check that lives outside the system.
 *
 * HEALTHCHECK_PING_URL (Vercel env) is the check's ping URL. Unset = no ping.
 * Never throws and never waits more than 5 s.
 */

/** healthchecks.io convention: `<url>/fail` marks the run as failed. */
export function healthcheckPingTarget(base: string, failed: boolean): string {
  const url = base.trim().replace(/\/+$/, '');
  return failed ? `${url}/fail` : url;
}

export async function pingHealthcheck(failures: string[]): Promise<void> {
  const base = process.env.HEALTHCHECK_PING_URL?.trim();
  if (!base) return;
  try {
    await fetch(healthcheckPingTarget(base, failures.length > 0), {
      method: 'POST',
      // Shown in the healthchecks.io event log: what failed, or "ok".
      body: failures.length > 0 ? failures.join('\n').slice(0, 10_000) : 'ok',
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });
  } catch (err) {
    console.warn('[healthcheck] ping failed:', err);
  }
}
