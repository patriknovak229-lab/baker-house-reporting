import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { google } from 'googleapis';
import ExcelJS from 'exceljs';
import { requireRole } from '@/utils/authGuard';
import { auth } from '@/auth';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import type { BankTransaction } from '@/types/bankTransaction';
import { classifyCost, RECURRING_ENTRY } from '@/utils/costBridge';

/** Fixed Drive folder the accountant asked exports to be uploaded into. */
const EXPORT_FOLDER_ID = '1NgIm5ScAhCryR6YHsCCKuw5likraY7jl';

/** Revenue ledger account (Tržby z prodeje služeb). */
const REVENUE_ACCOUNT = '602';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/** Accrual period key — matches the P&L route (prefer DUZP / taxable-supply date). */
function costDate(inv: SupplierInvoice): string {
  return inv.duzpDate || inv.invoiceDate;
}

/** Supplier invoices linked to a debit (legacy single id or split-delivery array). */
function linkedInvoiceIds(tx: BankTransaction): string[] {
  if (tx.invoiceIds && tx.invoiceIds.length > 0) return tx.invoiceIds;
  return tx.invoiceId ? [tx.invoiceId] : [];
}

// ── Sheet 1: Records (revenue + costs) — ties to the P&L ─────────────────────
interface RecordRow {
  type: string;
  invoiceDate: string;
  supplierName: string;
  supplierICO: string;
  invoiceNumber: string;
  amountCZK: number;
  vatAmountCZK: number | null;
  category: string;
  ledgerAccount: string;
  status: string;
  sourceType: string;
  settlementGroupId: string;
  description: string;
  pdfLink: string;
}

const RECORD_COLUMNS: { header: string; key: keyof RecordRow; width: number }[] = [
  { header: 'type',              key: 'type',              width: 16 },
  { header: 'invoiceDate',       key: 'invoiceDate',       width: 12 },
  { header: 'supplierName',      key: 'supplierName',      width: 34 },
  { header: 'supplierICO',       key: 'supplierICO',       width: 12 },
  { header: 'invoiceNumber',     key: 'invoiceNumber',     width: 20 },
  { header: 'amountCZK',         key: 'amountCZK',         width: 12 },
  { header: 'vatAmountCZK',      key: 'vatAmountCZK',      width: 12 },
  { header: 'category',          key: 'category',          width: 18 },
  { header: 'ledgerAccount',     key: 'ledgerAccount',     width: 12 },
  { header: 'status',            key: 'status',            width: 14 },
  { header: 'sourceType',        key: 'sourceType',        width: 10 },
  { header: 'settlementGroupId', key: 'settlementGroupId', width: 16 },
  { header: 'description',       key: 'description',       width: 40 },
  { header: 'pdfLink',           key: 'pdfLink',           width: 40 },
];

// ── Sheet 2: Bank (every transaction) — matches the bank line-by-line ────────
interface BankRow {
  date: string;
  direction: string;       // in | out
  counterparty: string;
  amountCZK: number;
  variableSymbol: string;
  state: string;
  category: string;
  ledgerAccount: string;
  invoiceNumbers: string;  // linked supplier/revenue invoice number(s)
  supplierICO: string;
  description: string;
  pdfLink: string;
}

const BANK_COLUMNS: { header: string; key: keyof BankRow; width: number }[] = [
  { header: 'date',           key: 'date',           width: 12 },
  { header: 'direction',      key: 'direction',      width: 9  },
  { header: 'counterparty',   key: 'counterparty',   width: 34 },
  { header: 'amountCZK',      key: 'amountCZK',       width: 12 },
  { header: 'variableSymbol', key: 'variableSymbol', width: 14 },
  { header: 'state',          key: 'state',          width: 15 },
  { header: 'category',       key: 'category',       width: 16 },
  { header: 'ledgerAccount',  key: 'ledgerAccount',  width: 12 },
  { header: 'invoiceNumbers', key: 'invoiceNumbers', width: 22 },
  { header: 'supplierICO',    key: 'supplierICO',    width: 12 },
  { header: 'description',    key: 'description',     width: 40 },
  { header: 'pdfLink',        key: 'pdfLink',         width: 40 },
];

