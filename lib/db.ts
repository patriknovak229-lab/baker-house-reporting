import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './db/schema';

// Pooled connection string (PgBouncer endpoint) for the app runtime.
// Neon's Vercel integration injects POSTGRES_URL; fall back to DATABASE_URL.
const connectionString = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    'Missing Neon connection string: set POSTGRES_URL (or DATABASE_URL).',
  );
}

// neon-http: each query is a stateless HTTPS request — no TCP pool to exhaust
// on Vercel serverless fan-out.
const sql = neon(connectionString);

export const db = drizzle(sql, { schema });
export type DB = typeof db;
