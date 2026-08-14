import '../_loadEnv';

/**
 * Does /api/variable-costs produce IDENTICAL output from Redis and Postgres?
 *
 * This is the gate for the cleaning app's wave-2 cutover. The three migrated
 * domains (cleaning assignments, laundry assignments, consumable entries) feed
 * the P&L, so "the rows match" is not enough — the computed cost numbers have
 * to be byte-identical, because that is what anyone actually looks at.
 *
 * Calls the real route handler twice with READ_CLEANING_DATA toggled, then
 * deep-diffs the full response. The flag is read per-request inside the
 * handler, so no module reload is needed.
 *
 * Read-only. Run: npx tsx scripts/verify/cleaning-source-parity.ts
 */
async function callRoute(source: 'redis' | 'postgres') {
  process.env.READ_CLEANING_DATA = source;
  const mod = await import('../../app/api/variable-costs/route');
  const res = await mod.GET();
  return res.json();
}

/** Every leaf difference, as dotted paths — no "objects differ" hand-waving. */
export function diff(a: unknown, b: unknown, path = ''): string[] {
  if (a === b) return [];
  if (typeof a !== typeof b || a === null || b === null) {
    return [`${path || '<root>'}: redis=${JSON.stringify(a)} pg=${JSON.stringify(b)}`];
  }
  if (typeof a !== 'object') {
    return [`${path || '<root>'}: redis=${JSON.stringify(a)} pg=${JSON.stringify(b)}`];
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = a as unknown[];
    const bb = b as unknown[];
    if (!Array.isArray(a) || !Array.isArray(b)) {
      return [`${path}: array/object mismatch`];
    }
    if (aa.length !== bb.length) return [`${path}.length: redis=${aa.length} pg=${bb.length}`];
    const out: string[] = [];
    for (let i = 0; i < aa.length; i++) out.push(...diff(aa[i], bb[i], `${path}[${i}]`));
    return out;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys: string[] = [];
  Object.keys(ao).forEach((k) => keys.push(k));
  Object.keys(bo).forEach((k) => { if (keys.indexOf(k) === -1) keys.push(k); });
  const out: string[] = [];
  keys.forEach((k) => out.push(...diff(ao[k], bo[k], path ? `${path}.${k}` : k)));
  return out;
}

(async () => {
  const fromRedis = await callRoute('redis');
  const fromPg = await callRoute('postgres');

  const cellCount = (o: any) => Object.keys(o?.byDateRoom ?? {}).length;
  const sumField = (o: any, f: string) =>
    Object.values(o?.byDateRoom ?? {}).reduce(
      (acc: number, c: any) => acc + (Number(c?.[f]) || 0),
      0,
    );

  console.log('=== headline totals ===');
  console.log(`byDateRoom cells   redis=${cellCount(fromRedis)}  pg=${cellCount(fromPg)}`);
  for (const f of ['cleaning', 'laundry', 'consumables', 'subscriptions', 'wearTear', 'misc']) {
    const r = sumField(fromRedis, f);
    const p = sumField(fromPg, f);
    console.log(`  ${f.padEnd(14)} redis=${r}  pg=${p}${r === p ? '' : '   <-- DIFFERS'}`);
  }
  console.log(
    `byReservation keys redis=${Object.keys(fromRedis?.byReservation ?? {}).length}` +
      `  pg=${Object.keys(fromPg?.byReservation ?? {}).length}`,
  );

  const diffs = diff(fromRedis, fromPg);
  console.log(`\n=== full deep diff ===\nleaf differences: ${diffs.length}`);
  diffs.slice(0, 25).forEach((d) => console.log(`  ${d}`));
  if (diffs.length > 25) console.log(`  … and ${diffs.length - 25} more`);

  // What a difference MEANS depends on whether the cleaning app has cut over.
  //
  // PRE-CUTOVER (cleaning app on `dual`): both stores get every write, so the
  // two sources must agree. Any difference is a bug and blocks the switch.
  //
  // POST-CUTOVER (cleaning app on `postgres`): its Redis keys are frozen, so
  // the redis-sourced column is a fossil. Differences are EXPECTED, and their
  // size is precisely how wrong this app's P&L would be if it were still
  // reading Redis — i.e. the cost of a misconfiguration, not a defect.
  const postCutover =
    process.env.CLEANING_APP_CUT_OVER?.trim().toLowerCase() === 'true' ||
    process.argv.indexOf('--post-cutover') !== -1;

  if (postCutover) {
    console.log(
      diffs.length === 0
        ? '\n✓ Post-cutover: no cleaning-app writes since the freeze yet.'
        : `\n✓ Post-cutover: ${diffs.length} difference(s). Postgres is authoritative and is what` +
          `\n  production serves. The redis column is the frozen fossil — this is exactly how wrong` +
          `\n  the P&L would be if READ_CLEANING_DATA were reverted to redis. Do NOT revert it.`,
    );
    return;
  }

  console.log(
    diffs.length === 0
      ? '\n✓ IDENTICAL — the P&L is unchanged by the source switch. Safe to set READ_CLEANING_DATA=postgres.'
      : '\n✗ DIFFERENCES — do NOT switch the source until these are explained.' +
        '\n  (If the cleaning app has already cut over to `postgres`, its Redis keys are frozen and' +
        '\n   these differences are expected — re-run with --post-cutover.)',
  );
  if (diffs.length > 0) process.exitCode = 1;
})();
