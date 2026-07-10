import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { google } from 'googleapis';
import ExcelJS from 'exceljs';
import { requireRole } from '@/utils/authGuard';
import { auth } from '@/auth';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import { classifyCost } from '@/utils/costBridge';

const INV_KEY = 'baker:supplier-invoices';

/** Accrual period key — matches the P&L route (prefer DUZP / taxable-supply date). */
function costDate(inv: SupplierInvoice): string {
  return inv.duzpDate || inv.invoiceDate;
}

/** Fixed Drive folder the accountant asked exports to be uploaded into. */
const EXPORT_FOLDER_ID = '1NgIm5ScAhCryR6YHsCCKuw5likraY7jl';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/** Columns in the exact order requested, plus ledgerAccount + pdfLink. */
const COLUMNS: { header: string; key: string; width: number }[] = [
  { header: 'invoiceDate',       key: 'invoiceDate',       width: 12 },
  { header: 'supplierName',      key: 'supplierName',      width: 34 },
  { header: 'supplierICO',       key: 'supplierICO',       width: 12 },
  { header: 'invoiceNumber',     key: 'invoiceNumber',     width: 20 },
  { header: 'amountCZK',         key: 'amountCZK',         width: 12 },
  { header: 'vatAmountCZK',      key: 'vatAmountCZK',      width: 12 },
  { header: 'category',          key: 'category',          width: 16 },
  { header: 'ledgerAccount',     key: 'ledgerAccount',     width: 12 },
  { header: 'status',            key: 'status',            width: 12 },
  { header: 'sourceType',        key: 'sourceType',        width: 10 },
  { header: 'settlementGroupId', key: 'settlementGroupId', width: 16 },
  { header: 'description',       key: 'description',       width: 40 },
  { header: 'pdfLink',           key: 'pdfLink',           width: 40 },
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

  // ── Supplier (cost) invoices in the period ────────────────────────────────
  // Filter by the same accrual date the P&L uses (DUZP ?? invoiceDate) so the
  // export matches the on-screen statement for the period.
  const raw = await redis.get<SupplierInvoice[]>(INV_KEY);
  const invoices = (raw ?? [])
    .filter((inv) => costDate(inv) >= from && costDate(inv) <= to)
    .sort((a, b) => costDate(a).localeCompare(costDate(b)));

  // ── Build the workbook ────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('Invoices');
  ws.columns = COLUMNS;
  ws.getRow(1).font = { bold: true };

  for (const inv of invoices) {
    const row = ws.addRow({
      invoiceDate:       inv.invoiceDate,
      supplierName:      inv.supplierName,
      supplierICO:       inv.supplierICO ?? '',
      invoiceNumber:     inv.invoiceNumber,
      amountCZK:         inv.amountCZK,
      vatAmountCZK:      inv.vatAmountCZK ?? null,
      category:          inv.category,
      ledgerAccount:     classifyCost(inv.category, inv.amountCZK).account,
      status:            inv.status,
      sourceType:        inv.sourceType ?? '',
      settlementGroupId: inv.settlementGroupId ?? '',
      description:       inv.description ?? '',
      pdfLink:           inv.driveUrl ?? '',
    });
    // Keep IČO / account as text so leading zeros survive; amounts as numbers.
    row.getCell('supplierICO').numFmt = '@';
    row.getCell('ledgerAccount').numFmt = '@';
    row.getCell('amountCZK').numFmt = '#,##0.00';
    row.getCell('vatAmountCZK').numFmt = '#,##0.00';
    const link = inv.driveUrl;
    if (link) row.getCell('pdfLink').value = { text: link, hyperlink: link };
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
    // Non-fatal: still return the file for download; report the Drive problem.
    driveError = err instanceof Error ? err.message : 'Drive upload failed';
    console.error('Statements export Drive upload failed:', err);
  }

  // Return the workbook bytes (for browser download) + Drive result in headers.
  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': MIME,
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'X-Drive-Url': driveUrl,
      'X-Drive-Error': driveError,
      'X-Invoice-Count': String(invoices.length),
    },
  });
}
