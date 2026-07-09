import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { type SettlementGroup, isReportSettlement } from '@/types/settlementGroup';
import { DISTRIBUTION_FEES_CATEGORY } from '@/utils/settlementRecords';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Supplier invoice categories → Czech P&L sections
const MATERIALS_CATS = ['utilities', 'consumables'];
const PERSONNEL_CATS = ['cleaning', 'laundry'];
// 'distribution-fees' → A. Výkonová spotřeba (OTA channel fees); everything else → otherOperating

// Legacy OTA commission invoices (old Booking FAKTURA imports) are superseded by the
// settlement-created fee records. Match by supplier name to exclude the legacy ones from
// the P&L — but keep any invoice OWNED by a report settlement (the new auto-created cost).
const OTA_SUPPLIER_RE = /booking\.?com|airbnb/i;

/** A recurring/contractual cost paid via bank (rent, parking) with no invoice */
export interface PLRecurringCost {
  id: string;
  date: string;
  counterpartyName?: string;
  amount: number;
  costCategory?: string;
  note?: string;
}

export interface PLData {
  from: string;
  to: string;
  revenue: {
    /** Revenue invoices: direct accommodation */
    accommodation: number;
    /** Revenue invoices: other services */
    otherServices: number;
    /** Gross booking volume from OTA settlements (Airbnb + Booking) — the 'ota_gross' records */
    otaGross: number;
    total: number;
    accommodationInvoices: RevenueInvoice[];
    otherServicesInvoices: RevenueInvoice[];
    otaGrossInvoices: RevenueInvoice[];
  };
  costs: {
    materialsEnergy: number;
    personnelServices: number;
    /** OTA / channel distribution + payment fees (category 'distribution-fees').
     *  Maps to A. Výkonová spotřeba in the statutory statement. */
    distributionFees: number;
    /** Other operating costs incl. recurring bank costs (rent, parking) */
    otherOperating: number;
    total: number;
    materialsInvoices: SupplierInvoice[];
    personnelInvoices: SupplierInvoice[];
    distributionInvoices: SupplierInvoice[];
    otherInvoices: SupplierInvoice[];
    recurringCosts: PLRecurringCost[];
  };
  operatingResult: number;
}

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

  // Cost records owned by a report settlement (the new auto-created fee records)
  const settlementOwnedCostIds = new Set(
    settlementGroups.filter(isReportSettlement).flatMap((g) => g.invoiceIds),
  );
  // A legacy OTA commission invoice = OTA-named supplier cost NOT owned by a settlement.
  const isLegacyOtaCost = (inv: SupplierInvoice) =>
    OTA_SUPPLIER_RE.test(inv.supplierName) && !settlementOwnedCostIds.has(inv.id);

  // ── Revenue (from records, by invoice date) ──────────────────────────────
  // OTA gross booking volume is an 'ota_gross' RevenueInvoice auto-created from a
  // settlement; direct guest revenue is accommodation_direct / other_services.
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

  // ── Costs (from records, by invoice date) ────────────────────────────────
  // Channel fees are the 'distribution-fees' cost records auto-created from settlements.
  // Legacy Booking FAKTURA imports are excluded (superseded by settlement records) to
  // avoid double-counting — they stay visible in the Costs tab but don't hit the P&L.
  const filteredSupplier = supplierInvoices.filter(
    (inv) => inv.invoiceDate >= from && inv.invoiceDate <= to && !isLegacyOtaCost(inv),
  );

  const materialsInvoices    = filteredSupplier.filter((inv) => MATERIALS_CATS.includes(inv.category));
  const personnelInvoices    = filteredSupplier.filter((inv) => PERSONNEL_CATS.includes(inv.category));
  const distributionInvoices = filteredSupplier.filter((inv) => inv.category === DISTRIBUTION_FEES_CATEGORY);
  const otherInvoices        = filteredSupplier.filter(
    (inv) => !MATERIALS_CATS.includes(inv.category)
      && !PERSONNEL_CATS.includes(inv.category)
      && inv.category !== DISTRIBUTION_FEES_CATEGORY,
  );

  // ── Recurring bank costs (rent, parking) — no invoice, but real costs ────
  const recurringCostTxs = bankTxs.filter(
    (tx) => tx.state === 'recurring_cost'
      && tx.direction === 'debit'
      && tx.date >= from
      && tx.date <= to,
  );
  const recurringCosts: PLRecurringCost[] = recurringCostTxs.map((tx) => ({
    id: tx.id,
    date: tx.date,
    counterpartyName: tx.counterpartyName,
    amount: tx.amount,
    costCategory: tx.costCategory,
    note: tx.costNote,
  }));
  const recurringCostTotal = recurringCostTxs.reduce((s, tx) => s + tx.amount, 0);

  const materialsEnergy   = materialsInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const personnelServices = personnelInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const distributionFees  = distributionInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherOperating    = otherInvoices.reduce((s, inv) => s + inv.amountCZK, 0) + recurringCostTotal;
  const costsTotal        = materialsEnergy + personnelServices + distributionFees + otherOperating;

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
      materialsEnergy,
      personnelServices,
      distributionFees,
      otherOperating,
      total: costsTotal,
      materialsInvoices,
      personnelInvoices,
      distributionInvoices,
      otherInvoices,
      recurringCosts,
    },
    operatingResult: revenueTotal - costsTotal,
  };

  return NextResponse.json(data);
}
