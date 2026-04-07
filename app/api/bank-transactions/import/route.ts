import { NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { requireRole } from '@/utils/authGuard';
import type { BankTransaction, BankTransactionDirection, BankTransactionState } from '@/types/bankTransaction';
import type { SupplierInvoice } from '@/types/supplierInvoice';

const TX_KEY = 'baker:bank-transactions';
const INV_KEY = 'baker:supplier-invoices';

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/** Strip Czech diacritics and lowercase for fuzzy column matching */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

/** Parse a KB-format number: "1 500,00" or "-1500,00" → float */
function parseCzechNumber(s: string): number {
  return parseFloat(s.replace(/\s/g, '').replace(',', '.')) || 0;
}

/** Parse DD.MM.YYYY → YYYY-MM-DD */
function parseDate(s: string): string {
  const parts = s.trim().split('.');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // fallback: assume already YYYY-MM-DD
  return s.trim();
}

/** Split a CSV line respecting quoted fields */
function splitCsvLine(line: string, sep = ';'): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === sep && !inQuote) {
      result.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim().replace(/^"|"$/g, ''));
  return result;
}

interface ColMap {
  date?: number;
  valueDate?: number;
  amount?: number;
  currency?: number;
  counterpartyAccount?: number;
  counterpartyName?: number;
  vs?: number;
  ks?: number;
  ss?: number;
  description?: number;
  myDescription?: number;
  type?: number;
}

function buildColMap(headers: string[]): ColMap {
  const map: ColMap = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    if (n.includes('datum pohybu') || n === 'datum') map.date = i;
    else if (n.includes('datum splatnosti') || n.includes('splatnosti')) map.valueDate = i;
    else if (n === 'objem' || n === 'castka' || n === 'amount') map.amount = i;
    else if (n === 'mena' || n === 'mena' || n === 'currency') map.currency = i;
    else if (n.includes('protiucet') || n.includes('counterparty account')) map.counterpartyAccount = i;
    else if (n.includes('nazev protistrany') || n.includes('protistrany')) map.counterpartyName = i;
    else if (n.includes('variabilni') || n.includes('variable')) map.vs = i;
    else if (n.includes('konstantni') || n.includes('constant')) map.ks = i;
    else if (n.includes('specificky') || n.includes('specific')) map.ss = i;
    else if (n.includes('zprava pro prijemce') || n.includes('message')) map.description = i;
    else if (n.includes('popis pro me')) map.myDescription = i;
    else if (n.includes('popis') && map.description === undefined) map.description = i;
    else if (n.includes('typ pohybu') || n.includes('transaction type')) map.type = i;
  });
  return map;
}

function cell(cols: string[], idx: number | undefined): string {
  if (idx === undefined || idx >= cols.length) return '';
  return cols[idx] ?? '';
}

/** Deterministic transaction ID */
function makeTxId(
  date: string,
  amount: number,
  direction: BankTransactionDirection,
  counterpartyAccount: string,
  vs: string,
): string {
  const raw = `${date}|${amount}|${direction}|${counterpartyAccount}|${vs}`;
  return Buffer.from(raw).toString('base64url').slice(0, 24);
}

function parseKbCsv(csvText: string): BankTransaction[] {
  const lines = csvText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Find header line — first line that contains a recognisable column keyword
  let headerIdx = 0;
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const n = norm(lines[i]);
    if (n.includes('datum') || n.includes('objem') || n.includes('castka')) {
      headerIdx = i;
      break;
    }
  }

  const headers = splitCsvLine(lines[headerIdx]);
  const colMap = buildColMap(headers);
  const now = new Date().toISOString();
  const results: BankTransaction[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (cols.length < 2) continue;

    const dateStr = cell(cols, colMap.date);
    if (!dateStr) continue;

    const rawAmount = parseCzechNumber(cell(cols, colMap.amount));
    if (rawAmount === 0 && cell(cols, colMap.amount) === '') continue;

    const direction: BankTransactionDirection = rawAmount < 0 ? 'debit' : 'credit';
    const amount = Math.abs(rawAmount);
    const date = parseDate(dateStr);
    const valueDateRaw = cell(cols, colMap.valueDate);
    const counterpartyAccount = cell(cols, colMap.counterpartyAccount);
    const counterpartyName = cell(cols, colMap.counterpartyName);
    const vs = cell(cols, colMap.vs);
    const ks = cell(cols, colMap.ks);
    const ss = cell(cols, colMap.ss);
    const description = cell(cols, colMap.description);
    const myDescription = cell(cols, colMap.myDescription);
    const currency = cell(cols, colMap.currency) || 'CZK';
    const transactionType = cell(cols, colMap.type);

    const id = makeTxId(date, amount, direction, counterpartyAccount, vs);
    const state: BankTransactionState = direction === 'credit' ? 'revenue' : 'unmatched';

    results.push({
      id,
      date,
      valueDate: valueDateRaw ? parseDate(valueDateRaw) : undefined,
      amount,
      direction,
      currency,
      counterpartyAccount: counterpartyAccount || undefined,
      counterpartyName: counterpartyName || undefined,
      variableSymbol: vs || undefined,
      constantSymbol: ks || undefined,
      specificSymbol: ss || undefined,
      description: description || undefined,
      myDescription: myDescription || undefined,
      transactionType: transactionType || undefined,
      state,
      importedAt: now,
    });
  }

  return results;
}

