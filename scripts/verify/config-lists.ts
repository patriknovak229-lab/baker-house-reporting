/** Parity: the three accounting config lists (Redis) vs Postgres. */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { invoiceCategories, supplierWhitelist, bankCostWhitelist } from '../../lib/db/schema';
import type { InvoiceCategory, WhitelistedSupplier } from '../../types/supplierInvoice';
import type { BankCostRule } from '../../types/bankCostWhitelist';

const norm = (x: string | null | undefined) => (x == null || x === '' ? null : x);
const epoch = (v: string | Date | null | undefined) => (v ? new Date(v).getTime() : null);
const numOrNull = (x: number | string | null | undefined) => (x == null ? null : Number(x));

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const mismatches: string[] = [];

  const cats = (await redis.get<InvoiceCategory[]>('baker:invoice-categories')) ?? [];
  const catRedis = new Map(cats.filter((c) => c?.id).map((c) => [c.id, c] as const));
  const catPg = new Map((await db.select().from(invoiceCategories)).map((r) => [r.id, r] as const));
  for (const id of new Set([...catRedis.keys(), ...catPg.keys()])) {
    const a = catRedis.get(id); const b = catPg.get(id);
    if (!a) { mismatches.push(`category ${id}: Postgres only`); continue; }
    if (!b) { mismatches.push(`category ${id}: Redis only`); continue; }
    if (a.label !== b.label) mismatches.push(`category ${id}: label`);
    if (a.color !== b.color) mismatches.push(`category ${id}: color`);
  }

  const sups = (await redis.get<WhitelistedSupplier[]>('baker:supplier-whitelist')) ?? [];
  const supRedis = new Map(sups.filter((s) => s?.id).map((s) => [s.id, s] as const));
  const supPg = new Map((await db.select().from(supplierWhitelist)).map((r) => [r.id, r] as const));
  for (const id of new Set([...supRedis.keys(), ...supPg.keys()])) {
    const a = supRedis.get(id); const b = supPg.get(id);
    if (!a) { mismatches.push(`supplier ${id}: Postgres only`); continue; }
    if (!b) { mismatches.push(`supplier ${id}: Redis only`); continue; }
    if (a.supplierName !== b.supplierName) mismatches.push(`supplier ${id}: supplierName`);
    if (norm(a.supplierICO) !== norm(b.supplierIco)) mismatches.push(`supplier ${id}: supplierICO`);
    if (a.category !== b.category) mismatches.push(`supplier ${id}: category`);
    if (epoch(a.addedAt) !== epoch(b.addedAt)) mismatches.push(`supplier ${id}: addedAt`);
  }

  const rules = (await redis.get<BankCostRule[]>('baker:bank-cost-whitelist')) ?? [];
  const ruleRedis = new Map(rules.filter((r) => r?.id).map((r) => [r.id, r] as const));
  const rulePg = new Map((await db.select().from(bankCostWhitelist)).map((r) => [r.id, r] as const));
  for (const id of new Set([...ruleRedis.keys(), ...rulePg.keys()])) {
    const a = ruleRedis.get(id); const b = rulePg.get(id);
    if (!a) { mismatches.push(`rule ${id}: Postgres only`); continue; }
    if (!b) { mismatches.push(`rule ${id}: Redis only`); continue; }
    if (a.label !== b.label) mismatches.push(`rule ${id}: label`);
    if (a.costCategory !== b.costCategory) mismatches.push(`rule ${id}: costCategory`);
    if (norm(a.counterpartyAccount) !== norm(b.counterpartyAccount)) mismatches.push(`rule ${id}: counterpartyAccount`);
    if (norm(a.variableSymbol) !== norm(b.variableSymbol)) mismatches.push(`rule ${id}: variableSymbol`);
    if (norm(a.counterpartyNameContains) !== norm(b.counterpartyNameContains)) mismatches.push(`rule ${id}: counterpartyNameContains`);
    if (numOrNull(a.amount) !== numOrNull(b.amount)) mismatches.push(`rule ${id}: amount`);
    if (epoch(a.createdAt) !== epoch(b.createdAt)) mismatches.push(`rule ${id}: createdAt`);
  }

  console.log(
    JSON.stringify(
      {
        invoiceCategories: { redis: catRedis.size, postgres: catPg.size },
        supplierWhitelist: { redis: supRedis.size, postgres: supPg.size },
        bankCostWhitelist: { redis: ruleRedis.size, postgres: rulePg.size },
        mismatches,
      },
      null,
      2,
    ),
  );
  if (mismatches.length) { console.error(`❌ ${mismatches.length} mismatch(es)`); process.exit(1); }
  console.log('✅ parity OK');
}

main().catch((err) => { console.error('❌ verify failed:', err); process.exit(1); });
