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
 * When it is not set we still accept them — otherwise configuring the secret
 * would become a prerequisite for the jobs running at all, and a dead cron is
 * the failure we are trying to end — but say so loudly in the logs. This matters
 * most for routes that were exempted from the auth middleware to let cron
 * through: for those, this gate is the only thing left in front of them.
 */

import type { NextRequest } from 'next/server';

export type CronAuthVia = 'cron-secret' | 'x-vercel-cron' | 'user-agent' | null;

export interface CronAuthResult {
  isCron: boolean;
  /** Which signal matched — log it, so a silent failure is diagnosable. */
  via: CronAuthVia;
  /** True when accepted on a forgeable signal because CRON_SECRET is unset. */
  unverified: boolean;
}

/** Testable core: the header lookups, without a NextRequest. */
export function evaluateCronAuth(
  headers: { authorization?: string | null; xVercelCron?: string | null; userAgent?: string | null },
  secret: string | undefined,
): CronAuthResult {
  if (secret) {
    // Authoritative path. Deliberately NOT falling through to the forgeable
    // signals: once a secret exists, honouring them would make it decorative.
    const ok = headers.authorization === `Bearer ${secret}`;
    return { isCron: ok, via: ok ? 'cron-secret' : null, unverified: false };
  }
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
  );
  console.log(
    `[cron/${job}] ${req.method} invoked (cron=${result.isCron}${result.via ? ` via ${result.via}` : ''})`,
  );
  if (result.unverified) {
    console.warn(
      `[cron/${job}] accepted on an unverifiable signal (${result.via}). ` +
        'Set CRON_SECRET in the Vercel project to make this route unforgeable.',
    );
  }
  return result;
}
