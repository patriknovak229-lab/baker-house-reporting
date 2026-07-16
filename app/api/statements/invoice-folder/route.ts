import { NextRequest, NextResponse } from 'next/server';
import { Redis } from '@upstash/redis';
import { google } from 'googleapis';
import { requireRole } from '@/utils/authGuard';
import { auth } from '@/auth';
import type { SupplierInvoice } from '@/types/supplierInvoice';
import type { RevenueInvoice } from '@/types/revenueInvoice';
import {
  getOrCreateInvoiceFolder,
  getOrCreateSubfolder,
  listFolderFileNames,
  copyFileToFolder,
  parseDriveFileId,
  invoiceFileName,
} from '@/utils/driveInvoice';

// Copying can involve a few hundred small Drive calls — give it headroom.
export const maxDuration = 60;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

/** Accrual period key — matches the P&L / XLSX export (prefer DUZP / taxable-supply date). */
function costDate(inv: SupplierInvoice): string {
  return inv.duzpDate || inv.invoiceDate;
}

/** Run an async worker over items with a fixed concurrency. */
async function runPool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

interface Item {
  fileId: string | null;
  name: string;
  label: string;
}

/**
 * Build (or refresh) the per-export subfolder of invoice PDFs inside the shared
 * "Baker House - Faktury" folder, named `Statements_<from>_<to>`, so the accountant
 * can download every invoice for a period as one Drive folder (native zip download).
 * Copies (never moves) so the flat archive and existing pdfLinks stay intact; idempotent.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireRole(['admin', 'accountant']);
  if ('error' in authResult) return authResult.error;

  const { searchParams } = new URL(req.url);
  const from = searchParams.get('from');
  const to   = searchParams.get('to');
  if (!from || !to) {
    return NextResponse.json({ error: 'from and to query params are required (YYYY-MM-DD)' }, { status: 400 });
  }

  const [rawSupplier, rawRevenue] = await Promise.all([
    redis.get<SupplierInvoice[]>('baker:supplier-invoices'),
    redis.get<RevenueInvoice[]>('baker:revenue-invoices'),
  ]);
  const supplierInvoices = rawSupplier ?? [];
  const revenueInvoices  = rawRevenue  ?? [];

  // Which invoices belong to this export period? (mirror the XLSX export's Records logic)
  const items: Item[] = [];
  for (const inv of supplierInvoices) {
    const d = costDate(inv);
    if (d < from || d > to) continue;
    items.push({
      fileId: inv.driveFileId || parseDriveFileId(inv.driveUrl),
      name: invoiceFileName(inv.invoiceDate, inv.supplierName, inv.invoiceNumber, inv.amountCZK),
      label: `${inv.supplierName} · ${inv.invoiceNumber}`,
    });
  }
  for (const inv of revenueInvoices) {
    if (inv.invoiceDate < from || inv.invoiceDate > to || inv.category === 'mistake') continue;
    const who = inv.guestName || inv.clientName || 'revenue';
    items.push({
      fileId: inv.driveFileId || parseDriveFileId(inv.driveUrl),
      name: invoiceFileName(inv.invoiceDate, who, inv.invoiceNumber, inv.amountCZK),
      label: `${who} · ${inv.invoiceNumber}`,
    });
  }

  const total    = items.length;
  const missing  = items.filter((it) => !it.fileId);
  const copyable = items.filter((it): it is Item & { fileId: string } => !!it.fileId);

  try {
    // Drive client from the signed-in admin's refresh token (same path as the XLSX export)
    const session = await auth();
    const refreshToken = (session as unknown as Record<string, unknown>)?.refreshToken as string | undefined;
    if (!refreshToken) throw new Error('No Google refresh token in session — sign out and back in.');

    const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
    oauth2.setCredentials({ refresh_token: refreshToken });
    const { token } = await oauth2.getAccessToken();
    if (!token) throw new Error('Could not refresh Google token.');
    oauth2.setCredentials({ access_token: token });
    const drive = google.drive({ version: 'v3', auth: oauth2 });

    const parentId = await getOrCreateInvoiceFolder(drive, redis);
    const sub      = await getOrCreateSubfolder(drive, parentId, `Statements_${from}_${to}`);
    const seen     = await listFolderFileNames(drive, sub.id); // idempotency: skip names already there

    let copied  = 0;
    let skipped = 0;
    const failed: string[] = [];

    await runPool(copyable, 6, async (it) => {
      if (seen.has(it.name)) { skipped++; return; }
      seen.add(it.name); // reserve the name so duplicate-named items in this run don't double-copy
      try {
        await copyFileToFolder(drive, it.fileId, it.name, sub.id);
        copied++;
      } catch {
        failed.push(it.label);
      }
    });

    return NextResponse.json({
      folderUrl:  sub.webViewLink,
      folderName: `Statements_${from}_${to}`,
      total,
      copied,
      skipped,
      failed:     failed.length,
      missingPdf: missing.length,
      missingList: missing.map((m) => m.label).slice(0, 50),
      failedList:  failed.slice(0, 50),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Drive folder build failed' },
      { status: 502 },
    );
  }
}