// ── Auto-reconciliation ──────────────────────────────────────────────────────

function normStr(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Returns true if the transaction is a confident match for the invoice.
 * Conditions: exact amount (within 1 CZK) AND
 *   (counterparty name contains supplier name OR VS matches invoice number)
 */
function isConfidentMatch(tx: BankTransaction, inv: SupplierInvoice): boolean {
  if (Math.abs(tx.amount - inv.amountCZK) >= 1) return false;

  const nameMatch =
    tx.counterpartyName &&
    normStr(tx.counterpartyName).includes(normStr(inv.supplierName));

  const vsMatch =
    tx.variableSymbol &&
    normStr(tx.variableSymbol) === normStr(inv.invoiceNumber);

  return !!(nameMatch || vsMatch);
}

// ── POST handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const redis = getRedis();
  if (!redis) return NextResponse.json({ error: 'Redis not configured' }, { status: 503 });

  let csvText: string;
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    csvText = await file.text();
  } catch {
    return NextResponse.json({ error: 'Failed to read uploaded file' }, { status: 400 });
  }

  const parsed = parseKbCsv(csvText);
  if (parsed.length === 0) {
    return NextResponse.json({ error: 'No transactions found — check the file format' }, { status: 422 });
  }

  // Load existing transactions to deduplicate
  const rawTx = await redis.get(TX_KEY);
  const existing = (Array.isArray(rawTx) ? rawTx : []) as BankTransaction[];
  const existingIds = new Set(existing.map((t) => t.id));

  const newTxs = parsed.filter((t) => !existingIds.has(t.id));
  let duplicates = parsed.length - newTxs.length;

  if (newTxs.length === 0) {
    return NextResponse.json({ imported: 0, duplicates, autoReconciled: 0, transactions: existing });
  }

  // Load invoices for auto-reconciliation
  const rawInv = await redis.get(INV_KEY);
  const invoices = (Array.isArray(rawInv) ? rawInv : []) as SupplierInvoice[];
  // Only consider pending invoices with no existing bank link
  const pendingInvoices = invoices.filter(
    (inv) => inv.status === 'pending' && !inv.bankTransactionId,
  );

  const now = new Date().toISOString();
  let autoReconciled = 0;
  const updatedInvoices = [...invoices];

  for (const tx of newTxs) {
    if (tx.direction !== 'debit') continue;

    const matches = pendingInvoices.filter((inv) => isConfidentMatch(tx, inv));
    if (matches.length === 1) {
      const inv = matches[0];
      tx.state = 'reconciled';
      tx.invoiceId = inv.id;
      tx.reconciledAt = now;

      // Update invoice in the working copy
      const idx = updatedInvoices.findIndex((i) => i.id === inv.id);
      if (idx !== -1) {
        updatedInvoices[idx] = {
          ...updatedInvoices[idx],
          status: 'reconciled',
          bankTransactionId: tx.id,
          reconciledAt: now,
        };
      }
      // Remove from pendingInvoices so the same invoice can't match twice
      const piIdx = pendingInvoices.findIndex((i) => i.id === inv.id);
      if (piIdx !== -1) pendingInvoices.splice(piIdx, 1);

      autoReconciled++;
    }
  }

  const allTransactions = [...existing, ...newTxs];
  allTransactions.sort((a, b) => b.date.localeCompare(a.date));

  // Persist both
  await Promise.all([
    redis.set(TX_KEY, allTransactions),
    redis.set(INV_KEY, updatedInvoices),
  ]);

  return NextResponse.json({
    imported: newTxs.length,
    duplicates,
    autoReconciled,
    transactions: allTransactions,
  });
}
