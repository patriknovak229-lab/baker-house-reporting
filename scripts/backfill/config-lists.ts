/**
 * Backfill the three small accounting config lists → Postgres:
 *   baker:invoice-categories  → invoice_categories
 *   baker:supplier-whitelist  → supplier_whitelist
 *   baker:bank-cost-whitelist → bank_cost_whitelist
 * Idempotent. Run: npx tsx scripts/backfill/config-lists.ts
 */
import '../_loadEnv';

import { Redis } from '@upstash/redis';
import { db } from '../../lib/db';
import { invoiceCategories, supplierWhitelist, bankCostWhitelist } from '../../lib/db/schema';
import type { InvoiceCategory, WhitelistedSupplier } from '../../types/supplierInvoice';
import type { BankCostRule } from '../../types/bankCostWhitelist';

async function main() {
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  });

  const cats = (await redis.get<InvoiceCategory[]>('baker:invoice-categories')) ?? [];
  let catN = 0;
  for (const c of cats) {
    if (!c?.id) continue;
    await db
      .insert(invoiceCategories)
      .values({ id: c.id, label: c.label, color: c.color })
      .onConflictDoUpdate({ target: invoiceCategories.id, set: { label: c.label, color: c.color } });
    catN++;
  }

  const sups = (await redis.get<WhitelistedSupplier[]>('baker:supplier-whitelist')) ?? [];
  let supN = 0;
  for (const s of sups) {
    if (!s?.id) continue;
    const set = {
      supplierName: s.supplierName,
      supplierIco: s.supplierICO ?? null,
      category: s.category,
      addedAt: new Date(s.addedAt),
    };
    await db
      .insert(supplierWhitelist)
      .values({ id: s.id, ...set })
      .onConflictDoUpdate({ target: supplierWhitelist.id, set });
    supN++;
  }

  const rules = (await redis.get<BankCostRule[]>('baker:bank-cost-whitelist')) ?? [];
  let ruleN = 0;
  for (const r of rules) {
    if (!r?.id) continue;
    const set = {
      label: r.label,
      costCategory: r.costCategory,
      counterpartyAccount: r.counterpartyAccount ?? null,
      variableSymbol: r.variableSymbol ?? null,
      counterpartyNameContains: r.counterpartyNameContains ?? null,
      amount: r.amount != null ? String(r.amount) : null,
      createdAt: new Date(r.createdAt),
    };
    await db
      .insert(bankCostWhitelist)
      .values({ id: r.id, ...set })
      .onConflictDoUpdate({ target: bankCostWhitelist.id, set });
    ruleN++;
  }

  console.log(
    JSON.stringify(
      {
        invoiceCategories: { redisCount: cats.length, rowsUpserted: catN },
        supplierWhitelist: { redisCount: sups.length, rowsUpserted: supN },
        bankCostWhitelist: { redisCount: rules.length, rowsUpserted: ruleN },
      },
      null,
      2,
    ),
  );
}

main().catch((err) => { console.error('❌ backfill failed:', err); process.exit(1); });
