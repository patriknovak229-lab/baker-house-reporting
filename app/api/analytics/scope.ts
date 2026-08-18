/**
 * Shared request parsing + auth for the /api/analytics/* routes.
 *
 * Not a `route.ts`, so Next.js does not treat it as an endpoint — it is a plain
 * server module the sibling route handlers import.
 */
import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import { ANALYTICS_ROLES } from '@/utils/roles';
import { pragueToday } from '@/utils/periodUtils';
import { PHYSICAL_ROOMS, type AnalyticsScope } from '@/data-access/analytics/shared';

const MAX_WINDOW_DAYS = 800;

function isIsoDate(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseList(raw: string | null, allowed?: string[]): string[] {
  if (!raw) return [];
  const values = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  const unique = [...new Set(values)];
  return allowed ? unique.filter((v) => allowed.includes(v)) : unique;
}

export interface ParsedRequest {
  scope: AnalyticsScope;
  /** Today in the property's timezone — the boundary for "partial month". */
  todayIso: string;
}

/**
 * Validate the query string into a scope, or return the error response.
 *
 * Bad input is rejected rather than coerced: a silently-clamped date range would
 * make a chart quietly answer a different question than the one on screen. Room
 * names are whitelisted against the known physical rooms; channels are passed
 * through as-is (they are bound parameters, and a typo simply matches nothing).
 */
export async function parseAnalyticsRequest(
  request: Request,
): Promise<ParsedRequest | { error: NextResponse }> {
  const guard = await requireRole(ANALYTICS_ROLES);
  if ('error' in guard) return { error: guard.error };

  const url = new URL(request.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');

  if (!isIsoDate(from) || !isIsoDate(to)) {
    return {
      error: NextResponse.json(
        { error: 'from and to are required and must be YYYY-MM-DD' },
        { status: 400 },
      ),
    };
  }
  if (from > to) {
    return { error: NextResponse.json({ error: 'from must not be after to' }, { status: 400 }) };
  }

  const days =
    Math.round(
      (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
    ) + 1;
  if (days > MAX_WINDOW_DAYS) {
    return {
      error: NextResponse.json(
        { error: `Window too large (${days} days). Maximum is ${MAX_WINDOW_DAYS}.` },
        { status: 400 },
      ),
    };
  }

  return {
    scope: {
      from,
      to,
      rooms: parseList(url.searchParams.get('rooms'), PHYSICAL_ROOMS),
      channels: parseList(url.searchParams.get('channels')),
    },
    todayIso: pragueToday(),
  };
}

/** Uniform error body so the client can render one message shape. */
export function analyticsError(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : 'Unknown error';
  console.error('[analytics]', err);
  return NextResponse.json({ error: message }, { status: 500 });
}
