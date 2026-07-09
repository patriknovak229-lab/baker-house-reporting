import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { type SettlementGroup, isReportSettlement } from '@/types/settlementGroup';
import { classifyCost, RECURRING_ENTRY, type StatutoryLine } from '@/utils/costBridge';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/** OTA-named suppliers — used to flag legacy commission invoices not backed by a settlement */
const OTA_SUPPLIER_RE = /booking\.?com|airbnb/i;

/** Plausible invoice-date window; anything outside is flagged (not silently bucketed) */
const MIN_DATE = '2023-01-01';
const MAX_DATE = `${new Date().getFullYear() + 1}-12-31`;

/** Accrual period key: prefer DUZP / taxable-supply date, fall back to invoice date */
function costDate(inv: SupplierInvoice): string {
  return inv.duzpDate || inv.invoiceDate;
}

/** A recurring/contractual cost paid via bank (rent, parking) with no invoice */
export interface PLRecurringCost {
  id: string;
  date: string;
  counterpartyName?: string;
  amount: number;
  costCategory?: string;
  note?: string;
}

/** A single cost record placed on a statutory line (for drill-down) */
export interface PLCostRow {
  id: string;
  date: string;           // accrual date (DUZP ?? invoiceDate; tx date for recurring)
  supplier: string;
  invoiceNumber: string;
  amount: number;
  category: string;
  account: string;        // Czech ledger account
  line: StatutoryLine;
}

export interface PLLine {
  total: number;
  rows: PLCostRow[];
}

export interface PLData {
  from: string;
  to: string;
  revenue: {
    accommodation: number;
    otherServices: number;
    /** Gross booking volume from OTA settlements (Airbnb + Booking) — 'ota_gross' records */
    otaGross: number;
    total: number;
    accommodationInvoices: RevenueInvoice[];
    otherServicesInvoices: RevenueInvoice[];
    otaGrossInvoices: RevenueInvoice[];
  };
  costs: {
    /** Costs summed by VZZ statutory line: A / D / E / F */
    byLine: Record<StatutoryLine, PLLine>;
    total: number;
    /** Items ≥ 80k in a capitalizable category → fixed asset (022), NOT expensed */
    capitalizedAssets: PLCostRow[];
    /** OTA fee records not backed by a settlement — likely legacy; delete + re-upload as settlements */
    flaggedLegacyOta: PLCostRow[];
    /** Records whose date is implausible (future/very old) — fix before period close */
    flaggedOutOfRangeDate: PLCostRow[];
    /** Records whose category wasn't in the bridge → fell back to 548/F */
    flaggedUnknownCategory: PLCostRow[];
  };
  operatingResult: number;
}

const emptyLine = (): PLLine => ({ total: 0, rows: [] });

