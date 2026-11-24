import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every API route must check the permission map (requireAccess) — or be on
 * this list with the reason it is reachable without a session. A route that
 * forgets the check would otherwise be open to every signed-in role,
 * stakeholders included (code review 2026-11-03, area 1).
 */
const PUBLIC_ROUTES: Record<string, string> = {
  'auth/[...nextauth]': 'Auth.js sign-in endpoints',
  'accounting/connect-gmail/callback': 'Google OAuth redirect; checked against the CSRF state set by the admin-only start route',
  'public/occupancy/[token]': 'PII-free share snapshot, unguessable token',
  'pricing/ingest': 'Mac parity runner; PRICING_INGEST_SECRET header',
  'stripe/webhook': 'Stripe signature (STRIPE_WEBHOOK_SECRET)',
  'vouchers/validate': 'rental-site checkout (public; guessing limit still open)',
  'vouchers/redeem': 'rental-site checkout (public; guessing limit still open)',
  'webhook/beds24-message': 'WEBHOOK_SECRET',
  'webhook/new-booking': 'WEBHOOK_SECRET',
  'webhook/web-booking-warning': 'WEB_BOOKING_ALERT_SECRET',
  'webhook/web-payment-schedule': 'WEB_BOOKING_ALERT_SECRET',
};

const API_ROOT = join(__dirname, '..', 'app', 'api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return routeFiles(full);
    return name === 'route.ts' ? [full] : [];
  });
}

const routes = routeFiles(API_ROOT).map((file) => ({
  id: relative(API_ROOT, file).replace(/\/route\.ts$/, ''),
  src: readFileSync(file, 'utf8'),
}));

describe('API route guards', () => {
  it('finds the routes', () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it.each(routes.filter((r) => !(r.id in PUBLIC_ROUTES)))('$id checks requireAccess', ({ src }) => {
    expect(src).toMatch(/requireAccess\(|parseAnalyticsRequest\(/);
  });

  it.each(routes)('$id never uses a raw role list', ({ src }) => {
    expect(src).not.toMatch(/requireRole\(/);
  });

  it('lists no public route that no longer exists', () => {
    const ids = new Set(routes.map((r) => r.id));
    expect(Object.keys(PUBLIC_ROUTES).filter((id) => !ids.has(id))).toEqual([]);
  });
});
