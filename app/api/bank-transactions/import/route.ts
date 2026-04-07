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
  originalAmount?: number;
  originalCurrency?: number;
}

function buildColMap(headers: string[]): ColMap {
  const map: ColMap = {};
  headers.forEach((h, i) => {
    const n = norm(h);
    // Date columns — first 'datum' → accounting date, second → value/execution date
    if (n.includes('datum')) {
      if (map.date === undefined) map.date = i;
      else if (map.valueDate === undefined) map.valueDate = i;
      return;
    }
    // Amount — castka (KB+), objem (older KB). Must be exact or start with the word to avoid
    // matching 'Originalni castka' before the primary amount column is set.
    if (map.amount === undefined && (n === 'castka' || n === 'objem')) { map.amount = i; return; }
    // Currency — exact 'mena' only; 'Originalni mena' handled separately below
    if (map.currency === undefined && n === 'mena') { map.currency = i; return; }
    // Original (foreign currency) amount and currency
    if (map.originalAmount === undefined && n.includes('originalni') && n.includes('castka')) { map.originalAmount = i; return; }
    if (map.originalCurrency === undefined && n.includes('originalni') && n.includes('mena')) { map.originalCurrency = i; return; }
    // Counterparty account — "Protistrana", "Protiucet", "Protiúčet"
    if (map.counterpartyAccount === undefined && (n.includes('protistrana') || n.includes('protiucet') || n.includes('ucet protistrany'))) { map.counterpartyAccount = i; return; }
    // Counterparty name — "Nazev protiustrany", "Nazev protistrany", "Nazev protiuctu"
    if (map.counterpartyName === undefined && (n.includes('nazev') || n.includes('protistrany') || n.includes('protiustrany'))) { map.counterpartyName = i; return; }
    // Variable / constant / specific symbol
    if (map.vs === undefined && (n.includes('variabilni') || n.includes('variable') || n === 'vs')) { map.vs = i; return; }
    if (map.ks === undefined && (n.includes('konstantni') || n.includes('constant') || n === 'ks')) { map.ks = i; return; }
    if (map.ss === undefined && (n.includes('specificky') || n.includes('specific') || n === 'ss')) { map.ss = i; return; }
    // Description
    if (map.description === undefined && (n.includes('zprava') || n.includes('message') || n.includes('remittance') || n.includes('poznamka'))) { map.description = i; return; }
    if (map.myDescription === undefined && (n.includes('popis pro me') || n.includes('popis pro') || n.includes('my description'))) { map.myDescription = i; return; }
    if (map.description === undefined && n.includes('popis')) { map.description = i; return; }
    // Transaction type / direction
    if (map.type === undefined && (n.includes('typ') || n.includes('smer') || n.includes('transaction type'))) { map.type = i; return; }
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
  // Strip UTF-8 BOM if present
  const text = csvText.charCodeAt(0) === 0xfeff ? csvText.slice(1) : csvText;

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) return [];

  // Auto-detect separator: count ; vs , vs \t in first few lines
  const sample = lines.slice(0, Math.min(5, lines.length)).join('\n');
  const countSemi  = sample.split(';').length - 1;
  const countComma = sample.split(',').length - 1;
  const countTab   = sample.split('\t').length - 1;
  const sep = countTab >= countSemi && countTab >= countComma ? '\t'
            : countSemi >= countComma ? ';' : ',';

  // Find header line — look up to 20 lines deep (KB+ has 16 metadata rows at top)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const n = norm(lines[i]);
    // Must contain a date-like column AND at least one amount/counterparty column
    const hasDate = n.includes('datum');
    const hasAmount = n.includes('castka') || n.includes('objem');
    const hasCounterparty = n.includes('protistrana') || n.includes('protiucet') || n.includes('protistrany');
    if (hasDate && (hasAmount || hasCounterparty)) {
      headerIdx = i;
      break;
    }
  }
  // Fallback: pick the line with the most separator-delimited columns
  if (headerIdx === -1) {
    let maxCols = 0;
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const cols = splitCsvLine(lines[i], sep).length;
      if (cols > maxCols) { maxCols = cols; headerIdx = i; }
    }
  }
  if (headerIdx === -1) return [];

  const headers = splitCsvLine(lines[headerIdx], sep);
  const colMap = buildColMap(headers);
  const now = new Date().toISOString();
  const results: BankTransaction[] = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i], sep);
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
    const rawOriginalAmount = cell(cols, colMap.originalAmount);
    const originalAmountRaw = rawOriginalAmount ? parseCzechNumber(rawOriginalAmount) : 0;
    const originalCurrencyRaw = cell(cols, colMap.originalCurrency);

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
      originalAmount: originalAmountRaw !== 0 ? Math.abs(originalAmountRaw) : undefined,
      originalCurrency: (originalCurrencyRaw && originalCurrencyRaw !== currency) ? originalCurrencyRaw : undefined,
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
  const isForeign = inv.invoiceCurrency && inv.invoiceCurrency !== 'CZK';
  const compareTo = isForeign ? (tx.originalAmount ?? tx.amount) : tx.amount;
  if (Math.abs(compareTo - inv.amountCZK) >= 1) return false;

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
    // Return first few lines to help diagnose format issues
    const preview = csvText.slice(0, 500).replace(/\r/g, '');
    return NextResponse.json(
      { error: 'No transactions found — check the file format', preview },
      { status: 422 },
    );
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
