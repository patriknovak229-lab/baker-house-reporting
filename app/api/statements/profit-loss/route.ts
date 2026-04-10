import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// Supplier invoice categories → Czech P&L sections
const MATERIALS_CATS   = ['utilities', 'consumables'];
const PERSONNEL_CATS   = ['cleaning', 'laundry'];
// Everything else → otherOperating

export interface PLSection {
  label: string;          // Czech statutory label
  code: string;           // e.g. 'B', 'C', 'E', 'II'
  amount: number;
  invoices: SupplierInvoice[] | RevenueInvoice[];
}

export interface PLData {
  from: string;
  to: string;
  revenue: {
    accommodation: number;
    otherServices: number;
    total: number;
    accommodationInvoices: RevenueInvoice[];
    otherServicesInvoices: RevenueInvoice[];
  };
  costs: {
    materialsEnergy: number;
    personnelServices: number;
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

  const [rawRevenue, rawSupplier] = await Promise.all([
    redis.get<RevenueInvoice[]>('baker:revenue-invoices'),
    redis.get<SupplierInvoice[]>('baker:supplier-invoices'),
  ]);

  const revenueInvoices: RevenueInvoice[]   = rawRevenue  ?? [];
  const supplierInvoices: SupplierInvoice[] = rawSupplier ?? [];

  // Filter by date range
  const filteredRevenue  = revenueInvoices.filter((inv) => inv.invoiceDate >= from && inv.invoiceDate <= to && inv.category !== 'mistake');
  const filteredSupplier = supplierInvoices.filter((inv) => inv.invoiceDate >= from && inv.invoiceDate <= to);

  // Revenue buckets
  const accommodationInvoices = filteredRevenue.filter((inv) => inv.category === 'accommodation_direct');
  const otherServicesInvoices  = filteredRevenue.filter((inv) => inv.category === 'other_services');
  const accommodation  = accommodationInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherServices  = otherServicesInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const revenueTotal   = accommodation + otherServices;

  // Cost buckets
  const materialsInvoices  = filteredSupplier.filter((inv) => MATERIALS_CATS.includes(inv.category));
  const personnelInvoices  = filteredSupplier.filter((inv) => PERSONNEL_CATS.includes(inv.category));
  const otherInvoices      = filteredSupplier.filter((inv) => !MATERIALS_CATS.includes(inv.category) && !PERSONNEL_CATS.includes(inv.category));

  const materialsEnergy    = materialsInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const personnelServices  = personnelInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const otherOperating     = otherInvoices.reduce((s, inv) => s + inv.amountCZK, 0);
  const costsTotal         = materialsEnergy + personnelServices + otherOperating;

  const data: PLData = {
    from,
    to,
    revenue: {
      accommodation,
      otherServices,
      total: revenueTotal,
      accommodationInvoices,
      otherServicesInvoices,
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
