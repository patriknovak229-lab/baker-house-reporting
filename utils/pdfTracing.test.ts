import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import nextConfig, { CHROMIUM_ROUTES } from '../next.config';

/**
 * Guards the Vercel bundling of headless Chromium.
 *
 * `@sparticuz/chromium` keeps its browser in brotli archives under `bin/` that
 * no import references, so Next's file tracing drops them unless
 * `outputFileTracingIncludes` names the route. Get that wrong and the build
 * still succeeds and the route still deploys — it only fails at runtime, on a
 * customer clicking Export, with "The input directory
 * /var/task/node_modules/@sparticuz/chromium/bin does not exist".
 *
 * That is what happened here: the list named only two routes, so commission
 * statements, owner emails, invoice-to-Drive and the due-invoice cron all
 * shipped without a browser. Nothing failed until someone pressed the button.
 *
 * This test derives the routes that actually reach Chromium from the import
 * graph and compares them against CHROMIUM_ROUTES, both directions — a new PDF
 * route that forgets the config fails here, and so does a stale entry. It
 * deliberately does NOT re-implement Next's glob matching: that is Turbopack's
 * business and a wrong model of it would be worse than no test. The config's
 * effect was verified against real `.nft.json` build output.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_API = join(ROOT, 'app', 'api');
const CHROMIUM_GLOB = './node_modules/@sparticuz/chromium/bin/**/*';

/** Every `app/api/**\/route.ts`, as { route path, source file }. */
function apiRoutes(dir = APP_API): { route: string; file: string }[] {
  const out: { route: string; file: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...apiRoutes(full));
    else if (/^route\.tsx?$/.test(entry.name)) {
      out.push({ route: `/${relative(ROOT, dirname(full)).replace(/^app\//, '')}`, file: full });
    }
  }
  return out;
}

/** Resolve an import specifier to a repo file, or null when it leaves the repo. */
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec);
  else return null; // bare package — detected by name, not walked
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Does this module, or anything it imports, launch headless Chromium? */
function reachesChromium(file: string, seen = new Set<string>()): boolean {
  if (seen.has(file)) return false;
  seen.add(file);
  const src = readFileSync(file, 'utf8');
  const specs = [
    ...[...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
    ...[...src.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]),
  ];
  if (specs.some((s) => s === 'puppeteer-core' || s.startsWith('@sparticuz/chromium'))) return true;
  return specs.some((s) => {
    const next = resolveImport(s, file);
    return next ? reachesChromium(next, seen) : false;
  });
}

const routes = apiRoutes();
const needsChromium = routes.filter((r) => reachesChromium(r.file)).map((r) => r.route).sort();

describe('Chromium output-file tracing', () => {
  it('finds the API routes to check', () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(needsChromium.length).toBeGreaterThan(0);
  });

  it('lists every route that launches Chromium, and only those', () => {
    // Missing → that route ships without a browser and 500s on first use.
    // Extra   → ~50 MB of Chromium bundled into a function that never runs it.
    expect(needsChromium).toEqual([...CHROMIUM_ROUTES].sort());
  });

  it('gives each of those routes the Chromium bin glob', () => {
    const includes = (nextConfig.outputFileTracingIncludes ?? {}) as Record<string, string[]>;
    for (const route of CHROMIUM_ROUTES) {
      expect(includes[route], `no tracing entry for ${route}`).toContain(CHROMIUM_GLOB);
    }
  });

  it('keeps the AI knowledge base in the reply webhook bundle', () => {
    // Same class of bug, same silent runtime failure — different payload.
    const includes = (nextConfig.outputFileTracingIncludes ?? {}) as Record<string, string[]>;
    expect(includes['/api/webhook/beds24-message']).toContain('./data/ai-knowledge-base.md');
  });
});
