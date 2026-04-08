import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction, IgnoreCategoryId } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const TX_KEY = 'baker:bank-transactions';
const INV_KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

type ReconcileBody      = { action: 'reconcile'; invoiceId: string };
type IgnoreBody         = { action: 'ignore'; ignoreCategory: IgnoreCategoryId; ignoreNote?: string };
type UnmatchBody        = { action: 'unmatch' };
type NoteBody           = { action: 'note'; note: string };
type RefundBody         = { action: 'refund'; linkedTransactionId?: string; partial: boolean };
type NonDeductibleBody  = { action: 'non_deductible'; ignoreNote?: string };
type NetSettlementBody  = { action: 'net_settlement'; deductedInvoiceIds: string[]; grossAmount?: number };
type PutBody = ReconcileBody | IgnoreBody | UnmatchBody | NoteBody | RefundBody | NonDeductibleBody | NetSettlementBody;

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireRole(['admin', 'accountant']);
  if ('error' in guard) return guard.error;

  const { id } = await params;
  const body = await request.json() as PutBody;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  const [rawTx, rawInv] = await Promise.all([
    redis.get(TX_KEY),
    redis.get(INV_KEY),
  ]);

  const transactions = (Array.isArray(rawTx) ? rawTx : []) as BankTransaction[];
  const invoices     = (Array.isArray(rawInv) ? rawInv : []) as SupplierInvoice[];

  const txIdx = transactions.findIndex((t) => t.id === id);
  if (txIdx === -1) return NextResponse.json({ error: 'Transaction not found' }, { status: 404 });

  const tx = { ...transactions[txIdx] };
  const now = new Date().toISOString();

  if (body.action === 'reconcile') {
    const invIdx = invoices.findIndex((i) => i.id === body.invoiceId);
    if (invIdx === -1) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });

    // Un-link any previously matched invoice
    if (tx.invoiceId && tx.invoiceId !== body.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'reconciled';
    tx.invoiceId = body.invoiceId;
    tx.linkedTransactionId = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = undefined;
    tx.ignoredAt = undefined;
    tx.reconciledAt = now;

    invoices[invIdx] = {
      ...invoices[invIdx],
      status: 'reconciled',
      bankTransactionId: id,
      reconciledAt: now,
    };

  } else if (body.action === 'ignore') {
    // Un-link any previously matched invoice
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'ignored';
    tx.invoiceId = undefined;
    tx.linkedTransactionId = undefined;
    tx.reconciledAt = undefined;
    tx.ignoreCategory = body.ignoreCategory;
    tx.ignoreNote = body.ignoreNote || undefined;
    tx.ignoredAt = now;

  } else if (body.action === 'non_deductible') {
    // Un-link any previously matched invoice
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = {
          ...invoices[prevIdx],
          status: 'pending',
          bankTransactionId: undefined,
          reconciledAt: undefined,
        };
      }
    }

    tx.state = 'non_deductible';
    tx.invoiceId = undefined;
    tx.linkedTransactionId = undefined;
    tx.reconciledAt = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = body.ignoreNote || undefined;
    tx.ignoredAt = now;

  } else if (body.action === 'net_settlement') {
    // Un-reconcile any previously linked invoices (reconcile action path)
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = { ...invoices[prevIdx], status: 'pending', bankTransactionId: undefined, reconciledAt: undefined, settlementTransactionIds: undefined };
      }
    }

    // Remove this tx from invoices that were previously deducted but are no longer in the new list
    for (const prevInvId of tx.deductedInvoiceIds ?? []) {
      if (!body.deductedInvoiceIds.includes(prevInvId)) {
        const prevIdx = invoices.findIndex((i) => i.id === prevInvId);
        if (prevIdx !== -1) {
          const remaining = (invoices[prevIdx].settlementTransactionIds ?? []).filter((tid) => tid !== id);
          if (remaining.length > 0) {
            invoices[prevIdx] = {
              ...invoices[prevIdx],
              settlementTransactionIds: remaining,
              // if bankTransactionId pointed to this tx, update to the first remaining settlement
              bankTransactionId: invoices[prevIdx].bankTransactionId === id ? remaining[0] : invoices[prevIdx].bankTransactionId,
            };
          } else {
            invoices[prevIdx] = { ...invoices[prevIdx], status: 'pending', bankTransactionId: undefined, reconciledAt: undefined, settlementTransactionIds: undefined };
          }
        }
      }
    }

    tx.state = 'net_settlement';
    tx.grossAmount = body.grossAmount ?? undefined;
    tx.deductedInvoiceIds = body.deductedInvoiceIds.length > 0 ? body.deductedInvoiceIds : undefined;
    tx.invoiceId = undefined;
    tx.linkedTransactionId = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = undefined;
    tx.ignoredAt = undefined;
    tx.reconciledAt = now;

    // Add this tx to each deducted invoice's settlementTransactionIds
    for (const invId of body.deductedInvoiceIds) {
      const invIdx = invoices.findIndex((i) => i.id === invId);
      if (invIdx !== -1) {
        const existing = invoices[invIdx].settlementTransactionIds ?? [];
        const updated  = existing.includes(id) ? existing : [...existing, id];
        invoices[invIdx] = {
          ...invoices[invIdx],
          status: 'reconciled',
          bankTransactionId: invoices[invIdx].bankTransactionId ?? id,
          reconciledAt: invoices[invIdx].reconciledAt ?? now,
          settlementTransactionIds: updated,
        };
      }
    }

  } else if (body.action === 'refund') {
    // If previously linked to a different debit, reset that debit first
    if (tx.linkedTransactionId && tx.linkedTransactionId !== body.linkedTransactionId) {
      const prevDebitIdx = transactions.findIndex((t) => t.id === tx.linkedTransactionId);
      if (prevDebitIdx !== -1) {
        transactions[prevDebitIdx] = {
          ...transactions[prevDebitIdx],
          linkedTransactionId: undefined,
          state: 'unmatched',
          reconciledAt: undefined,
        };
      }
    }

    tx.state = body.partial ? 'partial_refund' : 'refund';
    tx.linkedTransactionId = body.linkedTransactionId || undefined;
    tx.invoiceId = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoredAt = undefined;
    tx.reconciledAt = now;

    // Mark the linked debit as reconciled (bi-directional)
    if (body.linkedTransactionId) {
      const debitIdx = transactions.findIndex((t) => t.id === body.linkedTransactionId);
      if (debitIdx !== -1) {
        transactions[debitIdx] = {
          ...transactions[debitIdx],
          linkedTransactionId: id,
          state: 'reconciled',
          reconciledAt: now,
        };
      }
    }

  } else if (body.action === 'note') {
    tx.ignoreNote = body.note || undefined;

  } else if (body.action === 'unmatch') {
    // Un-reconcile single linked invoice (reconcile path)
    if (tx.invoiceId) {
      const prevIdx = invoices.findIndex((i) => i.id === tx.invoiceId);
      if (prevIdx !== -1) {
        invoices[prevIdx] = { ...invoices[prevIdx], status: 'pending', bankTransactionId: undefined, reconciledAt: undefined };
      }
    }
    // Un-reconcile all deducted invoices (net_settlement path)
    // Remove this tx from each invoice's settlementTransactionIds; only reset to pending if no other settlements remain
    for (const prevInvId of tx.deductedInvoiceIds ?? []) {
      const prevIdx = invoices.findIndex((i) => i.id === prevInvId);
      if (prevIdx !== -1) {
        const remaining = (invoices[prevIdx].settlementTransactionIds ?? []).filter((tid) => tid !== id);
        if (remaining.length > 0) {
          invoices[prevIdx] = {
            ...invoices[prevIdx],
            settlementTransactionIds: remaining,
            bankTransactionId: invoices[prevIdx].bankTransactionId === id ? remaining[0] : invoices[prevIdx].bankTransactionId,
          };
        } else {
          invoices[prevIdx] = { ...invoices[prevIdx], status: 'pending', bankTransactionId: undefined, reconciledAt: undefined, settlementTransactionIds: undefined };
        }
      }
    }
    // Reset linked debit (refund/partial_refund path)
    if (tx.linkedTransactionId && (tx.state === 'refund' || tx.state === 'partial_refund')) {
      const debitIdx = transactions.findIndex((t) => t.id === tx.linkedTransactionId);
      if (debitIdx !== -1) {
        transactions[debitIdx] = {
          ...transactions[debitIdx],
          linkedTransactionId: undefined,
          state: 'unmatched',
          reconciledAt: undefined,
        };
      }
    }

    tx.state = tx.direction === 'credit' ? 'revenue' : 'unmatched';
    tx.invoiceId = undefined;
    tx.linkedTransactionId = undefined;
    tx.grossAmount = undefined;
    tx.deductedInvoiceIds = undefined;
    tx.reconciledAt = undefined;
    tx.ignoreCategory = undefined;
    tx.ignoreNote = undefined;
    tx.ignoredAt = undefined;
  }

  transactions[txIdx] = tx;

  await Promise.all([
    redis.set(TX_KEY, transactions),
    redis.set(INV_KEY, invoices),
  ]);

  return NextResponse.json(tx);
}