export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'accountant']);
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
  const revenueInvoices  = rawRevenue  ?? [];
  const supplierInvoices = rawSupplier ?? [];
  const bankTxs          = rawTxs      ?? [];

  const supplierById = new Map(supplierInvoices.map((i) => [i.id, i]));
  const revenueById  = new Map(revenueInvoices.map((i) => [i.id, i]));

  // ── Records rows ──────────────────────────────────────────────────────────
  const records: RecordRow[] = [];

  for (const inv of revenueInvoices) {
    if (inv.invoiceDate < from || inv.invoiceDate > to || inv.category === 'mistake') continue;
    records.push({
      type: 'Revenue',
      invoiceDate: inv.invoiceDate,
      supplierName: inv.guestName || inv.clientName || '',
      supplierICO: '',
      invoiceNumber: inv.invoiceNumber,
      amountCZK: inv.amountCZK,
      vatAmountCZK: null,
      category: inv.category,
      ledgerAccount: REVENUE_ACCOUNT,
      status: inv.status,
      sourceType: inv.sourceType ?? '',
      settlementGroupId: inv.settlementGroupId ?? '',
      description: inv.description || (inv.reservationNumber ? `Reservation ${inv.reservationNumber}` : ''),
      pdfLink: inv.driveUrl ?? '',
    });
  }
  for (const inv of supplierInvoices) {
    const date = costDate(inv);
    if (date < from || date > to) continue;
    records.push({
      type: 'Cost',
      invoiceDate: inv.invoiceDate,
      supplierName: inv.supplierName,
      supplierICO: inv.supplierICO ?? '',
      invoiceNumber: inv.invoiceNumber,
      amountCZK: inv.amountCZK,
      vatAmountCZK: inv.vatAmountCZK ?? null,
      category: inv.category,
      ledgerAccount: classifyCost(inv.category, inv.amountCZK).account,
      status: inv.status,
      sourceType: inv.sourceType ?? '',
      settlementGroupId: inv.settlementGroupId ?? '',
      description: inv.description ?? '',
      pdfLink: inv.driveUrl ?? '',
    });
  }
  for (const tx of bankTxs) {
    if (tx.state !== 'recurring_cost' || tx.direction !== 'debit') continue;
    if (tx.date < from || tx.date > to) continue;
    records.push({
      type: 'Cost (no invoice)',
      invoiceDate: tx.date,
      supplierName: tx.counterpartyName || tx.costNote || 'Recurring cost',
      supplierICO: '',
      invoiceNumber: '',
      amountCZK: tx.amount,
      vatAmountCZK: null,
      category: tx.costCategory ?? 'recurring',
      ledgerAccount: RECURRING_ENTRY.account,
      status: 'recurring_cost',
      sourceType: 'bank',
      settlementGroupId: '',
      description: tx.costNote || tx.myDescription || tx.description || '',
      pdfLink: '',
    });
  }
  records.sort((a, b) => a.invoiceDate.localeCompare(b.invoiceDate) || a.type.localeCompare(b.type));

  // ── Bank rows (every transaction in period) ───────────────────────────────
  const bankRows: BankRow[] = [];
  for (const tx of bankTxs) {
    if (tx.date < from || tx.date > to) continue;

    const linkedSup = linkedInvoiceIds(tx).map((id) => supplierById.get(id)).filter((i): i is SupplierInvoice => !!i);
    const revInv = tx.revenueInvoiceId ? revenueById.get(tx.revenueInvoiceId) : undefined;

    // category + ledger account per state
    let category = '';
    let ledgerAccount = '';
    if (tx.state === 'reconciled' && linkedSup.length > 0) {
      category = linkedSup.length === 1 ? linkedSup[0].category : 'mixed';
      ledgerAccount = linkedSup.length === 1 ? classifyCost(linkedSup[0].category, linkedSup[0].amountCZK).account : '';
    } else if (tx.state === 'recurring_cost') {
      category = tx.costCategory ?? 'recurring';
      ledgerAccount = RECURRING_ENTRY.account;
    } else if (tx.state === 'net_settlement' || tx.state === 'grouped') {
      category = 'ota_settlement';
      ledgerAccount = REVENUE_ACCOUNT;
    } else if (tx.state === 'revenue' || (tx.direction === 'credit' && tx.revenueInvoiceId)) {
      category = revInv?.category ?? 'revenue';
      ledgerAccount = REVENUE_ACCOUNT;
    } else if (tx.state === 'refund' || tx.state === 'partial_refund') {
      category = 'refund';
    } else if (tx.state === 'ignored') {
      category = tx.ignoreCategory ?? 'transfer';
    } else if (tx.state === 'non_deductible') {
      category = 'non_deductible';
    }

    const invoiceNumbers = linkedSup.length > 0
      ? linkedSup.map((i) => i.invoiceNumber).join('; ')
      : (revInv?.invoiceNumber ?? '');
    const pdfLink = linkedSup[0]?.driveUrl ?? revInv?.driveUrl ?? '';

    bankRows.push({
      date: tx.date,
      direction: tx.direction === 'debit' ? 'out' : 'in',
      counterparty: tx.counterpartyName || tx.description || tx.myDescription || '',
      amountCZK: tx.amount,
      variableSymbol: tx.variableSymbol ?? '',
      state: tx.state,
      category,
      ledgerAccount,
      invoiceNumbers,
      supplierICO: linkedSup[0]?.supplierICO ?? '',
      description: tx.description || tx.myDescription || tx.costNote || tx.ignoreNote || '',
      pdfLink,
    });
  }
  bankRows.sort((a, b) => a.date.localeCompare(b.date));

  // ── Build the workbook (two sheets) ───────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();

  const wsRec = wb.addWorksheet('Records');
  wsRec.columns = RECORD_COLUMNS;
  wsRec.getRow(1).font = { bold: true };
  for (const r of records) {
    const row = wsRec.addRow(r);
    row.getCell('supplierICO').numFmt = '@';
    row.getCell('ledgerAccount').numFmt = '@';
    row.getCell('amountCZK').numFmt = '#,##0.00';
    row.getCell('vatAmountCZK').numFmt = '#,##0.00';
    if (r.pdfLink) row.getCell('pdfLink').value = { text: r.pdfLink, hyperlink: r.pdfLink };
  }

  const wsBank = wb.addWorksheet('Bank');
  wsBank.columns = BANK_COLUMNS;
  wsBank.getRow(1).font = { bold: true };
  for (const r of bankRows) {
    const row = wsBank.addRow(r);
    row.getCell('supplierICO').numFmt = '@';
    row.getCell('ledgerAccount').numFmt = '@';
    row.getCell('variableSymbol').numFmt = '@';
    row.getCell('amountCZK').numFmt = '#,##0.00';
    if (r.pdfLink) row.getCell('pdfLink').value = { text: r.pdfLink, hyperlink: r.pdfLink };
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const fileName = `Statements_${from}_${to}.xlsx`;
  const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  // ── Upload to the fixed Drive folder (signed-in admin's Drive token) ───────
  let driveUrl = '';
  let driveError = '';
  try {
    const session = await auth();
    const refreshToken = (session as unknown as Record<string, unknown>)?.refreshToken as string | undefined;
    if (!refreshToken) throw new Error('No Google refresh token in session — sign out and back in.');

    const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const { token: freshToken } = await oauth2.getAccessToken();
    if (!freshToken) throw new Error('Could not refresh Google token.');
    oauth2.setCredentials({ access_token: freshToken });

    const drive = google.drive({ version: 'v3', auth: oauth2 });
    const { Readable } = await import('stream');
    const res = await drive.files.create({
      requestBody: { name: fileName, parents: [EXPORT_FOLDER_ID], mimeType: MIME },
      media: { mimeType: MIME, body: Readable.from(buffer) },
      fields: 'id,webViewLink',
    });
    driveUrl = res.data.webViewLink ?? '';
  } catch (err) {
    driveError = err instanceof Error ? err.message : 'Drive upload failed';
    console.error('Statements export Drive upload failed:', err);
  }

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': MIME,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'X-Drive-Url': driveUrl,
      'X-Drive-Error': driveError,
      'X-Row-Count': String(records.length),
      'X-Bank-Count': String(bankRows.length),
    },
  });
}
