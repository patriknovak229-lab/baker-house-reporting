import { neon, type NeonQueryFunction } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './db/schema';

// Pooled connection string (PgBouncer endpoint) for the app runtime.
// Neon's Vercel integration injects POSTGRES_URL; fall back to DATABASE_URL.
const connectionString = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;

/**
 * WHY A MISSING CONNECTION STRING NO LONGER THROWS AT MODULE SCOPE
 *
 * It used to, and on 2026-08-15 that took the whole app down. A client
 * component reached this module through an import chain — `utils/grossProfit.ts`
 * imported a *value* out of `app/api/variable-costs/route.ts`, which dragged
 * that route's server-only imports into the browser bundle — and
 * `process.env.POSTGRES_URL` is never defined in a browser. The module threw
 * during evaluation, so every page white-screened on hydration. SSR still
 * rendered fine (the server has the env var), so the app served a
 * healthy-looking 200 the entire time and every infra check came back green.
 *
 * Failing at QUERY time instead contains the blast radius: a stray import can
 * no longer break pages that never touch the database, and the message names
 * the real cause instead of a missing env var. This is NOT a licence to import
 * this module from client code — keep shared constants and types in a neutral
 * module (see `utils/variableCostsShared.ts`).
 */
function unconfigured(): never {
  throw new Error(
    'Missing Neon connection string: set POSTGRES_URL (or DATABASE_URL). ' +
      (typeof window === 'undefined'
        ? 'The server-side env var is not set.'
        : 'This ran in the BROWSER, which never has database credentials — a ' +
          'client component has pulled @/lib/db into the client bundle through ' +
          'an import chain. Find the value import that reaches a server-only ' +
          'module and move it into a module with no server-only imports.'),
  );
}

// Safe to hand drizzle an unconfigured client: `construct()` only stores it
// (drizzle's own `drizzle.mock` constructs with `{}`), and `isConfig` ignores
// functions, so this takes the same code path as a real `neon()` client.
// neon-http reaches the client via `client.query ?? client` for queries and
// `client.transaction` for batch — all three paths throw.
const unconfiguredClient = Object.assign(unconfigured, {
  query: unconfigured,
  transaction: unconfigured,
}) as unknown as NeonQueryFunction<false, false>;

// neon-http: each query is a stateless HTTPS request — no TCP pool to exhaust
// on Vercel serverless fan-out.
const sql = connectionString ? neon(connectionString) : unconfiguredClient;

export const db = drizzle(sql, { schema });
export type DB = typeof db;