export async function GET(req: NextRequest) {
  const authResult = await requireRole(['admin', 'super', 'accountant']);
  if ('error' in authResult) return authResult.error;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from');
  const to   = searchParams.get('to');

  if (!from || !to) {
    return NextResponse.json({ error: 'from and to query params are required (YYYY-MM-DD)' }, { status: 400 });
  }

  const [rawRevenue, rawSupplier, rawTxs, rawGroups] = await Promise.all([
    redis.get<RevenueInvoice[]>('baker:revenue-invoices'),
    redis.get<SupplierInvoice[]>('baker:supplier-invoices'),
    redis.get<BankTransaction[]>('baker:bank-transactions'),
    redis.get<SettlementGroup[]>('baker:settlement-groups'),
  ]);

  const revenueInvoices: RevenueInvoice[]   = rawRevenue  ?? [];
  const supplierInvoices: SupplierInvoice[] = rawSupplier ?? [];
  const bankTxs: BankTransaction[]          = rawTxs      ?? [];
  const settlementGroups: SettlementGroup[] = rawGroups   ?? [];

  // ── Revenue (from records, by invoice date) ──────────────────────────────
  const filteredRevenue = revenueInvoices.filter(
    (inv) => inv.invoiceDate >= from && inv.invoiceDate <= to && inv.category !== 'mistake',
  );
  const accommodationInvoices = filteredRevenue.filter((inv) => inv.category === 'accommodation_direct');
  const otherServicesInvoices = filteredRevenue.filter((inv) => inv.category === 'other_services');
  const otaGrossInvoices      = filteredRevenue.filter((inv) => inv.category === 'ota_gross');
  const accommodation = accommodationInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherServices = otherServicesInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otaGross      = otaGrossInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const revenueTotal  = accommodation + otherServices + otaGross;

  // ── Costs — accrual by DUZP/invoice date, mapped to statutory line via the bridge ──
  const settlementOwnedCostIds = new Set(
    settlementGroups.filter(isReportSettlement).flatMap((g) => g.invoiceIds),
  );

  const byLine: Record<StatutoryLine, PLLine> = { A: emptyLine(), D: emptyLine(), E: emptyLine(), F: emptyLine() };
  const capitalizedAssets: PLCostRow[] = [];
  const flaggedLegacyOta: PLCostRow[] = [];
  const flaggedOutOfRangeDate: PLCostRow[] = [];
  const flaggedUnknownCategory: PLCostRow[] = [];

  for (const inv of supplierInvoices) {
    const date = costDate(inv);
    const cls = classifyCost(inv.category, inv.amountCZK);
    const row: PLCostRow = {
      id: inv.id,
      date,
      supplier: inv.supplierName,
      invoiceNumber: inv.invoiceNumber,
      amount: inv.amountCZK,
      category: inv.category,
      account: cls.account,
      line: cls.line,
    };

    // Flag implausible dates regardless of the query window (don't silently bucket)
    if (date < MIN_DATE || date > MAX_DATE) {
      flaggedOutOfRangeDate.push(row);
      continue;
    }

    // Period filter (accrual)
    if (date < from || date > to) continue;

    // Legacy OTA commission (not backed by a settlement) — counted, but flagged for cleanup
    if (OTA_SUPPLIER_RE.test(inv.supplierName) && !settlementOwnedCostIds.has(inv.id)) {
      flaggedLegacyOta.push(row);
    }
    if (cls.unknownCategory) flaggedUnknownCategory.push(row);

    // Capitalized fixed asset → balance sheet (022), not an operating expense
    if (cls.capitalized) {
      capitalizedAssets.push(row);
      continue;
    }

    byLine[cls.line].total += inv.amountCZK;
    byLine[cls.line].rows.push(row);
  }

  // Recurring bank costs (rent, parking) — no invoice, mapped to line A (services)
  const recurringCostTxs = bankTxs.filter(
    (tx) => tx.state === 'recurring_cost' && tx.direction === 'debit' && tx.date >= from && tx.date <= to,
  );
  for (const tx of recurringCostTxs) {
    const row: PLCostRow = {
      id: tx.id,
      date: tx.date,
      supplier: tx.counterpartyName ?? tx.costNote ?? 'Recurring cost',
      invoiceNumber: tx.costCategory ?? 'recurring',
      amount: tx.amount,
      category: tx.costCategory ?? 'recurring',
      account: RECURRING_ENTRY.account,
      line: RECURRING_ENTRY.line,
    };
    byLine[RECURRING_ENTRY.line].total += tx.amount;
    byLine[RECURRING_ENTRY.line].rows.push(row);
  }

  const costsTotal = (['A', 'D', 'E', 'F'] as StatutoryLine[]).reduce((s, l) => s + byLine[l].total, 0);

  const data: PLData = {
    from,
    to,
    revenue: {
      accommodation,
      otherServices,
      otaGross,
      total: revenueTotal,
      accommodationInvoices,
      otherServicesInvoices,
      otaGrossInvoices,
    },
    costs: {
      byLine,
      total: costsTotal,
      capitalizedAssets,
      flaggedLegacyOta,
      flaggedOutOfRangeDate,
      flaggedUnknownCategory,
    },
    operatingResult: revenueTotal - costsTotal,
  };

  return NextResponse.json(data);
}
