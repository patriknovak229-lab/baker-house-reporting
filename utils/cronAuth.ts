/**
 * Shared gate for platform-cron invocations.
 *
 * Extracted from app/api/analytics/market/refresh, which had already learned
 * both lessons the hard way. They are worth restating, because each one fails
 * INVISIBLY and this cron family has now been broken twice:
 *
 *  1. **Vercel invokes cron paths with GET**, not POST ("Vercel makes an HTTP
 *     GET request to your project's production deployment URL" — the cron-jobs
 *     docs). A POST-only route answers 405 to every scheduled run and does
 *     nothing, forever, with no error anywhere. That is exactly how
 *     `send-due-invoices` and `check-reviews` stayed dead even AFTER being
 *     unblocked in the middleware on 2026-09-28. Every cron route must export
 *     GET.
 *  2. **Accept every signal Vercel documents.** A gate that is too narrow
 *     answers 401 and the job quietly stops — indistinguishable from success.
 *     Notably the header is `x-vercel-cron` with an unspecified value, so test
 *     for PRESENCE; `=== '1'` is a guess that silently fails if it ever changes.
 *
 * SECURITY: `x-vercel-cron` and the user agent are NOT stripped from external
 * requests — anyone can send them, as a one-line curl demonstrates. On their own
 * they are a convention, not a credential. `CRON_SECRET` is the real lock: set
 * it in the Vercel project and Vercel sends `Authorization: Bearer <secret>` on
 * every scheduled invocation, which nothing else can forge.
 *
 * So when CRON_SECRET is set we require it and refuse the forgeable signals.
 *
 * On Vercel WITHOUT a secret we now refuse everything (2026-11-24). This gate
 * used to fail open there, to keep a missing secret from killing the jobs — but
 * since two of them move money (send-scheduled-payments, web-payments), an
 * unset or renamed CRON_SECRET would have opened them to anyone with curl. A
 * refused cron is loud instead: the watchdog reports "CRON_SECRET missing"
 * within the hour (utils/cronHeartbeat.staleCronJobs). Off Vercel (local dev)
 * the header still works, so `curl -H "x-vercel-cron: 1" localhost:3000/…`
 * keeps working against a .env.local without a secret.
 */

import type { NextRequest } from 'next/server';

export type CronAuthVia = 'cron-secret' | 'x-vercel-cron' | 'user-agent' | null;

export interface CronAuthResult {
  isCron: boolean;
  /** Which signal matched — log it, so a silent failure is diagnosable. */
  via: CronAuthVia;
  /** True when accepted on a forgeable signal because CRON_SECRET is unset (local dev only). */
  unverified: boolean;
  /** True when refused because this Vercel deployment has no CRON_SECRET. */
  missingSecret?: boolean;
}

/** Testable core: the header lookups, without a NextRequest. */
export function evaluateCronAuth(
  headers: { authorization?: string | null; xVercelCron?: string | null; userAgent?: string | null },
  secret: string | undefined,
  onVercel = false,
): CronAuthResult {
  if (secret) {
    // Authoritative path. Deliberately NOT falling through to the forgeable
    // signals: once a secret exists, honouring them would make it decorative.
    const ok = headers.authorization === `Bearer ${secret}`;
    return { isCron: ok, via: ok ? 'cron-secret' : null, unverified: false };
  }
  // Deployed without a secret: nothing here is a credential, so refuse.
  if (onVercel) return { isCron: false, via: null, unverified: false, missingSecret: true };
  if (headers.xVercelCron != null) return { isCron: true, via: 'x-vercel-cron', unverified: true };
  if (/vercel-cron/i.test(headers.userAgent ?? '')) {
    return { isCron: true, via: 'user-agent', unverified: true };
  }
  return { isCron: false, via: null, unverified: false };
}

/**
 * Is this request a platform cron invocation? Logs which signal matched (or
 * that none did) so "never invoked" and "invoked but rejected" are
 * distinguishable from the Vercel logs alone.
 */
export function cronAuth(req: NextRequest, job: string): CronAuthResult {
  const result = evaluateCronAuth(
    {
      authorization: req.headers.get('authorization'),
      xVercelCron: req.headers.get('x-vercel-cron'),
      userAgent: req.headers.get('user-agent'),
    },
    process.env.CRON_SECRET,
    !!process.env.VERCEL,
  );
  console.log(
    `[cron/${job}] ${req.method} invoked (cron=${result.isCron}${result.via ? ` via ${result.via}` : ''})`,
  );
  if (result.missingSecret) {
    console.error(
      `[cron/${job}] refused: CRON_SECRET is not set in this deployment, so no scheduled job can run. ` +
        'Add it in Vercel → Settings → Environment Variables and redeploy.',
    );
  }
  if (result.unverified) {
    console.warn(
      `[cron/${job}] accepted on an unverifiable signal (${result.via}). ` +
        'Set CRON_SECRET in the Vercel project to make this route unforgeable.',
    );
  }
  return result;
}

/**
 * Headers for calling one of our own cron routes from server code (the daily
 * catch-up re-running a missed job, the watchdog's backup trigger). With
 * CRON_SECRET set — it is, in Vercel — this is the same Bearer token Vercel
 * sends, so cronAuth accepts it. Without one, the `x-vercel-cron` signal — which
 * cronAuth accepts only off Vercel (local dev).
 */
export function cronDispatchHeaders(secret: string | undefined = process.env.CRON_SECRET): Record<string, string> {
  return secret ? { authorization: `Bearer ${secret}` } : { 'x-vercel-cron': '1' };
}

/** Public origin to call our own routes on. The production domain, never a
 *  per-deployment *.vercel.app URL (those can sit behind deployment protection). */
export function cronBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_BASE_URL ?? 'https://reporting.bakerhouseapartments.cz').replace(/\/+$/, '');
}
