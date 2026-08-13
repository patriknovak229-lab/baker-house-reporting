/**
 * GET /api/storage-map
 *
 * Reports which backend every migrated domain is CURRENTLY reading and writing,
 * resolved from the live environment.
 *
 * Why this exists: the code can only tell you which env var controls a domain,
 * never which way that switch is actually flipped in production. Answering
 * "where does my data sit right now?" previously meant reading the Vercel env
 * list by hand and trusting it matched the deploy. This asks the running process.
 *
 * Read-only and side-effect free. Reports MODES only — never any value, key or
 * credential. Admin-gated all the same, since it describes storage internals.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { STORE_DOMAINS, storeEnvKey, getStoreMode } from '@/lib/dataStore';
import { bookingsMirrorWriteEnabled } from '@/utils/bookingsMirror';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const guard = await requireRole(['admin', 'super']);
  if ('error' in guard) return guard.error;

  const domains = STORE_DOMAINS.map((domain) => {
    const mode = getStoreMode(domain);
    return {
      domain,
      envKey: storeEnvKey(domain),
      mode, // redis | dual | postgres
      readsFrom: mode === 'postgres' ? 'postgres' : 'redis',
      writesTo: mode === 'dual' ? ['redis', 'postgres'] : [mode],
      /** True when the env var is absent/invalid and the domain fell back to Redis. */
      usingDefault: mode === 'redis' && !process.env[storeEnvKey(domain)],
    };
  });

  const byMode = domains.reduce<Record<string, number>>((acc, d) => {
    acc[d.mode] = (acc[d.mode] ?? 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    summary: {
      total: domains.length,
      ...byMode,
      // The bookings archive is a separate axis: not a redis|dual|postgres swap,
      // just an additive Postgres write that nothing reads yet.
      bookingsArchiveWriting: bookingsMirrorWriteEnabled(),
    },
    domains,
    onPostgres: domains.filter((d) => d.mode === 'postgres').map((d) => d.domain),
    stillOnRedis: domains.filter((d) => d.mode === 'redis').map((d) => d.domain),
    dualWriting: domains.filter((d) => d.mode === 'dual').map((d) => d.domain),
  });
}
