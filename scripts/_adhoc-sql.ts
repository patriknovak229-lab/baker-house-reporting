// TEMPORARY ad-hoc read-only SQL runner. Do not commit.
import './_loadEnv';
import { readFileSync } from 'fs';
import { sql } from 'drizzle-orm';
import { db } from '../lib/db';
const files = process.argv.slice(2);
const text = files.map((f) => readFileSync(f, 'utf8')).join('\n');
async function main() {
  const result = (await db.execute(sql.raw(text))) as unknown as { rows?: unknown[] };
  console.log(JSON.stringify(result.rows ?? result, null, 2));
}
main().catch((err) => { console.error(err); process.exit(1); });
