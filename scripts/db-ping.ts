/**
 * Wave 0 connectivity check — confirms the Neon connection string in
 * .env.local works end-to-end. Run with `npm run db:ping`.
 */
import './_loadEnv';

import { neon } from '@neondatabase/serverless';

async function main() {
  const url = process.env.POSTGRES_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('POSTGRES_URL (or DATABASE_URL) not set in .env.local');
  }

  const sql = neon(url);
  const rows = (await sql`select version()`) as { version: string }[];
  console.log('✅ Connected to Neon Postgres');
  console.log('   ' + rows[0]?.version);
}

main().catch((err) => {
  console.error('❌ DB ping failed:');
  console.error(err);
  process.exit(1);
});
