import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { requireRole } from '@/utils/authGuard';

/**
 * POST /api/supplier-invoices/icloud-archive  { fileName, year? }
 *
 * Moves a successfully-imported receipt out of the iCloud scan folder into
 * `<folder>/_processed/<year>/`, keeping the top-level folder a clean "inbox".
 * The scan is non-recursive, so archived files are automatically excluded from
 * future scans.
 *
 * Local-only (reads the same on-disk ICLOUD_INVOICE_FOLDER as icloud-scan) and
 * best-effort: any failure is non-fatal — the invoice is already saved, and a
 * file left in place simply won't re-import (icloud-scan dedupes by filename).
 *
 * NOTE: deleting an invoice later does NOT move its file back out of _processed
 * (accepted trade-off — the rare "deleted by mistake / bad extraction" case is
 * handled by retrieving the file manually).
 */
export async function POST(request: Request) {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const folderPath = process.env.ICLOUD_INVOICE_FOLDER;
  // Not configured (e.g. running on Vercel, not locally) → archiving is a no-op.
  if (!folderPath) return NextResponse.json({ ok: false, reason: 'ICLOUD_INVOICE_FOLDER not configured' });

  const { fileName, year } = (await request.json()) as { fileName?: string; year?: string };
  if (!fileName) return NextResponse.json({ error: 'fileName is required' }, { status: 400 });

  const baseFolder = folderPath.startsWith('~/')
    ? path.join(process.env.HOME ?? '/tmp', folderPath.slice(2))
    : folderPath;

  // Strip any directory components from the supplied name (path-traversal guard)
  const safeName = path.basename(fileName);
  const yearSeg = /^\d{4}$/.test(year ?? '') ? year! : String(new Date().getFullYear());

  const src = path.join(baseFolder, safeName);
  const destDir = path.join(baseFolder, '_processed', yearSeg);
  let dest = path.join(destDir, safeName);

  try {
    // Source gone (already archived, or never on disk) → nothing to do.
    try { await fs.access(src); }
    catch { return NextResponse.json({ ok: true, skipped: 'source not found' }); }

    await fs.mkdir(destDir, { recursive: true });

    // Don't clobber an existing archived file with the same name
    try {
      await fs.access(dest);
      const ext = path.extname(safeName);
      dest = path.join(destDir, `${safeName.slice(0, safeName.length - ext.length)}-${Date.now()}${ext}`);
    } catch { /* destination is free */ }

    await fs.rename(src, dest);
    return NextResponse.json({ ok: true, movedTo: path.relative(baseFolder, dest) });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'move failed' });
  }
}
