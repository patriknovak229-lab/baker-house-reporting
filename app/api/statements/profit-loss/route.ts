import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Supplier invoice categories → Czech P&L sections
const MATERIALS_CATS   = ['utilities', 'consumables'];
const PERSONNEL_CATS   = ['cleaning', 'laundry'];
// Everything else → otherOperating

/** Minimal bank transaction shape for the P&L response (avoids serialising all fields) */
export interface PLBankTx {
  id: string;
  date: string;
  counterpartyName?: string;
  amount: number;           // net payout received
  grossAmount?: number;     // gross before OTA fee deduction (if known)
  state: string;            // 'net_settlement' | 'grouped'
}

export interface PLData {
  from: string;
  to: string;
  revenue: {
    /** Revenue invoices: direct accommodation */
    accommodation: number;
    /** Revenue invoices: other services */
    otherServices: number;
    /** OTA net payouts: net_settlement + grouped bank credits */
    otaSettlements: number;
    total: number;
    accommodationInvoices: RevenueInvoice[];
    otherServicesInvoices: RevenueInvoice[];
    otaTransactions: PLBankTx[];
  };
  costs: {
    materialsEnergy: number;
    personnelServices: number;
    /** Operating costs — OTA fee invoices already covered by net payouts are excluded */
    otherOperating: number;
    total: number;
    materialsInvoices: SupplierInvoice[];
    personnelInvoices: SupplierInvoice[];
    otherInvoices: SupplierInvoice[];
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

  const [rawRevenue, rawSupplier, rawTxs] = await Promise.all([
    redis.get<RevenueInvoice[]>('baker:revenue-invoices'),
    redis.get<SupplierInvoice[]>('baker:supplier-invoices'),
    redis.get<BankTransaction[]>('baker:bank-transactions'),
  ]);

  const revenueInvoices: RevenueInvoice[]   = rawRevenue  ?? [];
  const supplierInvoices: SupplierInvoice[] = rawSupplier ?? [];
  const bankTxs: BankTransaction[]          = rawTxs      ?? [];

  // ── OTA net settlement bank credits in period ────────────────────────────
  // Includes: net_settlement (Booking.com) + grouped (Airbnb weekly payouts)
  const otaTxs = bankTxs.filter(
    (tx) => (tx.state === 'net_settlement' || tx.state === 'grouped')
      && tx.direction === 'credit'
      && tx.date >= from
      && tx.date <= to,
  );
  const otaSettlements = otaTxs.reduce((s, tx) => s + tx.amount, 0);

  // Build set of supplier invoice IDs that are already "paid" via OTA net payouts
  // → these should NOT appear as costs (they're the fee already deducted from the payout)
  const otaCoveredInvIds = new Set<string>();

  // 1. net_settlement: deductedInvoiceIds on the bank tx itself
  for (const tx of bankTxs.filter((t) => t.state === 'net_settlement')) {
    for (const id of (tx.deductedInvoiceIds ?? [])) {
      otaCoveredInvIds.add(id);
    }
  }
  // 2. settlement groups: invoices with settlementGroupId set
  //    (their fees were deducted before the grouped payouts were received)
  for (const inv of supplierInvoices) {
    if (inv.settlementGroupId) otaCoveredInvIds.add(inv.id);
  }

  // ── Revenue invoices (direct, non-OTA) ──────────────────────────────────
  const filteredRevenue = revenueInvoices.filter(
    (inv) => inv.invoiceDate >= from && inv.invoiceDate <= to && inv.category !== 'mistake',
  );

  const accommodationInvoices = filteredRevenue.filter((inv) => inv.category === 'accommodation_direct');
  const otherServicesInvoices  = filteredRevenue.filter((inv) => inv.category === 'other_services');
  const accommodation  = accommodationInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherServices  = otherServicesInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const revenueTotal   = accommodation + otherServices + otaSettlements;

  // ── Supplier invoice costs — exclude OTA-covered fee invoices ───────────
  const filteredSupplier = supplierInvoices.filter(
    (inv) => inv.invoiceDate >= from && inv.invoiceDate <= to && !otaCoveredInvIds.has(inv.id),
  );

  const materialsInvoices = filteredSupplier.filter((inv) => MATERIALS_CATS.includes(inv.category));
  const personnelInvoices = filteredSupplier.filter((inv) => PERSONNEL_CATS.includes(inv.category));
  const otherInvoices     = filteredSupplier.filter(
    (inv) => !MATERIALS_CATS.includes(inv.category) && !PERSONNEL_CATS.includes(inv.category),
  );

  const materialsEnergy   = materialsInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const personnelServices = personnelInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherOperating    = otherInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const costsTotal        = materialsEnergy + personnelServices + otherOperating;

  const otaTransactions: PLBankTx[] = otaTxs.map((tx) => ({
    id: tx.id,
    date: tx.date,
    counterpartyName: tx.counterpartyName,
    amount: tx.amount,
    grossAmount: tx.grossAmount,
    state: tx.state,
  }));

  const data: PLData = {
    from,
    to,
    revenue: {
      accommodation,
      otherServices,
      otaSettlements,
      total: revenueTotal,
      accommodationInvoices,
      otherServicesInvoices,
      otaTransactions,
    },
    costs: {
      materialsEnergy,
      personnelServices,
      otherOperating,
      total: costsTotal,
      materialsInvoices,
      personnelInvoices,
      otherInvoices,
    },
    operatingResult: revenueTotal - costsTotal,
  };

  return NextResponse.json(data);
}
