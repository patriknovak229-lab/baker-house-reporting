import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// The drizzle-kit CLI doesn't load Next.js env files; load .env.local explicitly.
config({ path: '.env.local' });

// Migrations run over the DIRECT (non-pooled) endpoint — DDL must not go
// through PgBouncer transaction pooling.
const url =
  process.env.POSTGRES_URL_NON_POOLING ?? process.env.DATABASE_URL_UNPOOLED;

if (!url) {
  throw new Error(
    'Missing direct connection string: set POSTGRES_URL_NON_POOLING (or DATABASE_URL_UNPOOLED).',
  );
}

export default defineConfig({
  schema: './lib/db/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },

  // This database is SHARED with baker-house-cleaning, which owns the
  // `cleaning.*` schema. Pinning drizzle-kit to `public` keeps it from
  // introspecting — or emitting DDL against — the cleaning app's tables.
  // (Their drizzle.config.ts has the mirror-image `schemaFilter: ['cleaning']`.)
  // Never widen this, and never remove it.
  schemaFilter: ['public'],

  strict: true,
  verbose: true,
});
