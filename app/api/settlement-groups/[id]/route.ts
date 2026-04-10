import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { SettlementGroup } from '@/types/settlementGroup';
import type { BankTransaction } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const GROUPS_KEY   = 'baker:settlement-groups';
const TX_KEY       = 'baker:bank-transactions';
const INV_KEY      = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type Params = { params: Promise<{ id: string }> };

// PUT /api/settlement-groups/[id] — mutate group
export async function PUT(request: Request, { params }: Params) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;
  const body = await request.json() as {
    action: 'add_transaction' | 'remove_transaction' | 'add_invoice' | 'remove_invoice' | 'rename';
    transactionId?: string;
    invoiceId?: string;
    name?: string;
  };

  // Load everything
  const [groups, txs, invoices] = await Promise.all([
    redis.get<SettlementGroup[]>(GROUPS_KEY).then((g) => g ?? []),
    redis.get<BankTransaction[]>(TX_KEY).then((t) => t ?? []),
    redis.get<SupplierInvoice[]>(INV_KEY).then((i) => i ?? []),
  ]);

  const groupIdx = groups.findIndex((g) => g.id === id);
  if (groupIdx === -1) return NextResponse.json({ error: 'Group not found' }, { status: 404 });

  const group = { ...groups[groupIdx] };
  let updatedTxs       = txs;
  let updatedInvoices  = invoices;
  let deleteGroup      = false;

  if (body.action === 'rename') {
    if (!body.name?.trim()) return NextResponse.json({ error: 'name is required' }, { status: 400 });
    group.name = body.name.trim();
  }

  if (body.action === 'add_transaction') {
    const txId = body.transactionId!;
    if (!group.transactionIds.includes(txId)) {
      group.transactionIds = [...group.transactionIds, txId];
    }
    updatedTxs = txs.map((t) =>
      t.id === txId ? { ...t, state: 'grouped' as const, settlementGroupId: id } : t,
    );
  }

  if (body.action === 'remove_transaction') {
    const txId = body.transactionId!;
    group.transactionIds = group.transactionIds.filter((tid) => tid !== txId);
    updatedTxs = txs.map((t) =>
      t.id === txId
        ? { ...t, state: 'revenue' as const, settlementGroupId: undefined }
        : t,
    );
    // Auto-delete group if last transaction removed
    if (group.transactionIds.length === 0) {
      deleteGroup = true;
      // Also un-reconcile any attached invoices
      updatedInvoices = invoices.map((inv) =>
        group.invoiceIds.includes(inv.id)
          ? { ...inv, status: 'pending' as const, settlementGroupId: undefined, bankTransactionId: undefined, reconciledAt: undefined }
          : inv,
      );
    }
  }

  if (body.action === 'add_invoice') {
    const invId = body.invoiceId!;
    if (!group.invoiceIds.includes(invId)) {
      group.invoiceIds = [...group.invoiceIds, invId];
    }
    updatedInvoices = invoices.map((inv) =>
      inv.id === invId
        ? { ...inv, status: 'reconciled' as const, settlementGroupId: id, reconciledAt: new Date().toISOString() }
        : inv,
    );
  }

  if (body.action === 'remove_invoice') {
    const invId = body.invoiceId!;
    group.invoiceIds = group.invoiceIds.filter((iid) => iid !== invId);
    updatedInvoices = invoices.map((inv) =>
      inv.id === invId
        ? { ...inv, status: 'pending' as const, settlementGroupId: undefined, reconciledAt: undefined }
        : inv,
    );
  }

  // Persist
  let updatedGroups: SettlementGroup[];
  if (deleteGroup) {
    updatedGroups = groups.filter((g) => g.id !== id);
  } else {
    updatedGroups = groups.map((g, i) => (i === groupIdx ? group : g));
  }

  await Promise.all([
    redis.set(GROUPS_KEY, updatedGroups),
    redis.set(TX_KEY, updatedTxs),
    redis.set(INV_KEY, updatedInvoices),
  ]);

  return NextResponse.json({
    group: deleteGroup ? null : group,
    deleted: deleteGroup,
  });
}

// DELETE /api/settlement-groups/[id] — remove group; reset all its txs and invoices
export async function DELETE(_request: Request, { params }: Params) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const { id } = await params;

  const [groups, txs, invoices] = await Promise.all([
    redis.get<SettlementGroup[]>(GROUPS_KEY).then((g) => g ?? []),
    redis.get<BankTransaction[]>(TX_KEY).then((t) => t ?? []),
    redis.get<SupplierInvoice[]>(INV_KEY).then((i) => i ?? []),
  ]);

  const group = groups.find((g) => g.id === id);
  if (!group) return NextResponse.json({ error: 'Group not found' }, { status: 404 });

  // Reset all grouped transactions
  const updatedTxs = txs.map((t) =>
    group.transactionIds.includes(t.id)
      ? { ...t, state: 'revenue' as const, settlementGroupId: undefined }
      : t,
  );

  // Reset all attached invoices
  const updatedInvoices = invoices.map((inv) =>
    group.invoiceIds.includes(inv.id)
      ? { ...inv, status: 'pending' as const, settlementGroupId: undefined, bankTransactionId: undefined, reconciledAt: undefined }
      : inv,
  );

  const updatedGroups = groups.filter((g) => g.id !== id);

  await Promise.all([
    redis.set(GROUPS_KEY, updatedGroups),
    redis.set(TX_KEY, updatedTxs),
    redis.set(INV_KEY, updatedInvoices),
  ]);

  return NextResponse.json({ deleted: true });
}
