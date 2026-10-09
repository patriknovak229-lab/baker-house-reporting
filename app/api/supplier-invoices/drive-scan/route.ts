import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { auth } from '@/auth';
import { requireRole } from '@/utils/authGuard';
import { Redis } from '@upstash/redis';
import { getOrCreateInvoiceFolder } from '@/utils/driveInvoice';
import { readAllSupplierInvoices } from '@/utils/supplierInvoicesStore';
import { readDriveScanSkipList } from '@/data-access/driveScanSkip';

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const SUPPORTED_EXT = new Set(['pdf', 'jpg', 'jpeg', 'png', 'heic', 'heif', 'webp']);
/** Subfolders inside the inbox that are NOT part of the scannable set */
const SKIP_FOLDERS = new Set(['_processed', 'old', '_duplicates']);
/** Cap per scan so a huge backlog can't blow the response up */
const MAX_FILES = 150;

function extOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}
function mimeForExt(ext: string): string {
  switch (ext) {
    case 'pdf':  return 'application/pdf';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png':  return 'image/png';
    case 'heic': return 'image/heic';
    case 'heif': return 'image/heif';
    case 'webp': return 'image/webp';
    default:     return 'application/octet-stream';
  }
}

export async function POST() {
  const guard = await requireRole(['admin']);
  if ('error' in guard) return guard.error;

  const session = await auth();
  const refreshToken = (session as unknown as Record<string, unknown>)?.refreshToken as string | undefined;
  if (!refreshToken) {
    return NextResponse.json({ error: 'No Google refresh token in session — sign out and back in.' }, { status: 401 });
  }

  const oauth2 = new google.auth.OAuth2(process.env.AUTH_GOOGLE_ID, process.env.AUTH_GOOGLE_SECRET);
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { token: freshToken } = await oauth2.getAccessToken();
  if (!freshToken) {
    return NextResponse.json({ error: 'Could not refresh Google token.' }, { status: 401 });
  }
  oauth2.setCredentials({ access_token: freshToken });
  const drive = google.drive({ version: 'v3', auth: oauth2 });

  // Already-imported Drive file ids (named archive copy OR the original source file)
  const invoices = await readAllSupplierInvoices();
  const seen = new Set<string>();
  for (const inv of invoices) {
    if (inv.driveFileId) seen.add(inv.driveFileId);
    if (inv.driveSourceFileId) seen.add(inv.driveSourceFileId);
  }
  // …plus PDFs of invoices deliberately removed from the ledger
  for (const e of await readDriveScanSkipList()) seen.add(e.fileId);

  const rootId = await getOrCreateInvoiceFolder(drive, redis);

  // ── Walk the inbox tree, skipping _processed / OLD / _duplicates ──────────
  const files: Array<{ fileName: string; fileSize: number; mimeType: string; driveFileId: string }> = [];
  const folderQueue: string[] = [rootId];
  const visited = new Set<string>();

  while (folderQueue.length > 0 && files.length < MAX_FILES) {
    const folderId = folderQueue.shift()!;
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    let pageToken: string | undefined;
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'nextPageToken, files(id,name,mimeType,size)',
        spaces: 'drive',
        pageSize: 200,
        pageToken,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      for (const f of res.data.files ?? []) {
        if (!f.id || !f.name) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') {
          if (!SKIP_FOLDERS.has(f.name.toLowerCase())) folderQueue.push(f.id);
          continue;
        }
        if (seen.has(f.id)) continue;                       // already imported
        if (!SUPPORTED_EXT.has(extOf(f.name))) continue;    // skip non-invoice formats
        files.push({
          fileName: f.name,
          fileSize: Number(f.size ?? 0),
          mimeType: f.mimeType || mimeForExt(extOf(f.name)),
          driveFileId: f.id,
        });
        if (files.length >= MAX_FILES) break;
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken && files.length < MAX_FILES);
  }

  // ── Download each new file as base64url (same shape the client expects) ───
  const out: Array<{ fileName: string; fileSize: number; mimeType: string; driveFileId: string; data: string }> = [];
  for (const f of files) {
    try {
      const dl = await drive.files.get(
        { fileId: f.driveFileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      );
      const buf = Buffer.from(dl.data as ArrayBuffer);
      const data = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      out.push({ ...f, fileSize: buf.length, data });
    } catch {
      // Skip files that fail to download (permissions, still-uploading, Google-native docs)
    }
  }

  return NextResponse.json({ files: out });
}
