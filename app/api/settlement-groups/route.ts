import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { BankTransaction } from '@/types/bankTransaction';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { REVENUE_KEY, SUPPLIER_KEY, buildSettlementRevenue, buildSettlementCost, appendRecords } from '@/utils/settlementRecords';

const GROUPS_KEY = 'baker:settlement-groups';
const TX_KEY     = 'baker:bank-transactions';

function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// GET /api/settlement-groups — return all groups sorted newest first
export async function GET() {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const groups = (await redis.get<SettlementGroup[]>(GROUPS_KEY)) ?? [];
  groups.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return NextResponse.json(groups);
}

// POST /api/settlement-groups — create a new group.
// Two creation modes:
//   • tx-first (Bank tab): pass `transactionId` — starts the group with that credit.
//   • report-first (Revenue tab): pass OTA earnings-report fields (source/period/gross…)
//     with no transaction — creates an empty group ready for payouts to be linked.
export async function POST(request: Request) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const body = await request.json() as {
    name: string;
    transactionId?: string;
    // report-first fields
    source?: SettlementGroup['source'];
    periodStart?: string;
    periodEnd?: string;
    grossAmount?: number;
    commissionAmount?: number;
    netAmount?: number;
    adjustmentsAmount?: number;
    taxWithheld?: number;
    reportFileId?: string;
    reportFileName?: string;
    reportUrl?: string;
  };
  if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  const hasReport = body.source != null || body.grossAmount != null;
  if (!body.transactionId && !hasReport) {
    return NextResponse.json({ error: 'transactionId or earnings-report data is required' }, { status: 400 });
  }

  // Create the group
  const group: SettlementGroup = {
    id:             crypto.randomUUID(),
    name:           body.name.trim(),
    transactionIds: body.transactionId ? [body.transactionId] : [],
    invoiceIds:     [],
    createdAt:      new Date().toISOString(),
    ...(hasReport && {
      source:            body.source,
      periodStart:       body.periodStart,
      periodEnd:         body.periodEnd,
      grossAmount:       body.grossAmount,
      commissionAmount:  body.commissionAmount,
      netAmount:         body.netAmount,
      adjustmentsAmount: body.adjustmentsAmount,
      taxWithheld:       body.taxWithheld,
      reportFileId:      body.reportFileId,
      reportFileName:    body.reportFileName,
      reportUrl:         body.reportUrl,
    }),
  };

  // A report settlement auto-creates its two backing records:
  //   • gross booking volume → RevenueInvoice (line I. sales)
  //   • channel fees         → SupplierInvoice (A. Výkonová spotřeba)
  let revenueInvoice: RevenueInvoice | null = null;
  let costInvoice: SupplierInvoice | null = null;
  if (hasReport) {
    revenueInvoice = buildSettlementRevenue(group);
    costInvoice    = buildSettlementCost(group);
    group.revenueInvoiceId = revenueInvoice.id;
    group.invoiceIds = [costInvoice.id];
  }

  // If starting with a transaction, mark it grouped
  const txs = (await redis.get<BankTransaction[]>(TX_KEY)) ?? [];
  const updatedTxs = body.transactionId
    ? txs.map((t) =>
        t.id === body.transactionId
          ? { ...t, state: 'grouped' as const, settlementGroupId: group.id }
          : t,
      )
    : txs;
  const updatedTx = body.transactionId ? (updatedTxs.find((t) => t.id === body.transactionId) ?? null) : null;

  // Persist group + records append-safe (verify-and-retry so a concurrent settlement
  // save can't clobber a just-added revenue/cost record — see appendRecords).
  await appendRecords(redis, GROUPS_KEY, [group]);
  if (body.transactionId) await redis.set(TX_KEY, updatedTxs);
  if (revenueInvoice) await appendRecords(redis, REVENUE_KEY, [revenueInvoice]);
  if (costInvoice) await appendRecords(redis, SUPPLIER_KEY, [costInvoice]);

  return NextResponse.json({ group, transaction: updatedTx, revenueInvoice, costInvoice }, { status: 201 });
}
