import { NextResponse } from 'next/server';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction, BankTransactionState } from '@/types/bankTransaction';
import { matchesCostRule } from '@/types/bankCostWhitelist';
import { readAllSupplierInvoices, writeAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readAllBankTransactions, writeAllBankTransactions } from '@/utils/bankTransactionsStore';
import { readAllBankCostWhitelist } from '@/utils/bankCostWhitelistStore';
import { findAutoMatches, learnCounterparties } from '@/utils/bankInvoiceMatch';
import { decodeCsvBytes, parseKbCsv, selectNewRows } from '@/utils/kbCsv';

/**
 * Collapse duplicate-id rows that predate the switch to the bank's unique
 * transaction id. When two copies share an id, keep the one carrying a
 * meaningful (non-default) state so a reconciled/classified row isn't lost.
 */
function dedupeById(txs: BankTransaction[]): { deduped: BankTransaction[]; removed: number } {
  const rank = (s: BankTransactionState) => (s === 'unmatched' || s === 'revenue' ? 0 : 1);
  const byId = new Map<string, BankTransaction>();
  for (const t of txs) {
    const cur = byId.get(t.id);
    if (!cur) { byId.set(t.id, t); continue; }
    byId.set(t.id, rank(t.state) > rank(cur.state) ? t : cur);
  }
  const deduped = [...byId.values()];
  return { deduped, removed: txs.length - deduped.length };
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  let csvText: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    // KB exports Windows-1250 — file.text() would force UTF-8 and mangle Czech letters
    csvText = decodeCsvBytes(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 });
  }

  const parsed = parseKbCsv(csvText);
  if (parsed.length === 0) {
    // Return first few lines to help diagnose format issues
    const preview = csvText.slice(0, 500).replace(/\r/g, '');
    return NextResponse.json(
      { error: 'No transactions found — check the file format', preview },
      { status: 422 },
    );
  }

  // Load existing transactions to deduplicate. Self-heal any legacy duplicate-id
  // rows (see dedupeById) so re-keyed pairs collapse automatically on import.
  const rawExisting = await readAllBankTransactions();
  const { deduped: existing, removed: selfHealed } = dedupeById(rawExisting);

  // Skip rows already stored (by bank id, or by the legacy hash for rows imported
  // before the bank id was used) and rows the CSV lists twice — see selectNewRows.
  const newTxs = selectNewRows(parsed, existing);
  const duplicates = parsed.length - newTxs.length;

  if (newTxs.length === 0) {
    // Nothing new, but still persist a self-heal collapse if one happened.
    if (selfHealed > 0) await writeAllBankTransactions(existing);
    return NextResponse.json({ imported: 0, duplicates, autoReconciled: 0, autoClassified: 0, transactions: existing });
  }

  const invoices = await readAllSupplierInvoices();

  // Recurring-cost whitelist — auto-classify contractual standing orders (rent, parking)
  const costRules = await readAllBankCostWhitelist();

  const now = new Date().toISOString();
  let autoReconciled = 0;
  let autoClassified = 0;
  const updatedInvoices = [...invoices];

  // Whitelist wins over invoice matching — these payments never have an invoice.
  for (const tx of newTxs) {
    if (tx.direction !== 'debit') continue;
    const rule = costRules.find((r) => matchesCostRule(tx, r));
    if (rule) {
      tx.state = 'recurring_cost';
      tx.costCategory = rule.costCategory;
      tx.ignoredAt = now;
      autoClassified++;
    }
  }

  // Invoice matching for the NEW rows only (the Auto-match button covers older
  // ones). Older unmatched debits still take part as rivals, so a new row can't
  // grab an invoice that is just as likely an older payment's.
  const newIds = new Set(newTxs.map((t) => t.id));
  const matches = findAutoMatches(
    [...existing, ...newTxs],
    invoices,
    learnCounterparties(existing, invoices),
  ).filter((m) => newIds.has(m.tx.id));

  for (const { tx, invoice, reason } of matches) {
    tx.state = 'reconciled';
    tx.invoiceId = invoice.id;
    tx.invoiceIds = [invoice.id];
    tx.reconciledAt = now;
    tx.autoMatchReason = reason;

    const idx = updatedInvoices.findIndex((i) => i.id === invoice.id);
    if (idx !== -1) {
      updatedInvoices[idx] = { ...updatedInvoices[idx], status: 'reconciled', bankTransactionId: tx.id, reconciledAt: now };
    }
    autoReconciled++;
  }

  const allTransactions = [...existing, ...newTxs];
  allTransactions.sort((a, b) => b.date.localeCompare(a.date));

  // Persist both
  await Promise.all([
    writeAllBankTransactions(allTransactions),
    writeAllSupplierInvoices(updatedInvoices),
  ]);

  return NextResponse.json({
    imported: newTxs.length,
    duplicates,
    autoReconciled,
    autoClassified,
    transactions: allTransactions,
  });
}
