/**
 * KB (Komerční banka, "KB+") bank-statement CSV parsing — shared by the bank
 * import route and one-off repair scripts.
 *
 * KB exports Windows-1250, not UTF-8: decoding it as UTF-8 turned every Czech
 * letter into U+FFFD ("Odchozí úhrada" → "Odchoz� �hrada", "SHORNÁ" → "SHORN�").
 * decodeCsvBytes reads UTF-8 when the bytes are valid UTF-8 and falls back to
 * Windows-1250 otherwise. Transaction ids (bank "Identifikace transakce" or the
 * legacy date|amount|dir|account|VS hash) are ASCII, so decoding never changes them.
 */
import type { BankTransaction, BankTransactionDirection, BankTransactionState } from '@/types/bankTransaction';

/** Decode an uploaded statement: UTF-8 if the bytes are valid UTF-8, else Windows-1250 (KB's export encoding). */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1250').decode(bytes);
  }
}

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
  bankId?: number;
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
    // Bank's own globally-unique transaction identifier — "Identifikace transakce"
    if (map.bankId === undefined && n.includes('identifikace')) { map.bankId = i; return; }
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
export function makeTxId(
  date: string,
  amount: number,
  direction: BankTransactionDirection,
  counterpartyAccount: string,
  vs: string,
): string {
  const raw = `${date}|${amount}|${direction}|${counterpartyAccount}|${vs}`;
  return Buffer.from(raw).toString('base64url').slice(0, 24);
}

export function parseKbCsv(csvText: string): BankTransaction[] {
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

    // Prefer the bank's own unique transaction ID ("Identifikace transakce");
    // fall back to the deterministic hash only if the column is absent.
    const bankId = cell(cols, colMap.bankId).trim();
    const id = bankId || makeTxId(date, amount, direction, counterpartyAccount, vs);
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

/** Payment-message fingerprint, ASCII only so it survives the old mis-decoding. */
function messageKey(t: BankTransaction): string {
  return `${t.description ?? ''}|${t.myDescription ?? ''}`.replace(/[^\x20-\x7e]/g, '').trim();
}

/**
 * Rows of a parsed statement that aren't stored yet. A row is already stored when
 * its bank id is, or — for rows imported before the bank's "Identifikace transakce"
 * became the id — when a stored row carries its legacy date|amount|dir|account|VS
 * hash. That hash can't tell two identical same-day payments apart (2 Jun 2026: two
 * RYWA 3 135 Kč transfers, the second silently dropped), so each stored legacy row
 * absorbs only ONE parsed row: the one with the same payment message, else the first.
 * Rows the CSV lists twice (same id) count once.
 */
export function selectNewRows(parsed: BankTransaction[], existing: BankTransaction[]): BankTransaction[] {
  const stored = new Map(existing.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const candidates = parsed.filter((t) => {
    if (seen.has(t.id) || stored.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });

  // Group the candidates that collide with a stored legacy-hash row
  const byLegacy = new Map<string, BankTransaction[]>();
  for (const t of candidates) {
    const legacy = makeTxId(t.date, t.amount, t.direction, t.counterpartyAccount ?? '', t.variableSymbol ?? '');
    if (stored.has(legacy)) byLegacy.set(legacy, [...(byLegacy.get(legacy) ?? []), t]);
  }
  const absorbed = new Set<BankTransaction>();
  for (const [legacy, rows] of byLegacy) {
    const key = messageKey(stored.get(legacy)!);
    absorbed.add(rows.find((r) => messageKey(r) === key) ?? rows[0]);
  }
  return candidates.filter((t) => !absorbed.has(t));
}
