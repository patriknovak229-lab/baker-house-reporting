import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { requireRole } from '@/utils/authGuard';
import { readAllSupplierInvoices } from '@/utils/supplierInvoicesStore';

const SUPPORTED_EXTENSIONS = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif', '.webp']);

function mimeForExt(ext: string): string {
  switch (ext) {
    case '.pdf':  return 'application/pdf';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png':  return 'image/png';
    case '.heic': return 'image/heic';
    case '.heif': return 'image/heif';
    case '.webp': return 'image/webp';
    default:      return 'application/octet-stream';
  }
}

export async function POST() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const folderPath = process.env.ICLOUD_INVOICE_FOLDER;
  if (!folderPath) {
    return NextResponse.json({ error: 'ICLOUD_INVOICE_FOLDER not configured' }, { status: 503 });
  }

  // Resolve ~ to the actual home directory
  const resolvedFolder = folderPath.startsWith('~/')
    ? path.join(process.env.HOME ?? '/tmp', folderPath.slice(2))
    : folderPath;

  // Check the folder exists and is readable
  try {
    await fs.access(resolvedFolder);
  } catch {
    return NextResponse.json(
      { error: `iCloud folder not accessible: ${resolvedFolder}` },
      { status: 503 },
    );
  }

  // Load already-imported iCloud filenames to avoid duplicates
  const existing = await readAllSupplierInvoices();
  const importedFileNames = new Set(
    existing.map((inv) => inv.icloudFileName).filter(Boolean),
  );

  // Read directory (non-recursive — just the top-level folder)
  const entries = await fs.readdir(resolvedFolder, { withFileTypes: true });
  const fileEntries = entries.filter((e) => {
    if (!e.isFile()) return false;
    const ext = path.extname(e.name).toLowerCase();
    return SUPPORTED_EXTENSIONS.has(ext);
  });

  const newEntries = fileEntries.filter((e) => !importedFileNames.has(e.name));

  const files: Array<{
    fileName: string;
    fileSize: number;
    mimeType: string;
    data: string; // base64url
  }> = [];

  for (const entry of newEntries) {
    const filePath = path.join(resolvedFolder, entry.name);
    try {
      const buf = await fs.readFile(filePath);
      const ext = path.extname(entry.name).toLowerCase();
      // Encode as base64url (same format the client's base64UrlToFile expects)
      const data = buf
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');

      files.push({
        fileName: entry.name,
        fileSize: buf.length,
        mimeType: mimeForExt(ext),
        data,
      });
    } catch {
      // Skip files that can't be read (e.g. still downloading from iCloud)
    }
  }

  return NextResponse.json({ files });
}
